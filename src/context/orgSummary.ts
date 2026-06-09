import { createHash } from "node:crypto";
import type { Collection } from "mongodb";
import type { Belief } from "../types/belief.js";
import type { InternalLLMCaller } from "../providers/types.js";

export interface OrgSummaryDoc {
  _id: string;
  summary: string;
  beliefs_hash: string;
  generated_at: Date;
  model: string;
}

export interface OrgSummaryCache {
  get(orgId: string): Promise<OrgSummaryDoc | null>;
  put(doc: OrgSummaryDoc): Promise<void>;
}

export interface OrgSummaryLookup {
  get(orgId: string): Promise<{ summary: string } | null>;
}

const ORG_SUMMARY_PROMPT = `You compose a compact organization standards prelude from structured beliefs.
Output a single JSON object: { "summary": "string" }.

Rules:
- summary: 300-600 chars, one paragraph. Describe durable, governance-like standards.
- Use imperative statements ("Use TypeScript strict mode", "All APIs require tracing").
- Include architectural constraints, language preferences, security rules, and process requirements.
- Omit team working agreements or individual preferences.
- Synthesize duplicate or overlapping beliefs into a single coherent statement.
- No meta-commentary. Output only the JSON object.`;

export interface OrgSummaryGeneratorDeps {
  beliefs: Collection<Belief>;
  cache: OrgSummaryCache;
  adapter: () => InternalLLMCaller;
  modelId: string;
}

export class OrgSummaryMongoCache implements OrgSummaryCache {
  constructor(private readonly col: Collection<OrgSummaryDoc>) {}

  async get(orgId: string): Promise<OrgSummaryDoc | null> {
    return this.col.findOne({ _id: orgId });
  }

  async put(doc: OrgSummaryDoc): Promise<void> {
    await this.col.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }
}

export class OrgSummaryService implements OrgSummaryLookup {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: OrgSummaryGeneratorDeps) {}

  async get(orgId: string): Promise<{ summary: string } | null> {
    const status = await this.ensureFresh(orgId);
    if (
      status === "fresh" ||
      status === "regenerated" ||
      status === "stale-served"
    ) {
      const doc = await this.deps.cache.get(orgId);
      return doc ? { summary: doc.summary } : null;
    }
    return null;
  }

  async ensureFresh(
    orgId: string
  ): Promise<"fresh" | "regenerated" | "stale-served"> {
    const beliefs = await this.loadContributing(orgId);
    const hash = this.hash(beliefs);
    const existing = await this.deps.cache.get(orgId);

    if (existing?.beliefs_hash === hash) return "fresh";
    if (existing) {
      this.regenerate(orgId, beliefs, hash).catch(() => {});
      return "stale-served";
    }
    await this.regenerate(orgId, beliefs, hash);
    return "regenerated";
  }

  async regenerate(
    orgId: string,
    beliefs?: Belief[],
    hash?: string
  ): Promise<void> {
    const existing = this.inFlight.get(orgId);
    if (existing) {
      await existing;
      return;
    }
    const task = this.doRegenerate(orgId, beliefs, hash);
    this.inFlight.set(orgId, task);
    try {
      await task;
    } finally {
      this.inFlight.delete(orgId);
    }
  }

  private async doRegenerate(
    orgId: string,
    beliefs?: Belief[],
    hash?: string
  ): Promise<void> {
    const loaded =
      beliefs === undefined ? await this.loadContributing(orgId) : beliefs;
    const digest = hash ?? this.hash(loaded);

    const existing = await this.deps.cache.get(orgId);
    if (existing?.beliefs_hash === digest) return;

    const summary = await this.callLLM(loaded);

    const recheck = await this.deps.cache.get(orgId);
    if (recheck?.beliefs_hash === digest) return;

    const doc: OrgSummaryDoc = {
      _id: orgId,
      summary,
      beliefs_hash: digest,
      generated_at: new Date(),
      model: this.deps.modelId
    };
    await this.deps.cache.put(doc);
  }

  private async loadContributing(orgId: string): Promise<Belief[]> {
    return this.deps.beliefs
      .find({
        org_id: orgId,
        visibility: "org",
        resolved_at: null,
        superseded_by: null
      })
      .sort({ pinned: -1, created_at: -1 })
      .limit(40)
      .toArray();
  }

  private hash(beliefs: Belief[]): string {
    const h = createHash("sha256");
    for (const b of [...beliefs].sort((a, z) => a._id.localeCompare(z._id))) {
      h.update(`${b._id}:${b.updated_at.toISOString()}\n`);
    }
    return h.digest("hex");
  }

  private async callLLM(beliefs: Belief[]): Promise<string> {
    if (beliefs.length === 0) return "";

    const payload = beliefs.map((b) => ({
      canonical_name: b.canonical_name,
      content: b.content,
      why_it_matters: b.why_it_matters,
      type: b.type
    }));

    const adapter = this.deps.adapter();
    const resp = await adapter.call(
      this.deps.modelId,
      ORG_SUMMARY_PROMPT,
      [
        {
          role: "user",
          content: JSON.stringify({ org_beliefs: payload })
        }
      ],
      { temperature: 0.3, max_tokens: 1200 }
    );
    const parsed = JSON.parse(this.extractJson(resp.content));
    return String(parsed.summary ?? "");
  }

  private extractJson(raw: string): string {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : stripped;
  }
}
