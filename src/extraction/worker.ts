import type { Collection, Db } from "mongodb";
import type { Belief } from "../types/belief.js";
import type { ExtractionJob } from "../types/job.js";
import { BeliefWriter } from "./beliefWriter.js";
import { BeliefMerger, MergeAction } from "./merger.js";
import { safeParse, attemptRepair } from "./validator.js";
import {
  type ExtractionResult,
  type NewBelief,
  type StyleSignal
} from "./types.js";
import { BeliefsReader } from "../context/beliefsReader.js";
import { randomUUID } from "node:crypto";

export interface ExtractionWorkerDeps {
  db: Db;
  beliefs: Collection<Belief>;
  personaSummary: { regenerate(userId: string): Promise<void> };
}

export interface ExtractionWorkerLike {
  sweep(limit?: number): Promise<number>;
  processById(jobId: string): Promise<void>;
}

export class ExtractionWorker implements ExtractionWorkerLike {
  private readonly db: Db;
  private readonly jobs: Collection<ExtractionJob>;
  private readonly config: Collection;
  private readonly merger: BeliefMerger;
  private readonly writer: BeliefWriter;
  private readonly styleSignals: Collection;
  private readonly reader: BeliefsReader;
  private readonly personaSummary: {
    regenerate(userId: string): Promise<void>;
  };

  constructor(deps: ExtractionWorkerDeps) {
    this.db = deps.db;
    this.jobs = deps.db.collection<ExtractionJob>("jobs");
    this.config = deps.db.collection("config");
    this.styleSignals = deps.db.collection("style_signals");
    this.reader = new BeliefsReader(deps.beliefs);
    this.writer = new BeliefWriter(deps.beliefs);
    this.merger = new BeliefMerger(this.writer, this.reader);
    this.personaSummary = deps.personaSummary;
  }

  async processById(jobId: string): Promise<void> {
    const job = await this.claim(jobId);
    if (!job) return;
    await this.handle(job);
  }

  async sweep(limit = 20): Promise<number> {
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      const job = await this.claimNext();
      if (!job) break;
      await this.handle(job);
      processed++;
    }
    return processed;
  }

  private async claim(jobId: string): Promise<ExtractionJob | null> {
    const now = new Date();
    return this.jobs.findOneAndUpdate(
      { _id: jobId, status: "pending", run_after: { $lte: now } },
      {
        $set: { status: "running", claimed_at: now, updated_at: now },
        $inc: { attempts: 1 }
      },
      { returnDocument: "after" }
    ) as Promise<ExtractionJob | null>;
  }

  private async claimNext(): Promise<ExtractionJob | null> {
    const now = new Date();
    return this.jobs.findOneAndUpdate(
      { status: "pending", run_after: { $lte: now } },
      {
        $set: { status: "running", claimed_at: now, updated_at: now },
        $inc: { attempts: 1 }
      },
      { sort: { created_at: 1 }, returnDocument: "after" }
    ) as Promise<ExtractionJob | null>;
  }

  private async handle(job: ExtractionJob): Promise<void> {
    try {
      let beliefIds: string[] = [];

      if (job.type === "extract_beliefs") {
        beliefIds = await this.extract(job);
      } else if (job.type === "onboarding_extraction") {
        beliefIds = await this.extractOnboarding(job);
      } else if (job.type === "import_extraction") {
        beliefIds = await this.extractImport(job);
      }

      await this.jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "done",
            completed_at: new Date(),
            updated_at: new Date(),
            result_belief_ids: beliefIds
          }
        }
      );
    } catch (e) {
      const failed = job.attempts >= (job.max_attempts ?? 3);
      await this.jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: failed ? "failed" : "pending",
            last_error: (e as Error).message.slice(0, 500),
            run_after: new Date(),
            updated_at: new Date()
          }
        }
      );
    }
  }

  private async extract(job: ExtractionJob): Promise<string[]> {
    const payload = job.payload;
    const parseStatus = payload.parse_status ?? "missing";

    if (parseStatus === "missing") return [];

    let sidecarRaw = payload.sidecar;
    if (!sidecarRaw) return [];

    if (parseStatus === "needs_repair") {
      const repaired = attemptRepair(sidecarRaw);
      if (!repaired) return [];
      sidecarRaw = repaired;
    }

    const { result, error, skippedBeliefs } = safeParse(sidecarRaw);
    if (!result) {
      await this.jobs.updateOne(
        { _id: job._id },
        { $set: { "payload.validation_error": error } }
      );
      if (parseStatus === "parsed") {
        throw new Error(error ?? "failed to parse sidecar");
      }
      return [];
    }
    const enforced =
      payload.extraction_mode === "ide" &&
      payload.workspace_context?.project_scope
        ? enforceIdeScope(result, payload.workspace_context.project_scope)
        : result;

    if (skippedBeliefs.length > 0) {
      await this.jobs.updateOne(
        { _id: job._id },
        { $set: { "payload.skipped_beliefs": skippedBeliefs } }
      );
    }

    const mode = await this.getMemoryMode();

    if (mode === "inject_only") {
      return [];
    }

    if (mode === "curated") {
      return this.persistSuggestions(job, enforced);
    }

    if (mode === "reflective") {
      return [];
    }

    if (enforced.orientation_tax && job.turn_id) {
      this.handleOrientationTax(job, enforced).catch(() => {});
    }

    return this.merge(job, enforced);
  }

  private async extractOnboarding(job: ExtractionJob): Promise<string[]> {
    const payload = job.payload;
    const sidecarRaw = payload.sidecar;

    if (!sidecarRaw) {
      await this.markOnboardingComplete();
      return [];
    }

    const { result } = safeParse(sidecarRaw);
    if (!result) {
      await this.markOnboardingComplete();
      return [];
    }

    const deduped = checkContradictions(result);
    const withUserEdited: ExtractionResult = {
      ...deduped,
      new_beliefs: deduped.new_beliefs.map((nb) => ({
        ...nb,
        user_edited: true
      }))
    };

    const beliefIds = await this.merge(job, withUserEdited);
    await this.markOnboardingComplete();
    await this.personaSummary.regenerate(job.user_id);
    return beliefIds;
  }

  private async extractImport(job: ExtractionJob): Promise<string[]> {
    const sidecarRaw = job.payload.sidecar;
    if (!sidecarRaw) return [];

    const { result } = safeParse(sidecarRaw);
    if (!result) return [];

    const withUserEdited: ExtractionResult = {
      ...result,
      new_beliefs: result.new_beliefs.map((nb) => ({
        ...nb,
        user_edited: true
      }))
    };

    const beliefIds = await this.merge(job, withUserEdited);
    await this.personaSummary.regenerate(job.user_id);
    return beliefIds;
  }

  private async merge(
    job: ExtractionJob,
    result: ExtractionResult
  ): Promise<string[]> {
    const wc = job.payload.workspace_context;

    const report = await this.merger.merge({
      userId: job.user_id,
      sessionId: job.session_id,
      turnId: job.turn_id ?? "",
      sourceModel: job.payload?.source_model ?? "unknown",
      agentId: (job as any).agent_id ?? null,
      teamId: (job as any).team_id ?? undefined,
      orgId: (job as any).org_id ?? undefined,
      result,
      originContext: wc
        ? {
            active_file: wc.active_file,
            language: wc.language_scope,
            project_scope: wc.project_scope
          }
        : null
    });

    if (report.styleSignalsDeferred.length > 0) {
      await this.persistStyleSignals(
        job.user_id,
        job.session_id,
        report.styleSignalsDeferred
      );
    }

    return report.decisions
      .filter((d) => d.action === MergeAction.INSERTED && d.beliefId)
      .map((d) => d.beliefId!);
  }

  /**
   * Upserts style signals into a dedicated collection using an increment
   * pattern. Each distinct signal surface is keyed by (user_id, signal) so
   * that repeated observations accumulate rather than overwrite. The
   * observation_count can later be used to graduate a style signal into a
   * proper belief once sufficient evidence has accumulated.
   */
  private async persistStyleSignals(
    userId: string,
    sessionId: string,
    signals: StyleSignal[]
  ): Promise<void> {
    const now = new Date();
    await Promise.all(
      signals.map((ss) =>
        this.styleSignals.updateOne(
          { user_id: userId, observation: ss.observation },
          {
            $inc: { observation_count: 1 },
            $set: {
              last_seen_at: now,
              last_session_id: sessionId,
              pattern_type: ss.pattern_type,
              confidence: ss.confidence,
              scope: ss.scope ?? []
            },
            $setOnInsert: {
              user_id: userId,
              observation: ss.observation,
              created_at: now
            }
          },
          { upsert: true }
        )
      )
    );
  }

  private async markOnboardingComplete(): Promise<void> {
    await this.config.updateOne(
      { key: "onboarding_status" },
      {
        $set: {
          key: "onboarding_status",
          value: "completed",
          encrypted: false,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  private async getMemoryMode(): Promise<
    "inject_only" | "curated" | "autonomous" | "reflective"
  > {
    const doc = await this.config.findOne({ key: "memory_mode" });
    const val = doc?.value ?? "autonomous";
    if (
      val === "inject_only" ||
      val === "curated" ||
      val === "autonomous" ||
      val === "reflective"
    ) {
      return val;
    }
    return "autonomous";
  }

  private async persistSuggestions(
    job: ExtractionJob,
    result: ExtractionResult
  ): Promise<string[]> {
    const suggestions = this.db.collection("belief_suggestions");
    const ids: string[] = [];
    const now = new Date();

    for (const nb of result.new_beliefs) {
      const id = randomUUID();
      await suggestions.insertOne({
        _id: id as any,
        user_id: job.user_id,
        session_id: job.session_id,
        turn_id: job.turn_id ?? "",
        source_model: job.payload?.source_model ?? "unknown",
        status: "pending",
        proposed: nb,
        created_at: now
      });
      ids.push(id);
    }
    return ids;
  }

  /**
   * Closed-loop orientation tax handler. When the user pays orientation tax,
   * this method:
   * 1. Stamps the injection audit record so aggregation can compute "tax prevented"
   * 2. Reinforces any belief the user just re-explained (accelerated promotion)
   * 3. Extracts surface forms from the user's message as candidate aliases
   *
   * This makes the system self-healing: repeated orientation tax on a topic
   * drives alias enrichment and confidence promotion without prompt changes.
   */
  private async handleOrientationTax(
    job: ExtractionJob,
    result: ExtractionResult
  ): Promise<void> {
    const userId = job.user_id;
    const sessionId = job.session_id;
    const turnId = job.turn_id ?? "";

    // 1. Stamp the audit record
    await this.db
      .collection("injection_audit")
      .updateOne(
        { request_id: turnId, user_id: userId },
        { $set: { orientation_tax: true, orientation_tax_at: new Date() } }
      );

    // 2. Accelerated reinforcement for beliefs the user re-explained
    // If new_beliefs match existing beliefs by canonical name, the merger
    // will reinforce them. But we give an extra reinforcement bump here
    // because orientation tax is stronger evidence than passive repetition.
    for (const nb of result.new_beliefs) {
      const existing = await this.writer.findByCanonical(
        userId,
        nb.canonical_name,
        true,
        nb.scope
      );
      if (existing) {
        // Double reinforce: one from merger, one from tax signal
        await this.writer.reinforce(userId, existing._id, sessionId, turnId);
      }
    }

    // 3. Record orientation tax event per scope for compaction prioritization
    const scopes = new Set(result.new_beliefs.flatMap((nb) => nb.scope));
    if (scopes.size > 0) {
      const now = new Date();
      await this.db.collection("orientation_tax_events").insertOne({
        user_id: userId,
        session_id: sessionId,
        turn_id: turnId,
        scopes: [...scopes],
        created_at: now
      });
    }
  }
}

function checkContradictions(result: ExtractionResult): ExtractionResult {
  const seen = new Map<string, NewBelief>();
  const conflicts = new Set<string>();

  for (const nb of result.new_beliefs) {
    const key = nb.canonical_name.trim().toLowerCase();
    const existing = seen.get(key);
    if (existing && existing.content !== nb.content) {
      conflicts.add(key);
    } else {
      seen.set(key, nb);
    }
  }

  if (conflicts.size === 0) return result;

  return {
    ...result,
    new_beliefs: result.new_beliefs.filter(
      (nb) => !conflicts.has(nb.canonical_name.trim().toLowerCase())
    )
  };
}

/**
 * Replaces any project:* scope on extracted beliefs with the authoritative
 * resolved project scope from the workspace context. This runs in code after
 * the model has emitted its sidecar so the model cannot override it.
 *
 * Rules:
 * - user:universal is always preserved as-is
 * - domain:* scopes are preserved as-is
 * - project:* scopes are replaced with the resolved project scope
 * - beliefs with no scope receive the resolved project scope
 * - beliefs with only domain:* scopes also receive the resolved project scope
 * - beliefs with only user:universal keep only user:universal
 */
function enforceIdeScope(
  result: ExtractionResult,
  resolvedProjectScope: string
): ExtractionResult {
  return {
    ...result,
    new_beliefs: result.new_beliefs.map((nb) => {
      if (nb.scope.length === 1 && nb.scope[0] === "user:universal") {
        return nb;
      }

      const preserved = nb.scope.filter(
        (s) => s === "user:universal" || s.startsWith("domain:")
      );

      const hadProjectScope = nb.scope.some((s) => s.startsWith("project:"));
      const hadNoScope = nb.scope.length === 0;
      const hadOnlyDomainScopes =
        !hadProjectScope &&
        !hadNoScope &&
        nb.scope.every((s) => s.startsWith("domain:"));

      if (hadProjectScope || hadNoScope || hadOnlyDomainScopes) {
        const enforced = [...new Set([...preserved, resolvedProjectScope])];
        return { ...nb, scope: enforced };
      }

      return nb;
    })
  };
}
