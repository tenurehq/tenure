import type { FastifyInstance } from "fastify";
import type {
  OpenAIEndpointFlavor,
  RuntimeConfig,
  RuntimeConfigStore
} from "../config/runtime.js";
import { ProviderRegistry } from "../providers/registry.js";
import { OpenAIAdapter } from "../providers/openai.js";
import { AnthropicAdapter } from "../providers/anthropic.js";
import type { Db } from "mongodb";
import { rotateApiToken } from "../config/appConfig.js";
import type { BeliefCompactionRunner } from "../jobs/compactionRunner.js";
import { registry } from "./beliefs-ws.js";
import type { ApiTokenDoc } from "../db/collections.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { requireRootToken } from "./setup-guard.js";

export interface AdminDeps {
  runtimeStore: RuntimeConfigStore;
  providers: ProviderRegistry;
  db: Db;
  updateToken: (t: string) => void;
  compactionRunner: BeliefCompactionRunner;
}

const PROVIDER_CONFIG: Record<
  string,
  {
    keyField: "openai_api_key" | "anthropic_api_key";
    urlField: "openai_base_url" | "anthropic_base_url";
    factory: (
      key: string,
      baseUrl?: string | null,
      flavor?: OpenAIEndpointFlavor
    ) => OpenAIAdapter | AnthropicAdapter;
  }
> = {
  openai: {
    keyField: "openai_api_key",
    urlField: "openai_base_url",
    factory: (key, url, flavor) =>
      new OpenAIAdapter(key, url ?? undefined, flavor ?? "generic")
  },
  anthropic: {
    keyField: "anthropic_api_key",
    urlField: "anthropic_base_url",
    factory: (key, _url) => new AnthropicAdapter(key)
  }
};

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminDeps
): void {
  app.get("/admin/config", async () => {
    const cfg = await deps.runtimeStore.load();
    return {
      default_provider: cfg.default_provider,
      default_model: cfg.default_model,
      openai_configured: cfg.openai_api_key !== null,
      openai_base_url: cfg.openai_base_url,
      openai_endpoint_flavor: cfg.openai_endpoint_flavor,
      anthropic_configured: cfg.anthropic_api_key !== null,
      anthropic_base_url: cfg.anthropic_base_url,
      always_on_token_target: cfg.always_on_token_target,
      managed_history_token_cap: cfg.managed_history_token_cap,
      error_retention_days: cfg.error_retention_days,
      extraction_enabled: cfg.extraction_enabled,
      strict_model_tiers: cfg.strict_model_tiers,
      compaction_mode: cfg.compaction_mode,
      scope_auto_detect: cfg.scope_auto_detect
    };
  });

  app.post("/admin/maintenance/compact", async (req, reply) => {
    try {
      await deps.compactionRunner.run(req.tenureUserId);
      return { ok: true };
    } catch (e) {
      return reply.code(500).send({
        error: { message: (e as Error).message }
      });
    }
  });

  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    "/admin/config/:key",
    async (req, reply) => {
      const { key } = req.params;
      const { value } = req.body ?? {};
      if (value === undefined) {
        return reply
          .code(400)
          .send({ error: { message: "value is required" } });
      }

      const safeKeys = new Set([
        "default_provider",
        "openai_base_url",
        "anthropic_base_url",
        "always_on_token_target",
        "managed_history_token_cap",
        "error_retention_days",
        "default_model",
        "extraction_enabled",
        "strict_model_tiers",
        "compaction_mode",
        "scope_auto_detect",
        "injection_enabled"
      ]);

      const isDynamicKey =
        key.startsWith("seeded_agent:") || key.startsWith("seed_attempted_at:");

      if (!safeKeys.has(key) && !isDynamicKey) {
        return reply.code(400).send({
          error: {
            message: `Use PUT /admin/providers/:id for credentials. Allowed: ${[
              ...safeKeys
            ].join(", ")}`
          }
        });
      }

      await deps.runtimeStore.set(key as keyof RuntimeConfig, value as never);

      if (key === "injection_enabled" || key === "extraction_enabled") {
        const updated = await deps.runtimeStore.load();
        registry.broadcast(req.tenureUserId, {
          type: "toggles_state",
          injection: updated.injection_enabled,
          extraction: updated.extraction_enabled
        });
      }

      return { ok: true, key, value };
    }
  );

  app.post<{ Body: { name: string } }>("/admin/tokens", async (req, reply) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return reply.code(400).send({ error: { message: "name is required" } });
    }

    const token = `tpat_${randomBytes(24).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const userId = req.tenureUserId;

    await deps.db.collection<ApiTokenDoc>("api_tokens").insertOne({
      _id: randomUUID(),
      token_hash: hash,
      name,
      user_id: userId,
      created_at: new Date()
    });

    return { ok: true, token, name, user_id: userId };
  });

  app.get("/admin/tokens", async (req) => {
    const userId = req.tenureUserId;
    const tokens = await deps.db
      .collection<ApiTokenDoc>("api_tokens")
      .find({ user_id: userId, revoked_at: { $exists: false } })
      .sort({ created_at: -1 })
      .project({ token_hash: 0 })
      .toArray();
    return { tokens };
  });

  app.delete<{ Params: { id: string } }>(
    "/admin/tokens/:id",
    async (req, reply) => {
      const userId = req.tenureUserId;
      const result = await deps.db
        .collection<ApiTokenDoc>("api_tokens")
        .updateOne(
          { _id: req.params.id, user_id: userId },
          { $set: { revoked_at: new Date() } }
        );
      if (result.matchedCount === 0) {
        return reply.code(404).send({ error: { message: "token not found" } });
      }
      return { ok: true, revoked: req.params.id };
    }
  );

  app.get("/admin/providers", async () => {
    const cfg = await deps.runtimeStore.load();
    const registered = deps.providers.listRegistered();
    return {
      providers: Object.keys(PROVIDER_CONFIG).map((id) => ({
        id,
        configured: cfg[PROVIDER_CONFIG[id].keyField] !== null,
        base_url: cfg[PROVIDER_CONFIG[id].urlField],
        endpoint_flavor:
          id === "openai" ? cfg.openai_endpoint_flavor : undefined,
        registered: registered.includes(id)
      }))
    };
  });

  app.get<{ Querystring: { limit?: string; severity?: string } }>(
    "/admin/errors",
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? "20", 10) || 20, 100);
      const filter: Record<string, unknown> = {};
      if (req.query.severity) {
        filter.severity = { $in: req.query.severity.split(",") };
      }
      const errors = await deps.db
        .collection("errors")
        .find(filter)
        .sort({ occurred_at: -1 })
        .limit(limit)
        .project({
          _id: 1,
          occurred_at: 1,
          severity: 1,
          stage: 1,
          message: 1,
          provider: 1,
          model: 1,
          session_id: 1,
          turn_id: 1,
          user_impacted: 1,
          passthrough_succeeded: 1,
          exception_type: 1,
          stack_trace: 1
        })
        .toArray();
      return {
        errors,
        total: await deps.db.collection("errors").countDocuments()
      };
    }
  );

  app.put<{
    Params: { id: string };
    Body: { api_key: string; base_url?: string; endpoint_flavor?: string };
  }>(
    "/admin/providers/:id",
    { preHandler: requireRootToken },
    async (req, reply) => {
      const { id } = req.params;
      const { api_key, base_url, endpoint_flavor } = req.body ?? {};
      const spec = PROVIDER_CONFIG[id];

      if (!spec) {
        return reply.code(400).send({
          error: {
            message: `Unknown provider "${id}". Supported: ${Object.keys(
              PROVIDER_CONFIG
            ).join(", ")}`
          }
        });
      }

      if (!api_key || typeof api_key !== "string") {
        return reply
          .code(400)
          .send({ error: { message: "api_key is required" } });
      }

      if (id === "openai" && endpoint_flavor !== undefined) {
        await deps.runtimeStore.set(
          "openai_endpoint_flavor",
          endpoint_flavor as OpenAIEndpointFlavor
        );
      }

      const cfg = await deps.runtimeStore.load();
      const flavor = id === "openai" ? cfg.openai_endpoint_flavor : undefined;

      const adapter = spec.factory(api_key, base_url ?? null, flavor);
      try {
        if (adapter.listModels) await adapter.listModels();
      } catch (err) {
        return reply.code(502).send({
          error: {
            message: `Credentials rejected by provider: ${
              (err as Error).message
            }`
          }
        });
      }

      await deps.runtimeStore.set(spec.keyField, api_key);
      if (base_url !== undefined) {
        await deps.runtimeStore.set(spec.urlField, base_url);
      }

      deps.providers.register(adapter);

      return { ok: true, provider: id };
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/providers/:id",
    { preHandler: requireRootToken },
    async (req, reply) => {
      const { id } = req.params;
      const spec = PROVIDER_CONFIG[id];

      if (!spec) {
        return reply.code(400).send({
          error: {
            message: `Unknown provider "${id}". Supported: ${Object.keys(
              PROVIDER_CONFIG
            ).join(", ")}`
          }
        });
      }

      await deps.runtimeStore.set(spec.keyField, null);
      deps.providers.unregister(id);

      return { ok: true, provider: id };
    }
  );

  app.post("/admin/token/rotate", async (_req, reply) => {
    try {
      const newToken = await rotateApiToken(deps.db);
      deps.updateToken(newToken);

      return { ok: true, token: newToken };
    } catch (e) {
      return reply.code(500).send({
        error: { message: (e as Error).message }
      });
    }
  });
}
