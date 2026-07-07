import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import type {
  InjectionAuditRecord,
  BeliefSnapshot
} from "../types/injectionAudit.js";
import type { Belief } from "../types/belief.js";
import type { BuiltContext } from "../context/contextBuilder.js";

export class InjectionAuditLogger {
  constructor(private readonly col: Collection<InjectionAuditRecord>) {}

  async log(params: {
    userId: string;
    sessionId: string;
    requestId: string;
    userQuery: string;
    expandedQuery: string;
    scope: string[];
    agentId: string | null;
    tokenId?: string | null;
    tokenName?: string | null;
    tokenKind?: "client" | "agent" | "root" | null;
    injected: boolean;
    beliefCtx: BuiltContext;
  }): Promise<void> {
    const {
      userId,
      sessionId,
      requestId,
      userQuery,
      expandedQuery,
      scope,
      agentId,
      tokenId,
      tokenName,
      tokenKind,
      injected,
      beliefCtx
    } = params;

    const pinnedSnapshots = beliefCtx.rawPinnedFacts.map(snapshotBelief);
    const relevantSnapshots = beliefCtx.rawRelevantBeliefs.map(snapshotBelief);
    const questionSnapshots = beliefCtx.rawOpenQuestions.map(snapshotBelief);

    const totalCount =
      pinnedSnapshots.length +
      relevantSnapshots.length +
      questionSnapshots.length;

    if (totalCount === 0) return;

    const record: InjectionAuditRecord = {
      _id: randomUUID(),
      user_id: userId,
      session_id: sessionId,
      request_id: requestId,
      user_query: userQuery.trim().slice(0, 2000),
      expanded_query: expandedQuery.trim().slice(0, 2000),
      scope,
      agent_id: agentId,
      token_id: tokenId ?? null,
      token_name: tokenName ?? null,
      token_kind: tokenKind ?? null,
      injected,
      injected_beliefs: {
        pinned_facts: pinnedSnapshots,
        relevant_beliefs: relevantSnapshots,
        open_questions: questionSnapshots
      },
      belief_count: totalCount,
      created_at: new Date()
    };

    await this.col.insertOne(record);
  }
}

function snapshotBelief(b: Belief): BeliefSnapshot {
  return {
    _id: b._id,
    type: b.type,
    subtype: b.subtype,
    canonical_name: b.canonical_name,
    aliases: b.aliases,
    content: b.content,
    why_it_matters: b.why_it_matters,
    scope: b.scope,
    epistemic_status: b.epistemic_status,
    confidence: b.confidence,
    pinned: b.pinned
  };
}
