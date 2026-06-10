import { randomUUID } from "node:crypto";
import type { Collection, Filter } from "mongodb";
import type { Belief, ExpertiseDepth, OriginContext } from "../types/belief.js";
import type { InternalLLMCaller } from "../providers/types.js";
import type { PersonaCache } from "../context/personaCache.js";

const ACTIVE_FILTER = { resolved_at: null, superseded_by: null };

const DEDUP_COMPACTION_PROMPT =
  `You identify semantically duplicate beliefs and flag contradictions within a scope.

You will receive a JSON array of belief objects. Return only a JSON object in this exact shape:
{ "merges": [...], "contradictions": [...], "no_action_ids": [...] }

Each merge object:
{
  "keep_id": "<id of belief whose structure to base the merge on>",
  "retire_ids": ["<ids of beliefs being retired — never include keep_id here>"],
  "merged_content": "<most precise, complete expression of the shared fact>",
  "merged_canonical_name": "<snake_case>",
  "merged_aliases": ["<all aliases from all merged beliefs plus retired canonical names>"],
  "compaction_note": "<one sentence: what was merged and why>",
  "belief_type": "<type field copied from keep belief>"
}

Each contradiction object:
{
  "belief_ids": ["<id_a>", "<id_b>"],
  "reason": "<one sentence: why these beliefs conflict>"
}

Rules:
- Only merge when you are highly confident two beliefs express the same fact or preference.
- Flag a contradiction when two beliefs assert incompatible things about the same subject.
  They do NOT need to share a canonical_name — look at semantic content.
- When uncertain about merge, leave beliefs separate. Conservative is always correct here.
- When uncertain about contradiction, do not flag. Only flag clear incompatibilities.
- merged_aliases must include the canonical names of all retired beliefs for search continuity.
- List every unmerged AND non-contradicted belief id in no_action_ids.
- Return valid JSON only. No prose outside the JSON object.`.trim();

const PREFERENCE_COMPACTION_PROMPT =
  `You identify semantically duplicate preference beliefs, flag contradictions, and merge
duplicates into a single canonical belief. These beliefs shape how future LLM sessions
interact with this user, so the merged result must be maximally actionable — not just compact.

You will receive a JSON array of preference belief objects. Return only a JSON object:
{ "merges": [...], "contradictions": [...], "no_action_ids": [...] }

Each merge object:
{
  "keep_id": "<id of the belief whose structure to base the merge on>",
  "retire_ids": ["<ids being retired — never include keep_id>"],
  "merged_content": "<the most complete, session-actionable characterization of this preference>",
  "merged_canonical_name": "<snake_case>",
  "merged_aliases": ["<all aliases from all merged beliefs plus retired canonical names>"],
  "compaction_note": "<one sentence: what was merged and why>",
  "belief_type": "preference"
}

Each contradiction object:
{
  "belief_ids": ["<id_a>", "<id_b>"],
  "reason": "<one sentence: why these preferences conflict>"
}

Rules:
- Only merge beliefs that express the same underlying preference.
- Flag a contradiction when two preferences assert incompatible approaches to the same concern.
- merged_content must read as a direct instruction a model can act on immediately.
- Preserve nuance: if one belief adds a condition the other lacks, include it.
- When uncertain about contradiction, do not flag. Only flag clear incompatibilities.
- merged_aliases must include all retired canonical_names for search continuity.
- List every unmerged AND non-contradicted belief id in no_action_ids.
- Return valid JSON only.`.trim();

const EXPERTISE_SYNTHESIS_PROMPT =
  `You analyze accumulated expertise signals for a user and produce structured assessments
per domain. Domains follow a hierarchical naming convention: "javascript" is a parent domain,
"javascript/react" and "javascript/bundlers" are subdomains. Assess each leaf domain
independently, then produce a rolled-up parent assessment only if the leaf assessments
collectively justify one.

You will receive a JSON array of expertise belief objects. Return only a JSON object:
{ "assessments": [...], "retire_ids": [...] }

Each assessment:
{
  "domain": "<e.g. 'postgres', 'javascript', 'javascript/react'>",
  "depth": "learning" | "working" | "deep" | "expert",
  "evidence_count": <number of source beliefs supporting this assessment>,
  "canonical_name": "<domain with slashes replaced by underscores>_expertise",
  "content": "<one sentence: what they know and at what depth>",
  "why_it_matters": "<what the model should assume or skip explaining for this domain>",
  "scope": ["user:universal"],
  "confidence": <0.0–1.0>
}

Depth calibration:
- learning:  actively building fundamentals; explain concepts, show reasoning
- working:   productive but not authoritative; skip basics, don't skip trade-offs
- deep:      corrects the model, sets conventions; treat as informed peer
- expert:    defines the field for themselves; defer on opinion, engage as equal

Subdomain handling:
- Assess each subdomain (e.g. javascript/react) independently based on its own signals.
- Produce a parent rollup (e.g. javascript) only when 2+ subdomains are assessed and their
  depths are consistent enough to generalize. A parent depth is the floor of its subdomains.
- Never invent a parent rollup from a single subdomain signal.

retire_ids: list every source belief id that is superseded by an assessment.
Return valid JSON only. No prose outside the JSON object.`.trim();

function buildDedupPrompt(includeOrg: boolean): string {
  const parts: string[] = [];

  parts.push(
    `You identify semantically duplicate beliefs and flag contradictions within a scope.`,
    ``
  );

  if (includeOrg) {
    parts.push(
      `You will receive:`,
      `1. A JSON array of belief objects.`,
      `2. (Conditionally) An "org_standards" block — organizational policies that are absolute constraints.`,
      `   Any belief whose content contradicts org standards must be treated as a contradiction,`,
      `   regardless of whether it conflicts with another belief.`
    );
  } else {
    parts.push(`You will receive a JSON array of belief objects.`);
  }

  parts.push(
    ``,
    `Return only a JSON object in this exact shape:`,
    `{ "merges": [...], "contradictions": [...], "no_action_ids": [...] }`,
    ``,
    // ... merge template identical in both modes ...
    ``,
    `Each contradiction object:`,
    `{`,
    includeOrg
      ? `  "belief_ids": ["<id_a>", "<id_b_or_'org'>"],`
      : `  "belief_ids": ["<id_a>", "<id_b>"],`,
    `  "reason": "<one sentence: why these beliefs conflict>"`,
    `}`,
    ``,
    `Rules:`,
    `- Only merge when you are highly confident two beliefs express the same fact or preference.`,
    `- Flag a contradiction when two beliefs assert incompatible things about the same subject.`,
    `- When uncertain about merge, leave beliefs separate. Conservative is always correct here.`,
    `- When uncertain about contradiction, do not flag. Only flag clear incompatibilities.`,
    `- merged_aliases must include the canonical names of all retired beliefs for search continuity.`,
    `- List every unmerged AND non-contradicted belief id in no_action_ids.`,
    `- Return valid JSON only. No prose outside the JSON object.`
  );

  if (includeOrg) {
    parts.push(
      `- If a belief contradicts org_standards, flag it as a contradiction with belief_ids: ["<id>", "org"].`,
      `- merged_content must never contradict org_standards.`
    );
  }

  return parts.join("\n");
}

interface CompactionTypeConfig {
  threshold: number;
  cooldownMs: number;
  deepScanIntervalMs: number;
  prompt: string;
  invalidatesPersona: boolean;
  isExpertiseSynthesis: boolean;
}

const TYPE_CONFIGS: Record<string, CompactionTypeConfig> = {
  preference: {
    threshold: 15,
    cooldownMs: 12 * 60 * 60 * 1000,
    deepScanIntervalMs: 7 * 24 * 60 * 60 * 1000,
    prompt: PREFERENCE_COMPACTION_PROMPT,
    invalidatesPersona: true,
    isExpertiseSynthesis: false
  },
  expertise: {
    threshold: 8,
    cooldownMs: 24 * 60 * 60 * 1000,
    deepScanIntervalMs: 7 * 24 * 60 * 60 * 1000,
    prompt: EXPERTISE_SYNTHESIS_PROMPT,
    invalidatesPersona: true,
    isExpertiseSynthesis: true
  },
  entity: {
    threshold: 25,
    cooldownMs: 24 * 60 * 60 * 1000,
    deepScanIntervalMs: 7 * 24 * 60 * 60 * 1000,
    prompt: DEDUP_COMPACTION_PROMPT,
    invalidatesPersona: false,
    isExpertiseSynthesis: false
  },
  decision: {
    threshold: 20,
    cooldownMs: 24 * 60 * 60 * 1000,
    deepScanIntervalMs: 7 * 24 * 60 * 60 * 1000,
    prompt: DEDUP_COMPACTION_PROMPT,
    invalidatesPersona: false,
    isExpertiseSynthesis: false
  }
};

const INFERRED_PROMOTION_THRESHOLD = 3;

interface CompactionMerge {
  keep_id: string;
  retire_ids: string[];
  merged_content: string;
  merged_canonical_name: string;
  merged_aliases: string[];
  compaction_note: string;
  belief_type: string;
}

interface DetectedContradiction {
  belief_ids: [string, string];
  reason: string;
}

interface ExpertiseAssessment {
  domain: string;
  depth: ExpertiseDepth;
  evidence_count: number;
  canonical_name: string;
  content: string;
  why_it_matters: string;
  scope: string[];
  confidence: number;
}

export interface BeliefContradiction {
  _id: string;
  user_id: string;
  agent_id: string | null;
  scope: string;
  belief_ids: [string, string];
  reason: string;
  status: "pending" | "resolved";
  detected_at: Date;
  resolved_at: Date | null;
  belief_origins?: [OriginContext | null, OriginContext | null];
}

export interface CompactionLogEntry {
  _id: string;
  user_id: string;
  scope: string;
  belief_type: string;
  ran_at: Date;
  merged_count: number;
  scan_depth?: "shallow" | "deep";
}

export interface CompactionRunnerOptions {
  cooldownMs?: number;
}

/**
 * Represents a unique scope + agent_id partition that qualifies for compaction.
 */
interface QualifyingPartition {
  scope: string;
  agentId: string | null;
  depth: "shallow" | "deep";
  threshold: number;
}

export class BeliefCompactionRunner {
  constructor(
    private readonly beliefs: Collection<Belief>,
    private readonly compactionLog: Collection<CompactionLogEntry>,
    private readonly contradictions: Collection<BeliefContradiction>,
    private readonly resolveAdapter: () => InternalLLMCaller,
    private readonly modelId: string | null,
    private readonly personaCache: PersonaCache,
    private readonly personaSummary: {
      regenerate(userId: string): Promise<void>;
    },
    private readonly options: CompactionRunnerOptions = {}
  ) {}

  async run(userId: string, opts?: { orgSummary?: string }): Promise<void> {
    const orgSummary = opts?.orgSummary;

    for (const [beliefType, config] of Object.entries(TYPE_CONFIGS)) {
      const qualifyingPartitions = await this.findQualifyingPartitions(
        userId,
        beliefType,
        config
      );
      for (const partition of qualifyingPartitions) {
        await this.compact(
          userId,
          partition.scope,
          partition.agentId,
          beliefType,
          config,
          partition.depth,
          partition.threshold,
          orgSummary
        ).catch((err: unknown) => {
          console.error(
            `[compaction] failed user=${userId} scope=${partition.scope} agent=${partition.agentId} type=${beliefType}:`,
            err
          );
        });
      }
    }
  }

  /**
   * Finds scope + agent_id partitions that have accumulated enough beliefs
   * to warrant compaction and are not on cooldown.
   */
  private async findQualifyingPartitions(
    userId: string,
    beliefType: string,
    config: CompactionTypeConfig
  ): Promise<QualifyingPartition[]> {
    const typeFilter =
      beliefType === "expertise"
        ? { type: "preference", subtype: "expertise" }
        : {
            type: beliefType,
            $or: [{ subtype: null }, { subtype: { $exists: false } }]
          };

    const cooldownMs = this.options.cooldownMs ?? config.cooldownMs;

    const taxWindow = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const taxHotScopes = await this.beliefs.db
      .collection("orientation_tax_events")
      .distinct("scopes", {
        user_id: userId,
        created_at: { $gte: taxWindow }
      })
      .catch(() => [] as string[]);

    const taxHotSet = new Set(taxHotScopes);

    const reducedThreshold =
      taxHotSet.size > 0
        ? Math.floor(config.threshold * 0.6)
        : config.threshold;

    const [countsByPartition, recentRuns] = await Promise.all([
      this.beliefs
        .aggregate<{
          _id: { scope: string; agent_id: string | null };
          count: number;
        }>([
          { $match: { user_id: userId, ...ACTIVE_FILTER, ...typeFilter } },
          { $unwind: "$scope" },
          {
            $group: {
              _id: { scope: "$scope", agent_id: "$agent_id" },
              count: { $sum: 1 }
            }
          },
          { $match: { count: { $gte: reducedThreshold } } }
        ])
        .toArray(),
      this.compactionLog
        .find({
          user_id: userId,
          belief_type: beliefType,
          ran_at: { $gte: new Date(Date.now() - cooldownMs) }
        })
        .toArray()
    ]);

    if (countsByPartition.length === 0) return [];

    const latestByScope = new Map<string, CompactionLogEntry>();
    const latestDeepByScope = new Map<string, CompactionLogEntry>();
    for (const log of recentRuns) {
      if (!latestByScope.has(log.scope)) {
        latestByScope.set(log.scope, log);
      }
      if (log.scan_depth === "deep" && !latestDeepByScope.has(log.scope)) {
        latestDeepByScope.set(log.scope, log);
      }
    }

    const now = Date.now();
    const partitions: QualifyingPartition[] = [];

    for (const p of countsByPartition) {
      const scope = p._id.scope;
      const isTaxHot = taxHotSet.has(scope);
      const effectiveThreshold = isTaxHot ? reducedThreshold : config.threshold;

      if (p.count < effectiveThreshold) continue;

      const lastAny = latestByScope.get(scope);
      const lastDeep = latestDeepByScope.get(scope);

      const lastAnyAt = lastAny?.ran_at.getTime() ?? 0;
      let lastDeepAt = lastDeep?.ran_at.getTime() ?? 0;

      // Legacy log entries without scan_depth were all full-scope runs.
      // Treat them as deep so they don't immediately re-trigger.
      if (lastDeepAt === 0 && lastAny && lastAny.scan_depth === undefined) {
        lastDeepAt = lastAnyAt;
      }

      if (now - lastDeepAt >= config.deepScanIntervalMs) {
        partitions.push({
          scope,
          agentId: p._id.agent_id ?? null,
          depth: "deep",
          threshold: effectiveThreshold
        });
        continue;
      }

      if (now - lastAnyAt >= cooldownMs) {
        partitions.push({
          scope,
          agentId: p._id.agent_id ?? null,
          depth: "shallow",
          threshold: effectiveThreshold
        });
      }
    }

    return partitions;
  }

  private async compact(
    userId: string,
    scope: string,
    agentId: string | null,
    beliefType: string,
    config: CompactionTypeConfig,
    depth: "shallow" | "deep",
    threshold: number,
    orgSummary?: string
  ): Promise<void> {
    const typeFilter =
      beliefType === "expertise"
        ? { type: "preference", subtype: "expertise" }
        : {
            type: beliefType,
            $or: [{ subtype: null }, { subtype: { $exists: false } }]
          };

    const agentFilter: Record<string, unknown> = agentId
      ? { $or: [{ agent_id: agentId }, { agent_id: null }] }
      : { agent_id: null };

    const baseFilter: Record<string, unknown> = {
      user_id: userId,
      scope: { $in: [scope] },
      ...ACTIVE_FILTER
    };

    const typeOr = (typeFilter as Record<string, unknown>).$or;
    const agentOr = (agentFilter as Record<string, unknown>).$or;

    if (typeOr && agentOr) {
      const { $or: _, ...typeRest } = typeFilter as Record<string, unknown>;
      Object.assign(baseFilter, typeRest);
      baseFilter.$and = [{ $or: typeOr }, { $or: agentOr }];
    } else if (typeOr) {
      Object.assign(baseFilter, typeFilter);
      Object.assign(baseFilter, agentFilter);
    } else if (agentOr) {
      Object.assign(baseFilter, typeFilter);
      baseFilter.$or = agentOr;
    } else {
      Object.assign(baseFilter, typeFilter);
      Object.assign(baseFilter, agentFilter);
    }

    const scopeBeliefs = await this.beliefs
      .find(baseFilter as Filter<Belief>)
      .toArray();

    if (scopeBeliefs.length < threshold) return;

    if (config.isExpertiseSynthesis) {
      await this.compactExpertise(userId, scope, scopeBeliefs, config);
    } else {
      await this.compactDedup(
        userId,
        scope,
        agentId,
        scopeBeliefs,
        config,
        beliefType,
        depth,
        orgSummary
      );
    }
  }

  /**
   * Shallow compaction gate with transitive (2-hop+) clustering.
   *
   * If belief A shares a term with B, and B shares a term with C, then
   * A, B, and C all enter the same cluster even when A and C share no
   * direct term overlap. This prevents the LLM from missing merge
   * candidates that are lexically bridged through a middle belief.
   */
  private clusterByTermOverlap(beliefs: Belief[]): Belief[] {
    if (beliefs.length === 0) return [];

    const indexById = new Map<string, number>();
    beliefs.forEach((b, i) => indexById.set(b._id, i));

    const parent = beliefs.map((_, i) => i);
    const rank = beliefs.map(() => 0);

    const find = (x: number): number => {
      if (parent[x] !== x) parent[x] = find(parent[x]);
      return parent[x];
    };

    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      if (rank[ra] < rank[rb]) {
        parent[ra] = rb;
      } else if (rank[ra] > rank[rb]) {
        parent[rb] = ra;
      } else {
        parent[rb] = ra;
        rank[ra]++;
      }
    };

    const termToFirstIndex = new Map<string, number>();

    for (let i = 0; i < beliefs.length; i++) {
      const belief = beliefs[i];
      const terms = new Set<string>();

      const addTerms = (s: string) => {
        s.toLowerCase()
          .split(/[_\s\-.]+/)
          .filter((t) => t.length > 1)
          .forEach((t) => terms.add(t));
      };

      addTerms(belief.canonical_name);
      for (const alias of belief.aliases) {
        addTerms(alias);
      }

      for (const term of terms) {
        if (termToFirstIndex.has(term)) {
          union(i, termToFirstIndex.get(term)!);
        } else {
          termToFirstIndex.set(term, i);
        }
      }
    }

    const components = new Map<number, Belief[]>();
    for (let i = 0; i < beliefs.length; i++) {
      const root = find(i);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(beliefs[i]);
    }

    const clustered: Belief[] = [];
    for (const group of components.values()) {
      if (group.length >= 2) {
        clustered.push(...group);
      }
    }

    return clustered;
  }

  private async compactDedup(
    userId: string,
    scope: string,
    agentId: string | null,
    beliefs: Belief[],
    config: CompactionTypeConfig,
    beliefType: string,
    depth: "shallow" | "deep",
    orgSummary?: string
  ): Promise<void> {
    let candidates = beliefs.filter((b) => !b.origin_context?.active_file);

    if (depth === "shallow") {
      candidates = this.clusterByTermOverlap(candidates);
      if (candidates.length < 2) {
        await this.logRun(userId, scope, beliefType, 0, depth);
        return;
      }
    }

    const useOrg = !!orgSummary;
    const prompt = buildDedupPrompt(useOrg);

    const { merges, contradictions } = await this.callDedupLLM(
      candidates,
      prompt,
      orgSummary
    );

    await this.logRun(userId, scope, beliefType, merges.length, depth);

    if (merges.length > 0) {
      await this.applyDedupMerges(userId, merges);
    }

    const orgViolations = contradictions.filter((c) =>
      c.belief_ids.includes("org")
    );
    const regularContradictions = contradictions.filter(
      (c) => !c.belief_ids.includes("org")
    );

    if (regularContradictions.length > 0) {
      await this.persistContradictions(
        userId,
        scope,
        agentId,
        regularContradictions
      );
    }

    if (orgViolations.length > 0) {
      await this.handleOrgViolations(userId, scope, agentId, orgViolations);
    }

    if (config.invalidatesPersona && scope === "user:universal") {
      await this.personaCache.invalidate(userId);
    }
  }

  private async callDedupLLM(
    beliefs: Belief[],
    prompt: string,
    orgSummary?: string
  ): Promise<{
    merges: CompactionMerge[];
    contradictions: DetectedContradiction[];
  }> {
    const payload = orgSummary
      ? {
          beliefs: beliefs.map((b) => ({
            id: b._id,
            type: b.type,
            canonical_name: b.canonical_name,
            content: b.content,
            aliases: b.aliases,
            scope: b.scope,
            visibility: b.visibility ?? null
          })),
          org_standards: orgSummary
        }
      : beliefs.map((b) => ({
          id: b._id,
          type: b.type,
          canonical_name: b.canonical_name,
          content: b.content,
          aliases: b.aliases,
          scope: b.scope
        }));

    const resp = await this.resolveAdapter().call(
      this.modelId ?? "",
      prompt,
      [{ role: "user", content: JSON.stringify(payload) }],
      { temperature: 0.1, max_tokens: 20000 }
    );

    const parsed = JSON.parse(this.extractJson(resp.content)) as {
      merges?: CompactionMerge[];
      contradictions?: DetectedContradiction[];
    };

    return {
      merges: Array.isArray(parsed.merges) ? parsed.merges : [],
      contradictions: Array.isArray(parsed.contradictions)
        ? parsed.contradictions
        : []
    };
  }

  private async persistContradictions(
    userId: string,
    scope: string,
    agentId: string | null,
    contradictions: DetectedContradiction[]
  ): Promise<void> {
    const now = new Date();

    const existingPending = await this.contradictions
      .find({
        user_id: userId,
        scope,
        agent_id: agentId,
        status: "pending"
      })
      .toArray();

    const existingPairs = new Set(
      existingPending.map((c) => [...c.belief_ids].sort().join("|"))
    );

    const novel = contradictions.filter((c) => {
      if (!Array.isArray(c.belief_ids) || c.belief_ids.length !== 2) {
        return false;
      }
      const key = [...c.belief_ids].sort().join("|");
      return !existingPairs.has(key);
    });

    if (novel.length === 0) return;

    const docs: BeliefContradiction[] = novel.map((c) => ({
      _id: randomUUID(),
      user_id: userId,
      agent_id: agentId,
      scope,
      belief_ids: c.belief_ids,
      reason: c.reason,
      status: "pending",
      detected_at: now,
      resolved_at: null
    }));

    await this.contradictions.insertMany(docs);
  }

  private async handleOrgViolations(
    userId: string,
    scope: string,
    agentId: string | null,
    violations: DetectedContradiction[]
  ): Promise<void> {
    const now = new Date();

    const existingPending = await this.contradictions
      .find({
        user_id: userId,
        scope,
        agent_id: agentId,
        status: "pending"
      })
      .toArray();

    const existingPairs = new Set(
      existingPending.map((c) => [...c.belief_ids].sort().join("|"))
    );

    const realIds = new Set<string>();
    for (const v of violations) {
      if (!Array.isArray(v.belief_ids) || v.belief_ids.length !== 2) continue;
      const realId = v.belief_ids.find((id) => id !== "org");
      if (realId) realIds.add(realId);
    }

    const beliefMap = new Map(
      (
        await this.beliefs
          .find({ _id: { $in: [...realIds] }, user_id: userId })
          .toArray()
      ).map((b) => [b._id, b])
    );

    const docs: BeliefContradiction[] = [];
    const toSupersede = new Set<string>();

    for (const v of violations) {
      if (!Array.isArray(v.belief_ids) || v.belief_ids.length !== 2) continue;
      const realId = v.belief_ids.find((id) => id !== "org");
      if (!realId) continue;
      const pairKey = [realId, "org"].sort().join("|");
      if (existingPairs.has(pairKey)) continue;

      docs.push({
        _id: randomUUID(),
        user_id: userId,
        agent_id: agentId,
        scope,
        belief_ids: [realId, "org"] as [string, string],
        reason: v.reason,
        status: "pending",
        detected_at: now,
        resolved_at: null
      });

      const belief = beliefMap.get(realId);
      if (belief && !belief.user_edited) {
        toSupersede.add(realId);
      }
    }

    if (docs.length > 0) {
      await this.contradictions.insertMany(docs);
    }

    for (const bid of toSupersede) {
      await this.beliefs.updateOne(
        { _id: bid, user_id: userId },
        {
          $set: {
            epistemic_status: "superseded",
            superseded_by: "org",
            updated_at: now
          },
          $push: {
            change_log: {
              changed_at: now,
              trigger: "auto-superseded: violates organization standards",
              changed_by_session: null,
              changed_by_turn: null
            }
          }
        }
      );
    }
  }

  private async applyDedupMerges(
    userId: string,
    merges: CompactionMerge[]
  ): Promise<void> {
    const now = new Date();

    for (const merge of merges) {
      const allIds = [merge.keep_id, ...merge.retire_ids];

      const mergeSources = await this.beliefs
        .find({ _id: { $in: allIds }, user_id: userId })
        .toArray();

      const source = mergeSources.find((b) => b._id === merge.keep_id);
      if (!source) continue;

      const totalReinforcements = mergeSources.reduce(
        (sum, b) => sum + (b.reinforcement_count ?? 0),
        0
      );
      const maxLastReinforced = mergeSources.reduce(
        (max, b) => (b.last_reinforced_at > max ? b.last_reinforced_at : max),
        source.last_reinforced_at
      );

      const allInferred = mergeSources.every(
        (b) => b.epistemic_status === "inferred"
      );
      const promotedStatus =
        allInferred && totalReinforcements >= INFERRED_PROMOTION_THRESHOLD
          ? "active"
          : source.epistemic_status;

      const newId = randomUUID();
      const merged: Belief = {
        ...source,
        _id: newId,
        canonical_name: merge.merged_canonical_name,
        content: merge.merged_content,
        aliases: merge.merged_aliases,
        compaction_note: merge.compaction_note,
        epistemic_status: promotedStatus,
        reinforcement_count: totalReinforcements,
        last_reinforced_at: maxLastReinforced,
        superseded_by: null,
        created_at: now,
        updated_at: now,
        change_log: [
          {
            changed_at: now,
            trigger: `compaction: merged from ${allIds.join(", ")}${
              promotedStatus === "active" && allInferred
                ? "; promoted from inferred via combined reinforcement"
                : ""
            }`,
            changed_by_session: null,
            changed_by_turn: null
          }
        ]
      };

      await this.beliefs.insertOne(merged);
      await this.beliefs.updateMany(
        { _id: { $in: allIds }, user_id: userId },
        {
          $set: {
            epistemic_status: "superseded",
            superseded_by: newId,
            updated_at: now
          },
          $push: {
            change_log: {
              changed_at: now,
              trigger: `superseded by compaction: ${newId}`,
              changed_by_session: null,
              changed_by_turn: null
            }
          }
        }
      );
    }
  }

  private async compactExpertise(
    userId: string,
    scope: string,
    beliefs: Belief[],
    _config: CompactionTypeConfig
  ): Promise<void> {
    const { assessments, retireIds } = await this.callExpertiseLLM(beliefs);
    await this.logRun(userId, scope, "expertise", assessments.length, "deep");
    if (assessments.length === 0) return;

    await this.applyExpertiseAssessments(
      userId,
      assessments,
      retireIds,
      beliefs
    );

    if (scope === "user:universal") {
      await this.personaSummary.regenerate(userId);
    }
  }

  private async callExpertiseLLM(beliefs: Belief[]): Promise<{
    assessments: ExpertiseAssessment[];
    retireIds: string[];
  }> {
    const payload = beliefs.map((b) => ({
      id: b._id,
      canonical_name: b.canonical_name,
      content: b.content,
      why_it_matters: b.why_it_matters,
      expertise_domain: b.expertise_domain ?? null,
      expertise_depth: b.expertise_depth ?? null,
      epistemic_status: b.epistemic_status,
      confidence: b.confidence,
      reinforcement_count: b.reinforcement_count,
      scope: b.scope
    }));

    const resp = await this.resolveAdapter().call(
      this.modelId ?? "",
      EXPERTISE_SYNTHESIS_PROMPT,
      [{ role: "user", content: JSON.stringify(payload) }],
      { temperature: 0.1, max_tokens: 5000 }
    );

    const parsed = JSON.parse(this.extractJson(resp.content)) as {
      assessments?: ExpertiseAssessment[];
      retire_ids?: string[];
    };

    return {
      assessments: Array.isArray(parsed.assessments) ? parsed.assessments : [],
      retireIds: Array.isArray(parsed.retire_ids) ? parsed.retire_ids : []
    };
  }

  private async applyExpertiseAssessments(
    userId: string,
    assessments: ExpertiseAssessment[],
    retireIds: string[],
    sourceBeliefsForUser: Belief[]
  ): Promise<void> {
    const now = new Date();
    const sourceIds = sourceBeliefsForUser.map((b) => b._id);

    for (const assessment of assessments) {
      const existing = await this.beliefs.findOne({
        user_id: userId,
        subtype: "expertise",
        expertise_domain: assessment.domain,
        ...ACTIVE_FILTER
      });

      const newId = randomUUID();

      const newBelief: Belief = {
        _id: newId,
        user_id: userId,
        agent_id:
          existing?.agent_id ?? sourceBeliefsForUser[0]?.agent_id ?? null,
        type: "preference",
        subtype: "expertise",
        canonical_name: assessment.canonical_name,
        aliases: existing?.aliases ?? [],
        content: assessment.content,
        why_it_matters: assessment.why_it_matters,
        scope: assessment.scope,
        provenance: existing?.provenance ?? {
          session_id: "",
          turn_id: "",
          extracted_at: now,
          source_model: this.modelId ?? "unknown"
        },
        epistemic_status: "active",
        confidence: assessment.confidence,
        reinforcement_count: assessment.evidence_count,
        last_reinforced_at: now,
        pinned: false,
        user_edited: false,
        superseded_by: null,
        resolved_at: null,
        compaction_note: `Expertise synthesis across ${assessment.evidence_count} signal(s) for domain "${assessment.domain}"`,
        expertise_domain: assessment.domain,
        expertise_depth: assessment.depth,
        expertise_evidence_count: assessment.evidence_count,
        change_log: [
          {
            changed_at: now,
            trigger: existing
              ? `expertise re-synthesis superseding ${existing._id}`
              : `expertise synthesis from ${assessment.evidence_count} source belief(s)`,
            previous_content: existing?.content ?? null,
            previous_epistemic_status: existing?.epistemic_status ?? null,
            previous_confidence: existing?.confidence ?? null,
            changed_by_session: null,
            changed_by_turn: null
          }
        ],
        created_at: now,
        updated_at: now
      };

      await this.beliefs.insertOne(newBelief);

      if (existing) {
        await this.beliefs.updateOne(
          { _id: existing._id, user_id: userId },
          {
            $set: {
              epistemic_status: "superseded",
              superseded_by: newId,
              updated_at: now
            },
            $push: {
              change_log: {
                changed_at: now,
                trigger: `superseded by expertise re-synthesis: ${newId}`,
                changed_by_session: null,
                changed_by_turn: null
              }
            }
          }
        );
      }

      const toRetire = retireIds.filter((id) => sourceIds.includes(id));
      if (toRetire.length > 0) {
        await this.beliefs.updateMany(
          { _id: { $in: toRetire }, user_id: userId },
          {
            $set: {
              epistemic_status: "superseded",
              superseded_by: newId,
              updated_at: now
            },
            $push: {
              change_log: {
                changed_at: now,
                trigger: `retired by expertise synthesis: ${newId}`,
                changed_by_session: null,
                changed_by_turn: null
              }
            }
          }
        );
      }
    }
  }

  private async logRun(
    userId: string,
    scope: string,
    beliefType: string,
    mergedCount: number,
    depth: "shallow" | "deep" = "deep"
  ): Promise<void> {
    await this.compactionLog.insertOne({
      _id: randomUUID(),
      user_id: userId,
      scope,
      belief_type: beliefType,
      ran_at: new Date(),
      merged_count: mergedCount,
      scan_depth: depth
    });
  }

  private extractJson(raw: string): string {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");

    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : stripped;
  }
}
