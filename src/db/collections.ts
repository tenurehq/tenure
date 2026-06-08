import type { Collection, Db } from "mongodb";
import type { Belief } from "../types/belief.js";
import type { Turn } from "../history/manager.js";
import type { Session } from "../types/session.js";
import type { ExtractionJob } from "../types/job.js";
import type { ErrorLog } from "../types/error.js";
import type { PersonaDoc } from "../context/personaCache.js";
import type {
  CompactionLogEntry,
  BeliefContradiction
} from "../jobs/compactionRunner.js";
import type { InjectionAuditRecord } from "../types/injectionAudit.js";

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
  created_at: Date;
  updated_at: Date;
}

export interface TopicIndexEntry {
  _id: string;
  user_id: string;
  topic: string;
  belief_ids: string[];
  updated_at: Date;
}

export interface ApiTokenDoc {
  _id: string;
  token_hash: string;
  name: string;
  user_id: string;
  created_at: Date;
  last_used_at?: Date | null;
  revoked_at?: Date | null;
}

export interface ScimUserDoc {
  _id: string;
  userName: string;
  active: boolean;
  externalId?: string;
  name?: { givenName?: string; familyName?: string };
  emails?: Array<{ value: string; type?: string; primary?: boolean }>;
  meta: {
    resourceType: "User";
    created: Date;
    lastModified: Date;
  };
}

export interface Collections {
  db: Db;
  beliefs_plain: Collection<Belief>;
  beliefs: Collection<Belief>;
  turns: Collection<Turn>;
  sessions: Collection<Session>;
  jobs: Collection<ExtractionJob>;
  errors: Collection<ErrorLog>;
  config: Collection<ConfigDoc>;
  topic_index: Collection<TopicIndexEntry>;
  persona_cache: Collection<PersonaDoc>;
  compaction_log: Collection<CompactionLogEntry>;
  contradictions: Collection<BeliefContradiction>;
  onboarding_drafts: Collection<OnboardingDraftDoc>;
  file_meta: Collection<FileMetaDoc>;
  injection_audit: Collection<InjectionAuditRecord>;
  api_tokens: Collection<ApiTokenDoc>;
  scim_users: Collection<ScimUserDoc>;
}

export function getCollections(db: Db, plainDb?: Db): Collections {
  const plain = plainDb ?? db;
  return {
    db,
    beliefs_plain: plain.collection<Belief>("beliefs"),
    beliefs: db.collection<Belief>("beliefs"),
    turns: db.collection<Turn>("turns"),
    sessions: db.collection<Session>("sessions"),
    jobs: db.collection<ExtractionJob>("jobs"),
    errors: db.collection<ErrorLog>("errors"),
    config: db.collection<ConfigDoc>("config"),
    topic_index: db.collection<TopicIndexEntry>("topic_index"),
    persona_cache: db.collection<PersonaDoc>("persona_cache"),
    compaction_log: db.collection<CompactionLogEntry>("compaction_log"),
    contradictions: db.collection<BeliefContradiction>("belief_contradictions"),
    onboarding_drafts: db.collection<OnboardingDraftDoc>("onboarding_drafts"),
    file_meta: db.collection<FileMetaDoc>("file_meta"),
    injection_audit: db.collection<InjectionAuditRecord>("injection_audit"),
    api_tokens: db.collection<ApiTokenDoc>("api_tokens"),
    scim_users: db.collection<ScimUserDoc>("scim_users")
  };
}
