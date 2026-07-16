import type { Db } from "mongodb";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { RuntimeConfig } from "../config/runtime.js";
import type { Belief } from "../types/belief.js";
import type { PersonaDoc } from "../context/personaCache.js";
import type { TenureExport, ExportedBelief } from "./types.js";
import { decryptArchive } from "./crypto.js";
import type { InjectionAuditRecord } from "../types/injectionAudit.js";

export interface ImporterDeps {
  db: Db;
  runtimeStore: RuntimeConfigStore;
  userId: string;
}

export interface ImportResult {
  beliefs_imported: number;
  beliefs_skipped: number;
  persona_restored: boolean;
  config_restored: boolean;
}

export interface ImportOptions {
  skipExisting?: boolean;
  importConfig?: boolean;
  remapUserId?: boolean;
}

const DEFAULT_OPTIONS: Required<ImportOptions> = {
  skipExisting: true,
  importConfig: true,
  remapUserId: true
};

export class BackupImporter {
  constructor(private readonly deps: ImporterDeps) {}

  async importEncrypted(
    archive: Buffer,
    passphrase: string,
    options: ImportOptions = {}
  ): Promise<ImportResult> {
    const decrypted = decryptArchive(archive, passphrase);
    const payload = JSON.parse(decrypted.toString("utf-8")) as TenureExport;
    return this.importPayload(payload, options);
  }

  async importPayload(
    payload: TenureExport,
    options: ImportOptions = {}
  ): Promise<ImportResult> {
    if (payload.version !== 1) {
      throw new Error(
        `Unsupported export version: ${payload.version}. This version of Tenure supports version 1.`
      );
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const { db, runtimeStore, userId } = this.deps;
    const targetUserId = opts.remapUserId ? userId : payload.user_id;

    const result: ImportResult = {
      beliefs_imported: 0,
      beliefs_skipped: 0,
      persona_restored: false,
      config_restored: false
    };

    const beliefsCol = db.collection<Belief>("beliefs");
    const beliefsToInsert: Belief[] = [];

    for (const exported of payload.beliefs) {
      if (opts.skipExisting) {
        const exists = await beliefsCol.findOne({ _id: exported._id });
        if (exists) {
          result.beliefs_skipped++;
          continue;
        }
      }
      beliefsToInsert.push(this.deserializeBelief(exported, targetUserId));
    }

    if (beliefsToInsert.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < beliefsToInsert.length; i += batchSize) {
        const batch = beliefsToInsert.slice(i, i + batchSize);
        await beliefsCol.insertMany(batch, { ordered: false }).catch((err) => {
          if (err.code === 11000) {
            result.beliefs_skipped += batch.length;
          } else {
            throw err;
          }
        });
      }
      result.beliefs_imported = beliefsToInsert.length;
    }

    if (opts.importConfig && payload.runtime_config) {
      const cfg = payload.runtime_config;
      const configKeys: Array<keyof typeof cfg> = [
        "default_provider",
        "default_model",
        "openai_api_key",
        "anthropic_api_key",
        "openai_base_url",
        "anthropic_base_url",
        "openai_endpoint_flavor",
        "always_on_token_target",
        "error_retention_days",
        "strict_model_tiers",
        "extraction_enabled",
        "ide_extraction_enabled"
      ];

      for (const key of configKeys) {
        const value = cfg[key];
        if (value !== null && value !== undefined) {
          await runtimeStore.set(
            key as keyof RuntimeConfig,
            value as RuntimeConfig[keyof RuntimeConfig]
          );
        }
      }
      result.config_restored = true;
    }

    if (payload.persona_cache) {
      const personaCol = db.collection<PersonaDoc>("persona_cache");
      const doc: PersonaDoc = {
        _id: targetUserId,
        universal: payload.persona_cache.universal,
        contributing_belief_ids: payload.persona_cache.contributing_belief_ids,
        beliefs_hash: payload.persona_cache.beliefs_hash,
        generated_at: new Date(payload.persona_cache.generated_at),
        model: payload.persona_cache.model
      };
      await personaCol.replaceOne({ _id: targetUserId }, doc, { upsert: true });
      result.persona_restored = true;
    }

    if (payload.injection_audit?.length > 0) {
      const auditCol = db.collection<InjectionAuditRecord>("injection_audit");
      const entries = payload.injection_audit.map((r) => ({
        ...r,
        user_id: targetUserId,
        created_at: new Date(r.created_at)
      }));

      await auditCol.insertMany(entries, { ordered: false }).catch((err) => {
        if (err.code !== 11000) throw err;
      });
    }

    return result;
  }

  private deserializeBelief(exported: ExportedBelief, userId: string): Belief {
    return {
      _id: exported._id,
      user_id: userId,
      type: exported.type,
      subtype: exported.subtype,
      canonical_name: exported.canonical_name,
      aliases: exported.aliases,
      content: exported.content,
      why_it_matters: exported.why_it_matters,
      scope: exported.scope,
      provenance: {
        extracted_at: new Date(exported.provenance.extracted_at),
        source_model: exported.provenance.source_model
      },
      epistemic_status: exported.epistemic_status as Belief["epistemic_status"],
      confidence: exported.confidence,
      reinforcement_count: exported.reinforcement_count,
      last_reinforced_at: new Date(exported.last_reinforced_at),
      pinned: exported.pinned,
      user_edited: exported.user_edited,
      superseded_by: exported.superseded_by,
      resolved_at: exported.resolved_at ? new Date(exported.resolved_at) : null,
      change_log: exported.change_log.map((entry) => ({
        changed_at: new Date(entry.changed_at),
        trigger: entry.trigger
      })),
      ...(exported.expertise_domain && {
        expertise_domain: exported.expertise_domain
      }),
      ...(exported.expertise_depth && {
        expertise_depth: exported.expertise_depth as Belief["expertise_depth"]
      }),
      ...(exported.expertise_evidence_count != null && {
        expertise_evidence_count: exported.expertise_evidence_count
      }),
      created_at: new Date(exported.created_at),
      updated_at: new Date(exported.updated_at)
    } as Belief;
  }
}
