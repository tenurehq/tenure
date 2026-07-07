import type { Collection, Db } from "mongodb";
import type { Belief, BeliefSuggestion } from "../types/belief.js";
import type { Session } from "../types/session.js";
import type { ExtractionJob } from "../types/job.js";
import type { ErrorLog } from "../types/error.js";
import type { PersonaDoc } from "../context/personaCache.js";
import type { InjectionAuditRecord } from "../types/injectionAudit.js";
import type { TokenCapability, TokenKind } from "../types/token.js";

export interface ConfigDoc {
  _id: string;
  key: string;
  value: unknown;
  encrypted: boolean;
  updatedAt: Date;
}

export interface OnboardingDraftDoc {
  _id: string;
  user_id: string;
  sidecarJson: string;
  modelId: string;
  created_at: Date;
}

export interface FileMetaDoc {
  _id: string;
  user_id: string;
  path: string;
  size_bytes: number;
  belief_ids: string[];
  last_edited_at?: Date;
  project_scope?: string;
  created_at: Date;
  updated_at: Date;
}

export interface TokenDoc {
  _id: string;
  kind: TokenKind;
  token_hash: string;
  token_prefix: string;
  name: string;
  user_id: string;
  capabilities: TokenCapability[];
  project_scopes: string[] | null;
  encrypted_value?: string | null;
  created_at: Date;
  last_used_at?: Date | null;
  revoked_at?: Date | null;
  expires_at?: Date | null;
}

export interface Collections {
  db: Db;
  beliefs_plain: Collection<Belief>;
  beliefs: Collection<Belief>;
  sessions: Collection<Session>;
  jobs: Collection<ExtractionJob>;
  errors: Collection<ErrorLog>;
  config: Collection<ConfigDoc>;
  persona_cache: Collection<PersonaDoc>;
  onboarding_drafts: Collection<OnboardingDraftDoc>;
  file_meta: Collection<FileMetaDoc>;
  injection_audit: Collection<InjectionAuditRecord>;
  tokens: Collection<TokenDoc>;
  belief_suggestions: Collection<BeliefSuggestion>;
}

export function getCollections(db: Db, plainDb?: Db): Collections {
  const plain = plainDb ?? db;
  return {
    db,
    beliefs_plain: plain.collection<Belief>("beliefs"),
    beliefs: db.collection<Belief>("beliefs"),
    sessions: db.collection<Session>("sessions"),
    jobs: db.collection<ExtractionJob>("jobs"),
    errors: db.collection<ErrorLog>("errors"),
    config: db.collection<ConfigDoc>("config"),
    persona_cache: db.collection<PersonaDoc>("persona_cache"),
    onboarding_drafts: db.collection<OnboardingDraftDoc>("onboarding_drafts"),
    file_meta: db.collection<FileMetaDoc>("file_meta"),
    injection_audit: db.collection<InjectionAuditRecord>("injection_audit"),
    tokens: db.collection<TokenDoc>("tokens"),
    belief_suggestions: db.collection<BeliefSuggestion>("belief_suggestions")
  };
}
