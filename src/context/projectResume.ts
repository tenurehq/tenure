import type { Collection } from "mongodb";
import type { WorkspaceStateCache } from "../workspace/stateCache.js";
import type { InternalLLMCaller } from "../providers/types.js";
import type { InjectionAuditRecord } from "../types/injectionAudit.js";
import type { Belief } from "../types/belief.js";
import type { FileMetaDoc } from "../db/collections.js";

const RESUME_SYSTEM_PROMPT = `You summarize what a developer appeared to be working on in a software project.

You are given a JSON source bundle containing recent project activity:
- audit queries from the user's last working window
- active files and file metadata
- created beliefs
- updated beliefs
- open-question beliefs, if any
- optional git/session metadata

The system will preserve all raw source data separately. Your job is only to synthesize:
- a short title
- a concise summary
- inferred next steps
- a confidence score and reason

Use ONLY the provided data.
Do not invent completed work, files, tickets, blockers, decisions, or outcomes.
Do not claim the user edited code unless the source bundle explicitly says so.
Do not repeat the full source bundle.
Do not include open questions as a separate field; open questions are already tracked by the system as beliefs.

Weight the evidence in this order:
1. Audit queries: strongest signal of the user's intent.
2. Created or updated beliefs: strong signal of decisions, preferences, or unresolved project context.
3. Active files: useful for grounding where the work happened, but weak for intent by themselves.
4. File metadata: supporting evidence only.

When audit queries and file activity disagree, prefer the audit queries for intent and use files only as grounding.
When only file activity is available, use cautious wording such as "appears to have been focused on" or "recent activity was around."
Separate observed facts from inferred next steps in the wording.
If the data is thin or ambiguous, lower the confidence score.

Return a single JSON object with this exact shape:

{
  "title": "string",
  "summary": "string",
  "inferred_next_steps": ["string"],
  "confidence": 0.0,
  "confidence_reason": "string"
}

Field rules:
- title: short, specific, under 80 characters. Prefer the apparent workstream from audit queries over filenames.
- summary: 2-4 sentences. Explain what the developer appeared to be working on, grounded first in audit queries, then beliefs, then files.
- inferred_next_steps: 1-5 concrete next actions that follow from the source bundle. Use cautious wording when uncertain.
- confidence: 0.0 to 1.0 based on how much evidence supports the summary.
- confidence_reason: one sentence explaining which signals support the confidence score.

Do not emit markdown.
Do not include commentary outside the JSON.
Do not include fields other than the exact fields listed above.`;

export interface ResumeSnapshot {
  project_scope: string;
  last_seen_at: string;
  title: string;
  summary: string;

  active_files: Array<{
    path: string;
    last_seen_at: string;
    language: string | null;
    visit_count: number;
    size_bytes?: number;
  }>;

  created_beliefs: Array<{
    id: string;
    type: string;
    content: string;
    why_it_matters: string;
  }>;

  updated_beliefs: Array<{
    id: string;
    content: string;
    change_summary?: string;
  }>;

  open_question_beliefs: Array<{
    id: string;
    content: string;
  }>;

  audit_queries: Array<{
    timestamp: string;
    query: string;
    active_file?: string | null;
  }>;

  inferred_next_steps: string[];
  confidence: number;
  confidence_reason: string;

  source_counts: {
    audit_queries: number;
    active_files: number;
    created_beliefs: number;
    updated_beliefs: number;
    open_question_beliefs: number;
  };
}

export interface ProjectResumeDeps {
  injectionAudit: Collection<InjectionAuditRecord>;
  beliefs: Collection<Belief>;
  fileMeta: Collection<FileMetaDoc>;
  workspaceState: WorkspaceStateCache;
  adapter: () => InternalLLMCaller;
  modelId: string;
}

export class ProjectResumeService {
  constructor(private readonly deps: ProjectResumeDeps) {}

  async generate(userId: string): Promise<ResumeSnapshot> {
    await this.deps.workspaceState.load(userId);
    const projectScope = this.deps.workspaceState.resolveProjectScope(userId);

    if (!projectScope) {
      throw new Error("No project scope resolved.");
    }

    const MAX_CLUSTER_GAP_MS = 4 * 60 * 60 * 1000;
    const MAX_CLUSTER_AGE_MS = 24 * 60 * 60 * 1000;
    const LIMIT = 50;

    // Run three separate queries -- no $unionWith, so CSFLE is happy
    const [auditDocs, fileDocs, beliefDocs] = await Promise.all([
      this.deps.injectionAudit
        .find(
          { user_id: userId, scope: { $in: [projectScope] } },
          {
            projection: { user_query: 1, created_at: 1 },
            sort: { created_at: -1 },
            limit: LIMIT
          }
        )
        .toArray()
        .then((docs) =>
          docs.map((d) => ({
            source: "audit" as const,
            ts: d.created_at,
            ...d
          }))
        ),

      this.deps.fileMeta
        .find(
          {
            user_id: userId,
            project_scope: projectScope,
            last_edited_at: { $exists: true }
          },
          {
            projection: { path: 1, size_bytes: 1, last_edited_at: 1 },
            sort: { last_edited_at: -1 },
            limit: LIMIT
          }
        )
        .toArray()
        .then((docs) =>
          docs
            .filter(
              (d): d is typeof d & { last_edited_at: Date } =>
                d.last_edited_at instanceof Date
            )
            .map((d) => ({
              source: "file" as const,
              ts: d.last_edited_at,
              ...d
            }))
        ),

      this.deps.beliefs
        .find(
          {
            user_id: userId,
            scope: { $in: [projectScope] },
            superseded_by: null,
            resolved_at: null
          },
          {
            projection: {
              type: 1,
              content: 1,
              why_it_matters: 1,
              updated_at: 1
            },
            sort: { updated_at: -1 },
            limit: LIMIT
          }
        )
        .toArray()
        .then((docs) =>
          docs.map((d) => ({
            source: "belief" as const,
            ts: d.updated_at,
            ...d
          }))
        )
    ]);

    const allEvents = [...auditDocs, ...fileDocs, ...beliefDocs]
      .filter((e): e is typeof e & { ts: Date } => e.ts instanceof Date)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime())
      .slice(0, LIMIT);

    if (allEvents.length === 0) {
      return this.emptySnapshot(projectScope);
    }

    const latestTs = allEvents[0].ts.getTime();
    const events: typeof allEvents = [];
    let prevTs = latestTs;

    for (const e of allEvents) {
      const ts = e.ts.getTime();
      const gap = prevTs - ts;
      const age = latestTs - ts;

      if (gap > MAX_CLUSTER_GAP_MS || age > MAX_CLUSTER_AGE_MS) break;

      events.push(e);
      prevTs = ts;
    }

    if (events.length === 0) {
      return this.emptySnapshot(projectScope);
    }

    const recentAudits = events
      .filter((e): e is (typeof auditDocs)[number] => e.source === "audit")
      .slice(0, 15);

    const recentBeliefs = events
      .filter((e): e is (typeof beliefDocs)[number] => e.source === "belief")
      .slice(0, 15);

    const recentFiles = events
      .filter((e): e is (typeof fileDocs)[number] => e.source === "file")
      .slice(0, 10);

    const openQuestionBeliefs = recentBeliefs.filter(
      (b) => b.type === "open_question"
    );
    const otherBeliefs = recentBeliefs.filter(
      (b) => b.type !== "open_question"
    );

    const hasData =
      recentAudits.length > 0 ||
      otherBeliefs.length > 0 ||
      openQuestionBeliefs.length > 0 ||
      recentFiles.length > 0;

    if (!hasData) {
      return this.emptySnapshot(projectScope);
    }

    const bundle = {
      project_scope: projectScope,
      recent_queries: recentAudits.map((a) => ({
        timestamp: a.created_at.toISOString(),
        query: a.user_query,
        active_file: null
      })),
      recent_beliefs: otherBeliefs.map((b) => ({
        id: b._id,
        type: b.type,
        content: b.content,
        why_it_matters: b.why_it_matters
      })),
      recent_files: recentFiles.map((f) => ({
        path: f.path,
        last_edited_at: f.last_edited_at.toISOString(),
        size_bytes: f.size_bytes
      })),
      open_question_beliefs: openQuestionBeliefs.map((b) => ({
        id: b._id,
        content: b.content
      }))
    };

    const adapter = this.deps.adapter();
    const resp = await adapter.call(
      this.deps.modelId,
      RESUME_SYSTEM_PROMPT,
      [{ role: "user", content: JSON.stringify(bundle) }],
      { temperature: 0.1, max_tokens: 2000 }
    );

    const raw = JSON.parse(this.extractJson(resp.content));
    return this.buildSnapshot(raw, projectScope, {
      recentAudits,
      otherBeliefs,
      openQuestionBeliefs,
      recentFiles
    });
  }

  private emptySnapshot(projectScope: string): ResumeSnapshot {
    const now = new Date().toISOString();
    return {
      project_scope: projectScope,
      last_seen_at: now,
      title: "No recent project activity",
      summary:
        "No edits, queries, or beliefs were found for this project recently.",
      active_files: [],
      created_beliefs: [],
      updated_beliefs: [],
      open_question_beliefs: [],
      audit_queries: [],
      inferred_next_steps: [],
      confidence: 0,
      confidence_reason: "No source data available for this project scope.",
      source_counts: {
        audit_queries: 0,
        active_files: 0,
        created_beliefs: 0,
        updated_beliefs: 0,
        open_question_beliefs: 0
      }
    };
  }

  private buildSnapshot(
    raw: Record<string, unknown>,
    projectScope: string,
    sources: {
      recentAudits: {
        source: "audit";
        _id: string;
        user_query: string;
        created_at: Date;
      }[];
      otherBeliefs: {
        source: "belief";
        _id: string;
        type: string;
        content: string;
        why_it_matters: string;
        updated_at: Date;
      }[];
      openQuestionBeliefs: {
        source: "belief";
        _id: string;
        type: string;
        content: string;
        why_it_matters: string;
        updated_at: Date;
      }[];
      recentFiles: {
        source: "file";
        _id: string;
        path: string;
        size_bytes: number;
        last_edited_at: Date;
      }[];
    }
  ): ResumeSnapshot {
    const now = new Date().toISOString();

    return {
      project_scope: projectScope,
      last_seen_at: now,
      title: String(raw.title ?? "Project Resume"),
      summary: String(raw.summary ?? ""),
      active_files: sources.recentFiles.map((f) => ({
        path: f.path,
        last_seen_at: f.last_edited_at.toISOString(),
        language: null,
        visit_count: 1,
        size_bytes: f.size_bytes
      })),
      created_beliefs: sources.otherBeliefs.map((b) => ({
        id: b._id,
        type: b.type,
        content: b.content,
        why_it_matters: b.why_it_matters
      })),
      updated_beliefs: [],
      open_question_beliefs: sources.openQuestionBeliefs.map((b) => ({
        id: b._id,
        content: b.content
      })),
      audit_queries: sources.recentAudits.map((a) => ({
        timestamp: a.created_at.toISOString(),
        query: a.user_query,
        active_file: null
      })),
      inferred_next_steps: Array.isArray(raw.inferred_next_steps)
        ? raw.inferred_next_steps.map(String)
        : [],
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
      confidence_reason: String(
        raw.confidence_reason ?? "No confidence reason provided."
      ),
      source_counts: {
        audit_queries: sources.recentAudits.length,
        active_files: sources.recentFiles.length,
        created_beliefs: sources.otherBeliefs.length,
        updated_beliefs: 0,
        open_question_beliefs: sources.openQuestionBeliefs.length
      }
    };
  }

  private extractJson(raw: string): string {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : stripped;
  }
}
