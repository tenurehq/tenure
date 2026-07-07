import type { FastifyInstance } from "fastify";
import type { Collection, WithId } from "mongodb";
import type { Belief, BeliefSuggestion } from "../types/belief.js";
import type { ExtractionJobQueue } from "../jobs/queue.js";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ExtractionWorkerLike } from "../extraction/worker.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
  buildImportExtractionPrompt,
  buildImportExtractionSystemPrompt,
  buildOpenClawExtractionSystemPrompt
} from "../extraction/importPrompt.js";
import { extractJsonBlock } from "../extraction/extractJson.js";
import type { BeliefWriter } from "../extraction/beliefWriter.js";
import type { InternalLLMCaller } from "../providers/types.js";
import { assertTokenProjectScopes } from "../server.js";
import { buildBeliefProjectScopeFilter } from "../helpers/scopeAccess.js";

export interface BeliefsDeps {
  beliefs: Collection<Belief>;
  jobs: ExtractionJobQueue;
  extractionWorker: ExtractionWorkerLike;
  runtimeStore: RuntimeConfigStore;
  providers: ProviderRegistry;
  beliefWriter: BeliefWriter;
  suggestions: Collection<BeliefSuggestion>;
}

export function registerBeliefsRoutes(
  app: FastifyInstance,
  deps: BeliefsDeps
): void {
  const { beliefs: col } = deps;

  app.get<{
    Querystring: {
      scope?: string;
      type?: string;
      status?: string;
      limit?: string;
    };
  }>("/v1/beliefs", async (req, reply) => {
    const userId = req.tenureUserId;
    const q = req.query;
    const projectScopeFilter = buildBeliefProjectScopeFilter(
      req.tenureTokenProjectScopes
    );

    const filter: Record<string, unknown> = {
      user_id: userId,
      ...projectScopeFilter
    };

    if (q.scope) {
      const requestedScopes = q.scope.split(",");
      const scopeCheck = assertTokenProjectScopes(req, requestedScopes);
      if (!scopeCheck.ok) {
        return reply.code(403).send({
          error: {
            message: scopeCheck.message,
            token_project_scopes: req.tenureTokenProjectScopes ?? null,
            requested_scope: requestedScopes
          }
        });
      }
      filter.scope = { $in: requestedScopes };
    }
    if (q.type) filter.type = { $in: q.type.split(",") };
    if (q.status) {
      filter.epistemic_status = { $in: q.status.split(",") };
    } else {
      filter.resolved_at = null;
      filter.superseded_by = null;
    }

    const limit = Math.min(parseInt(q.limit ?? "40", 10) || 40, 200);
    const docs = await col.find(filter).limit(limit).toArray();
    const total = await col.countDocuments(filter);

    return { beliefs: docs.map(redactForClient), total };
  });

  app.get<{ Params: { id: string } }>("/v1/beliefs/:id", async (req, reply) => {
    const userId = req.tenureUserId;
    const doc = await col.findOne({
      _id: req.params.id,
      user_id: userId,
      ...buildBeliefProjectScopeFilter(req.tenureTokenProjectScopes)
    });
    if (!doc) {
      return reply.code(404).send({ error: { message: "belief not found" } });
    }
    return { belief: redactForClient(doc) };
  });

  app.patch<{
    Params: { id: string };
    Body: {
      content?: string;
      epistemic_status?: string;
      pinned?: boolean;
      canonical_name?: string;
      why_it_matters?: string;
      aliases?: string[];
    };
  }>("/v1/beliefs/:id", async (req, reply) => {
    const userId = req.tenureUserId;
    const { id } = req.params;
    const patch = req.body ?? {};

    const current = await col.findOne({
      _id: id,
      user_id: userId,
      ...buildBeliefProjectScopeFilter(req.tenureTokenProjectScopes)
    });
    if (!current) {
      return reply.code(404).send({ error: { message: "belief not found" } });
    }

    const $set: Record<string, unknown> = { updated_at: new Date() };
    const logEntries: Array<{
      changed_at: Date;
      trigger: string;
      previous_content?: string | null;
      previous_epistemic_status?: string | null;
      changed_by_session: null;
      changed_by_turn: null;
    }> = [];

    const mutable = [
      "content",
      "epistemic_status",
      "pinned",
      "canonical_name",
      "why_it_matters",
      "aliases"
    ] as const;

    for (const field of mutable) {
      const newVal = patch[field];
      if (
        newVal !== undefined &&
        newVal !== (current as Record<string, unknown>)[field]
      ) {
        $set[field] = newVal;
        logEntries.push({
          changed_at: new Date(),
          trigger: "user_correction",
          ...(field === "content" ? { previous_content: current.content } : {}),
          ...(field === "epistemic_status"
            ? { previous_epistemic_status: current.epistemic_status }
            : {}),
          changed_by_session: null,
          changed_by_turn: null
        });
      }
    }

    if (logEntries.length === 0) {
      return { belief: redactForClient(current) };
    }

    const result = await col.findOneAndUpdate(
      { _id: id, user_id: userId },
      {
        $set,
        $push: { change_log: { $each: logEntries } } as any
      },
      { returnDocument: "after" }
    );

    return { belief: result ? redactForClient(result) : null };
  });

  app.delete<{ Params: { id: string } }>(
    "/v1/beliefs/:id",
    async (req, reply) => {
      const userId = req.tenureUserId;
      const { id } = req.params;
      const current = await col.findOne({
        _id: id,
        user_id: userId,
        ...buildBeliefProjectScopeFilter(req.tenureTokenProjectScopes)
      });
      if (!current) {
        return reply.code(404).send({ error: { message: "belief not found" } });
      }

      await col.findOneAndUpdate(
        { _id: id, user_id: userId },
        {
          $set: {
            epistemic_status: "superseded",
            resolved_at: new Date(),
            updated_at: new Date()
          },
          $push: {
            change_log: {
              changed_at: new Date(),
              trigger: "user_deletion",
              previous_epistemic_status: current.epistemic_status,
              changed_by_session: null,
              changed_by_turn: null
            }
          } as any
        }
      );

      return { ok: true };
    }
  );

  app.post<{
    Body: {
      type: string;
      canonical_name: string;
      content: string;
      why_it_matters: string;
      scope: string[];
      confidence?: number;
      epistemic_status?: string;
      aliases?: string[];
    };
  }>("/v1/beliefs", async (req, reply) => {
    const userId = req.tenureUserId;
    const body = req.body ?? {};

    if (req.tenureTokenKind === "agent") {
      return reply.code(403).send({
        error: {
          message: "Agent tokens cannot create beliefs. Use a client token."
        }
      });
    }

    if (!body.type || !body.canonical_name?.trim() || !body.content?.trim()) {
      return reply.code(400).send({
        error: { message: "type, canonical_name, and content are required" }
      });
    }
    if (!body.why_it_matters?.trim()) {
      return reply.code(400).send({
        error: { message: "why_it_matters is required" }
      });
    }
    if (!Array.isArray(body.scope) || body.scope.length === 0) {
      return reply.code(400).send({
        error: { message: "scope is required and must be a non-empty array" }
      });
    }

    const scopeCheck = assertTokenProjectScopes(req, body.scope);
    if (!scopeCheck.ok) {
      return reply.code(403).send({
        error: {
          message: scopeCheck.message,
          token_project_scopes: req.tenureTokenProjectScopes ?? null,
          requested_scope: body.scope
        }
      });
    }

    const VALID_TYPES = new Set([
      "preference",
      "decision",
      "entity",
      "relation",
      "open_question"
    ]);
    if (!VALID_TYPES.has(body.type)) {
      return reply.code(400).send({
        error: {
          message: `invalid type: ${body.type}. Must be one of: ${[
            ...VALID_TYPES
          ].join(", ")}`
        }
      });
    }

    const VALID_STATUSES = new Set(["active", "inferred", "exploratory"]);
    const epistemicStatus = body.epistemic_status ?? "active";
    const confidence = body.confidence ?? 1.0;
    if (!VALID_STATUSES.has(epistemicStatus)) {
      return reply.code(400).send({
        error: {
          message: `invalid epistemic_status: ${epistemicStatus}`
        }
      });
    }

    try {
      const beliefId = await deps.beliefWriter.create({
        user_id: userId,
        type: body.type as any,
        subtype: null,
        canonical_name: body.canonical_name.trim(),
        aliases: Array.isArray(body.aliases) ? body.aliases : [],
        content: body.content.trim(),
        why_it_matters: body.why_it_matters.trim(),
        scope: body.scope,
        provenance: {
          session_id: "manual",
          turn_id: "manual",
          extracted_at: new Date(),
          source_model: "user"
        },
        epistemic_status: epistemicStatus as any,
        confidence,
        pinned: false,
        user_edited: true,
        change_log: [
          {
            changed_at: new Date(),
            trigger: "manual_creation",
            changed_by_session: null,
            changed_by_turn: null
          }
        ]
      });

      const created = await col.findOne({ _id: beliefId, user_id: userId });
      return reply
        .code(201)
        .send({ belief: created ? redactForClient(created) : null });
    } catch (e: any) {
      if (e.constructor?.name === "CanonicalNameConflictError") {
        return reply.code(409).send({
          error: {
            message: `A belief with canonical name "${body.canonical_name.trim()}" already exists`,
            type: "conflict"
          }
        });
      }
      throw e;
    }
  });

  app.post<{ Body: { text: string; source_label?: string; scope?: string[] } }>(
    "/v1/beliefs/ingest",
    async (req, reply) => {
      const { text, source_label, scope } = req.body ?? {};

      if (scope?.length) {
        const scopeCheck = assertTokenProjectScopes(req, scope);
        if (!scopeCheck.ok) {
          return reply.code(403).send({
            error: {
              message: scopeCheck.message,
              token_project_scopes: req.tenureTokenProjectScopes ?? null,
              requested_scope: scope
            }
          });
        }
      }

      if (!text?.trim()) {
        return reply.code(400).send({ error: { message: "text is required" } });
      }

      if (text.length > 50_000) {
        return reply.code(400).send({
          error: {
            message: "text exceeds maximum length of 50,000 characters"
          }
        });
      }

      const cfg = await deps.runtimeStore.load();
      if (!cfg.default_model) {
        return reply.code(400).send({
          error: { message: "no default model configured" }
        });
      }

      let adapter;
      try {
        adapter = deps.providers.detectFromModel(
          cfg.default_model,
          cfg.default_provider
        );
      } catch {
        return reply.code(502).send({
          error: { message: "no provider configured for import extraction" }
        });
      }

      let extractionRaw: string;
      const isOpenClaw = (source_label ?? "").startsWith("openclaw:");
      const agentId = isOpenClaw
        ? (source_label ?? "").slice("openclaw:".length)
        : null;

      const systemPrompt =
        isOpenClaw && agentId
          ? buildOpenClawExtractionSystemPrompt(agentId)
          : buildImportExtractionSystemPrompt(
              scope?.length ? { declaredScope: scope } : {}
            );

      try {
        const resp = await (adapter as unknown as InternalLLMCaller).call(
          cfg.default_model,
          systemPrompt,
          [
            {
              role: "user",
              content: buildImportExtractionPrompt(
                text.trim(),
                source_label ?? "manual import"
              )
            }
          ],
          { temperature: 0.1, max_tokens: 8000 }
        );
        extractionRaw = resp.content;
      } catch (err) {
        req.log.error({ err }, "import extraction LLM call failed");
        return reply.code(502).send({
          error: { message: "extraction LLM call failed" }
        });
      }

      const sidecarJson = extractJsonBlock(extractionRaw);
      if (!sidecarJson) {
        return reply.code(200).send({
          ok: true,
          belief_count: 0,
          parse_failed: true
        });
      }

      try {
        if (!req.tenureTokenId || !req.tenureTokenKind) {
          return reply.code(401).send({
            error: { message: "missing token attribution for import" }
          });
        }

        const jobId = await deps.jobs.enqueueImport({
          userId: req.tenureUserId,
          tokenId: req.tenureTokenId,
          tokenName: req.tenureTokenName ?? "",
          tokenKind: req.tenureTokenKind,
          sourceLabel: source_label ?? "manual import",
          sidecarJson,
          sourceModel: cfg.default_model,
          ...(scope?.length ? { scope } : {})
        });

        deps.extractionWorker
          .processById(jobId)
          .catch((err) =>
            req.log.warn({ err, jobId }, "inline import extraction failed")
          );

        return { ok: true, job_id: jobId };
      } catch (err) {
        req.log.error({ err }, "import enqueue failed");
        return reply.code(500).send({
          error: { message: "failed to enqueue import" }
        });
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/beliefs/:id/history",
    async (req, reply) => {
      const userId = req.tenureUserId;
      const doc = await col.findOne(
        { _id: req.params.id, user_id: userId },
        { projection: { change_log: 1, created_at: 1, _id: 1 } }
      );
      if (!doc) {
        return reply.code(404).send({ error: { message: "belief not found" } });
      }
      return {
        belief_id: doc._id,
        created_at: doc.created_at,
        change_log: doc.change_log ?? []
      };
    }
  );

  app.get("/v1/scopes/projects", async (req) => {
    const userId = req.tenureUserId;
    const values = await col.distinct("scope", {
      user_id: userId,
      ...buildBeliefProjectScopeFilter(req.tenureTokenProjectScopes)
    });
    const scopes = values
      .filter(
        (s): s is string => typeof s === "string" && s.startsWith("project:")
      )
      .sort((a, b) => a.localeCompare(b));
    return { scopes };
  });

  app.get("/v1/beliefs/suggestions", async (req) => {
    const userId = req.tenureUserId;
    const docs = await deps.suggestions
      .find({ user_id: userId, status: "pending" })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    return {
      suggestions: docs.map((s) => ({
        id: s._id,
        canonical_name: s.canonical_name,
        content: s.content,
        why_it_matters: s.why_it_matters,
        type: s.type,
        scope: s.scope,
        aliases: s.aliases,
        confidence: s.confidence,
        epistemic_status: s.epistemic_status ?? "pending"
      }))
    };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/beliefs/suggestions/:id/approve",
    async (req, reply) => {
      const userId = req.tenureUserId;
      const { id } = req.params;

      const sug = await deps.suggestions.findOne({
        _id: id,
        user_id: userId,
        status: "pending"
      });
      if (!sug) {
        return reply
          .code(404)
          .send({ error: { message: "suggestion not found" } });
      }

      try {
        const beliefId = await deps.beliefWriter.create({
          user_id: userId,
          type: sug.type,
          subtype: sug.subtype ?? null,
          canonical_name: sug.canonical_name,
          aliases: sug.aliases ?? [],
          content: sug.content,
          why_it_matters: sug.why_it_matters ?? "",
          scope: sug.scope ?? ["user:universal"],
          provenance: sug.provenance ?? {
            session_id: "curated",
            turn_id: "curated",
            extracted_at: new Date(),
            source_model: sug.source_model ?? "unknown"
          },
          epistemic_status: sug.epistemic_status ?? "active",
          confidence: sug.confidence ?? 0.8,
          pinned: false,
          user_edited: false,
          change_log: [
            {
              changed_at: new Date(),
              trigger: "curated_approval",
              changed_by_session: null,
              changed_by_turn: null
            }
          ]
        });

        await deps.suggestions.updateOne(
          { _id: id, user_id: userId },
          {
            $set: {
              status: "approved",
              belief_id: beliefId,
              updated_at: new Date()
            }
          }
        );

        return { ok: true, belief_id: beliefId };
      } catch (e: any) {
        if (e.constructor?.name === "CanonicalNameConflictError") {
          return reply.code(409).send({
            error: { message: "Belief already exists", type: "conflict" }
          });
        }
        throw e;
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/beliefs/suggestions/:id/reject",
    async (req, reply) => {
      const userId = req.tenureUserId;
      const { id } = req.params;

      const result = await deps.suggestions.updateOne(
        { _id: id, user_id: userId, status: "pending" },
        { $set: { status: "rejected", updated_at: new Date() } }
      );

      if (result.matchedCount === 0) {
        return reply
          .code(404)
          .send({ error: { message: "suggestion not found" } });
      }

      return { ok: true };
    }
  );
}

function redactForClient(b: WithId<Belief>) {
  return {
    id: b._id,
    type: b.type,
    canonical_name: b.canonical_name,
    content: b.content,
    why_it_matters: b.why_it_matters,
    epistemic_status: b.epistemic_status,
    confidence: b.confidence,
    pinned: b.pinned,
    scope: b.scope,
    aliases: b.aliases
  };
}
