export type ErrorSeverity = "warning" | "error" | "critical";

export type ErrorStage =
  | "context_assembly"
  | "topical_retrieval"
  | "provider_call"
  | "sidecar_parse"
  | "belief_extraction"
  | "belief_write"
  | "history_write"
  | "supersession"
  | "topic_index"
  | "config"
  | "job_enqueue";

export interface ErrorLog {
  _id: string;
  occurred_at: Date;
  severity: ErrorSeverity;
  stage: ErrorStage;
  message: string;
  exception_type: string | null;
  stack_trace: string | null;
  user_id: string;
  request_id: string | null;
  provider: string | null;
  model: string | null;
  context: Record<string, unknown>;
  user_impacted: boolean;
  passthrough_succeeded: boolean | null;
  resolved: boolean;
  resolved_at: Date | null;
  actor_id: string | null;
}
