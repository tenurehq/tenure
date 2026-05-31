import type { Belief } from "./belief.js";

/**
 * A snapshot of a belief at the time it was surfaced for a chat turn.
 * Stored in full so the audit remains valid even if the belief is later
 * superseded, edited, or deleted.
 */
export type BeliefSnapshot = Pick<
  Belief,
  | "_id"
  | "type"
  | "subtype"
  | "canonical_name"
  | "aliases"
  | "content"
  | "why_it_matters"
  | "scope"
  | "epistemic_status"
  | "confidence"
  | "pinned"
>;

export interface InjectionAuditRecord {
  _id: string;
  user_id: string;
  session_id: string;
  request_id: string;
  user_query: string;
  expanded_query: string;
  scope: string[];
  agent_id: string | null;
  injected: boolean;
  injected_beliefs: {
    pinned_facts: BeliefSnapshot[];
    relevant_beliefs: BeliefSnapshot[];
    open_questions: BeliefSnapshot[];
  };
  belief_count: number;
  created_at: Date;
}
