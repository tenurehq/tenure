export type JobStatus = "pending" | "running" | "done" | "failed";
export type ParseStatus = "parsed" | "needs_repair" | "missing";
export type JobType =
  | "extract_beliefs"
  | "onboarding_extraction"
  | "import_extraction";

export type JobTokenKind = "client" | "agent" | "root";

export interface ExtractionJobPayload {
  user_message: string;
  assistant_message: string;
  sidecar: string | null;
  parse_status: ParseStatus;
  scope: string[];
  source_model: string;
  source_label?: string;
  client_category?: string;
  extraction_mode?: "standard" | "ide";
  workspace_context?: {
    project_scope: string | null;
    language_scope: string | null;
    active_file: string | null;
  };
}

export interface ExtractionJob {
  _id: string;
  type: JobType;
  user_id: string;
  agent_id?: string | null;
  token_id: string;
  token_name: string;
  token_kind: JobTokenKind;
  session_id: string;
  turn_id: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_after: Date;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  payload: ExtractionJobPayload;
  result_belief_ids?: string[];
}
