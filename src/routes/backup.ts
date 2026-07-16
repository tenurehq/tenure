import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import type { RuntimeConfigStore } from "../config/runtime.js";
import { BackupExporter } from "../backup/exporter.js";
import { BackupImporter, type ImportOptions } from "../backup/importer.js";

export interface BackupDeps {
  db: Db;
  runtimeStore: RuntimeConfigStore;
}

const exportsEnabled = process.env.TENURE_BACKUP_EXPORTS_ENABLED !== "false";
const importsEnabled = process.env.TENURE_BACKUP_IMPORTS_ENABLED !== "false";

export function registerBackupRoutes(
  app: FastifyInstance,
  deps: BackupDeps
): void {
  app.post<{
    Body: { passphrase: string };
  }>("/v1/backup/export", async (req, reply) => {
    if (!exportsEnabled) {
      return reply.code(403).send({
        error: { message: "Backup export is disabled in this deployment." }
      });
    }

    const { passphrase } = req.body;

    if (!passphrase || passphrase.length < 8) {
      return reply.code(400).send({
        error: {
          message: "Passphrase is required and must be at least 8 characters"
        }
      });
    }

    const exporter = new BackupExporter({
      db: deps.db,
      runtimeStore: deps.runtimeStore,
      userId: req.tenureUserId
    });

    const archive = await exporter.export(passphrase);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `tenure-backup-${timestamp}.enc`;

    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("x-tenure-export-version", "1")
      .send(archive);
  });

  app.post<{
    Body: {
      passphrase: string;
      skip_existing?: boolean;
      import_config?: boolean;
    };
  }>("/v1/backup/import", async (req, reply) => {
    if (!importsEnabled) {
      return reply.code(403).send({
        error: { message: "Backup import is disabled in this deployment." }
      });
    }

    const { passphrase, skip_existing, import_config } = req.body;

    if (!passphrase) {
      return reply.code(400).send({
        error: { message: "Passphrase is required" }
      });
    }

    const archiveField = (req.body as Record<string, unknown>).archive;
    if (!archiveField || typeof archiveField !== "string") {
      return reply.code(400).send({
        error: { message: "archive field (base64) is required" }
      });
    }

    const archive = Buffer.from(archiveField, "base64");

    const options: ImportOptions = {
      skipExisting: skip_existing ?? true,
      importConfig: import_config ?? true,
      remapUserId: true
    };

    const importer = new BackupImporter({
      db: deps.db,
      runtimeStore: deps.runtimeStore,
      userId: req.tenureUserId
    });

    try {
      const result = await importer.importEncrypted(
        archive,
        passphrase,
        options
      );
      return reply.send({
        ok: true,
        result
      });
    } catch (err) {
      const message = (err as Error).message;
      if (
        message.includes("Wrong passphrase") ||
        message.includes("Decryption failed")
      ) {
        return reply.code(401).send({
          error: { message: "Wrong passphrase or corrupted archive" }
        });
      }
      if (message.includes("Unsupported export version")) {
        return reply.code(422).send({
          error: { message }
        });
      }
      throw err;
    }
  });

  app.get("/v1/backup/preview", async (req, reply) => {
    const exporter = new BackupExporter({
      db: deps.db,
      runtimeStore: deps.runtimeStore,
      userId: req.tenureUserId
    });

    const payload = await exporter.exportUnencrypted();

    return reply.send({
      version: payload.version,
      exported_at: payload.exported_at,
      user_id: payload.user_id,
      counts: {
        beliefs: payload.beliefs.length,
        beliefs_active: payload.beliefs.filter(
          (b) => b.superseded_by === null && b.resolved_at === null
        ).length,
        has_persona: payload.persona_cache !== null,
        has_config: payload.runtime_config !== null
      }
    });
  });
}
