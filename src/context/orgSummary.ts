import type { Collection } from "mongodb";
import type { InternalLLMCaller } from "../providers/types.js";

export interface OrgSummaryLookup {
  get(orgId: string): Promise<{ summary: string } | null>;
}

export class OrgSummaryDirect implements OrgSummaryLookup {
  constructor(
    private readonly col: Collection<{ org_id: string; summary: string }>
  ) {}

  async get(orgId: string): Promise<{ summary: string } | null> {
    const doc = await this.col.findOne({ org_id: orgId });
    return doc ? { summary: doc.summary } : null;
  }
}

const ORG_SUMMARY_PROMPT = `You compose a compact organization standards prelude from unstructured or semi-structured input.
Output a single JSON object: { "summary": "string" }.

Rules:
- summary: 300-600 chars, one paragraph. Describe durable, governance-like standards.
- Use imperative statements ("Use TypeScript strict mode", "All APIs require tracing").
- Include architectural constraints, language preferences, security rules, and process requirements.
- Omit team working agreements or individual preferences.
- Synthesize duplicate or overlapping statements into a single coherent statement.
- No meta-commentary. Output only the JSON object.`;

export async function synthesizeOrgSummary(
  rawInput: string,
  modelId: string,
  adapter: () => InternalLLMCaller
): Promise<string> {
  const caller = adapter();
  const resp = await caller.call(
    modelId,
    ORG_SUMMARY_PROMPT,
    [{ role: "user", content: rawInput }],
    { temperature: 0.1, max_tokens: 1200 }
  );
  const parsed = JSON.parse(extractJson(resp.content));
  return String(parsed.summary ?? "");
}

function extractJson(raw: string): string {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const match = stripped.match(/\{[\s\S]*\}/);
  return match ? match[0] : stripped;
}
