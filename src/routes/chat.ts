import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyBaseLogger } from "fastify";
import type { ServerResponse } from "node:http";
import { SessionManager, type Session } from "../session/manager.js";
import { splitSidecar, SIDECAR_BEGIN } from "../sidecar/splitter.js";
import { ContextBuilder, EMPTY_CONTEXT } from "../context/contextBuilder.js";
import {
  ProviderRegistry,
  ProviderNotConfiguredError
} from "../providers/registry.js";
import { ExtractionJobQueue } from "../jobs/queue.js";
import type { ContentPart, Message, SystemPrompt } from "../providers/types.js";
import type { OpenAIAdapter } from "../providers/openai.js";
import { extractLatestUserText, extractText } from "../helpers/content.js";
import { deriveSessionId } from "../session/derivation.js";
import { checkModelTier, listSupportedFamilies } from "../providers/tiers.js";
import type { ExtractionWorkerLike } from "../extraction/worker.js";
import type { RuntimeConfigStore } from "../config/runtime.js";
import {
  tryInterceptScopeCommand,
  tryInterceptExtractCommand,
  tryInterceptInjectCommand,
  tryInterceptSessionCommand
} from "../helpers/scopeDetector.js";
import type { ErrorLogger } from "../errors/logger.js";
import { parseClient, type ParsedClient } from "../helpers/clientDetector.js";
import type { WorkspaceStateCache } from "../workspace/stateCache.js";
import { buildSystemPrompt } from "../context/systemPromptBuilder.js";
import { runSideEffects } from "./shared/sideEffects.js";
import type { InjectionAuditLogger } from "../audit/injectionAuditLogger.js";
import { assertTokenProjectScopes } from "../server.js";

export interface ChatDeps {
  sessions: SessionManager;
  context: ContextBuilder;
  providers: ProviderRegistry;
  jobs: ExtractionJobQueue;
  extractionWorker: ExtractionWorkerLike;
  runtimeStore: RuntimeConfigStore;
  errorLogger: ErrorLogger;
  workspaceState?: WorkspaceStateCache;
  injectionAudit?: InjectionAuditLogger;
}

interface ResolveScopeArgs {
  ocAgentId: string | undefined;
  sessionScope: string[];
  session: (Session & { providerId: string; model: string }) | null;
  sessionId: string;
  userId: string;
  deps: ChatDeps;
  logger: FastifyBaseLogger;
}

interface ChatBody {
  model?: string;
  messages: Array<{
    role: string;
    content: string | ContentPart[];
    name?: string;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
  metadata?: { session_id?: string; scope?: string[] };
  [key: string]: unknown;
}

export function registerChatRoute(app: FastifyInstance, deps: ChatDeps): void {
  app.post<{ Body: ChatBody }>("/v1/chat/completions", async (req, reply) => {
    const body = req.body;

    if (!body?.messages?.length) {
      return reply
        .code(400)
        .send({ error: { message: "messages is required" } });
    }

    const userId = req.tenureUserId;

    const requestedModel = body.model;
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: "model is required" } });
    }

    const tierResult = checkModelTier(requestedModel);
    if (!tierResult.supported && tierResult.family !== null) {
      return reply.code(422).send({
        error: {
          message: tierResult.reason,
          type: "model_not_supported",
          supported_families: listSupportedFamilies()
        }
      });
    }
    const tierWarning = !tierResult.supported
      ? `Model "${requestedModel}" is not in a verified tier. Sidecar extraction may be unreliable.`
      : null;

    let adapter: OpenAIAdapter;
    try {
      adapter = deps.providers.detectFromModel(
        requestedModel,
        "openai"
      ) as unknown as OpenAIAdapter;
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) {
        return reply.code(502).send({
          error: {
            message: `No credentials for provider detected from model "${requestedModel}"`,
            type: "provider_not_configured"
          }
        });
      }
      throw e;
    }

    const {
      model,
      messages,
      stream,
      temperature,
      max_tokens,
      user,
      metadata,
      ...passThrough
    } = body;

    const adapterBody: Record<string, unknown> = {
      ...passThrough,
      ...(temperature !== undefined && { temperature }),
      ...(max_tokens !== undefined && { max_tokens })
    };

    let sessionId: string;
    try {
      sessionId =
        metadata?.session_id ??
        (req.headers["x-session-id"] as string | undefined) ??
        deriveSessionId(messages as Message[], userId, undefined);
    } catch (err) {
      req.log.warn({ err }, "session derivation failed — using random UUID");
      sessionId = randomUUID();
    }

    let ocAgentId =
      (req.headers["x-agent-id"] as string | undefined)?.trim().toLowerCase() ||
      undefined;

    let session: (Session & { providerId: string; model: string }) | null =
      null;
    try {
      const raw = await deps.sessions.getOrCreate(sessionId, userId);
      const needsBind =
        !raw.providerId || !raw.model || raw.model !== requestedModel;

      if (needsBind) {
        const updated = await deps.sessions.update(sessionId, userId, {
          providerId: adapter.id,
          model: requestedModel
        });
        if (updated?.providerId && updated?.model) {
          session = updated as Session & { providerId: string; model: string };
        }
      } else {
        session = raw as Session & { providerId: string; model: string };
      }
    } catch (err) {
      req.log.warn(
        { err, sessionId },
        "session load failed — proceeding without session"
      );
    }

    let scope = metadata?.scope?.length
      ? metadata.scope
      : (session?.activeScope ?? []);

    const requestId = randomUUID();
    const rawContent: string | ContentPart[] = messages.at(-1)?.content ?? "";
    const latestUserMessage = extractLatestUserText(messages);

    const cfg = await deps.runtimeStore.load().catch(() => ({
      extraction_enabled: true,
      injection_enabled: true,
      scope_auto_detect: true
    }));

    const client = parseClient(req.headers["user-agent"] as string | undefined);

    const rawContentText =
      typeof rawContent === "string" ? rawContent : extractText(rawContent);

    const sessionIntercepted = await tryInterceptSessionCommand(
      rawContentText,
      userId,
      deps,
      req.log
    );

    if (sessionIntercepted) {
      sessionId = sessionIntercepted.sessionId;
      ocAgentId = sessionIntercepted.agentId;
      try {
        const raw = await deps.sessions.getOrCreate(sessionId, userId);
        const needsBind =
          !raw.providerId || !raw.model || raw.model !== requestedModel;
        if (needsBind) {
          const updated = await deps.sessions.update(sessionId, userId, {
            providerId: adapter.id,
            model: requestedModel
          });
          if (updated?.providerId && updated?.model) {
            session = updated as Session & {
              providerId: string;
              model: string;
            };
          }
        } else {
          session = raw as Session & { providerId: string; model: string };
        }
      } catch (err) {
        req.log.warn(
          { err, sessionId },
          "session reload after !session failed"
        );
      }
    }

    const intercepted = await tryInterceptScopeCommand(
      rawContentText,
      sessionId,
      userId,
      deps,
      req.log
    );

    if (intercepted) {
      if (tierWarning) reply.header("x-tenure-warning", tierWarning);
      return reply.send({
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: intercepted.message },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        tenure: {
          session_id: sessionId,
          request_id: requestId,
          scope: intercepted.newScope,
          parse_status: "missing",
          degraded: false,
          context: { beliefs: 0, questions: 0, compacted_turns: 0 }
        }
      });
    }

    const extractIntercepted = await tryInterceptExtractCommand(
      rawContentText,
      sessionId,
      userId,
      { sessions: deps.sessions, runtimeStore: deps.runtimeStore },
      req.log
    );

    if (extractIntercepted) {
      if (tierWarning) reply.header("x-tenure-warning", tierWarning);
      return reply.send({
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: extractIntercepted.message },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        tenure: {
          session_id: sessionId,
          request_id: requestId,
          scope,
          parse_status: "missing",
          degraded: false,
          context: { beliefs: 0, questions: 0, compacted_turns: 0 }
        }
      });
    }

    const injectIntercepted = await tryInterceptInjectCommand(
      rawContentText,
      sessionId,
      userId,
      { sessions: deps.sessions, runtimeStore: deps.runtimeStore },
      req.log
    );

    if (injectIntercepted) {
      if (tierWarning) reply.header("x-tenure-warning", tierWarning);
      return reply.send({
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: injectIntercepted.message },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        tenure: {
          session_id: sessionId,
          request_id: requestId,
          scope,
          parse_status: "missing",
          degraded: false,
          context: { beliefs: 0, questions: 0, compacted_turns: 0 }
        }
      });
    }

    scope = await resolveScope({
      ocAgentId,
      sessionScope: scope,
      session,
      sessionId,
      userId,
      deps,
      logger: req.log
    });

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

    const noExtractHeader =
      req.headers["x-tenure-no-extract"] === "true" ||
      req.headers["x-tenure-no-extract"] === "1";

    const bootstrapInProgress =
      req.headers["x-tenure-bootstrapping"] === "1" ||
      req.headers["x-tenure-bootstrapping"] === "true";

    const isIdeTurn =
      req.headers["x-tenure-ide"] === "1" ||
      req.headers["x-tenure-ide"] === "true";

    const ideExtractionEnabled = (cfg as any).ide_extraction_enabled !== false;

    const extractionEnabled =
      cfg.extraction_enabled !== false &&
      session?.extractionPaused !== true &&
      !noExtractHeader &&
      !bootstrapInProgress &&
      (isIdeTurn ? ideExtractionEnabled : true);

    const injectionEnabled =
      cfg.injection_enabled !== false &&
      session?.injectionPaused !== true &&
      !bootstrapInProgress;

    const extractionMode: "standard" | "ide" = isIdeTurn ? "ide" : "standard";

    const agentId = ocAgentId && ocAgentId !== "main" ? ocAgentId : null;

    const beliefCtx = await deps.context
      .build(userId, scope, latestUserMessage, agentId)
      .catch((err) => {
        req.log.warn({ err }, "context assembly failed");
        return EMPTY_CONTEXT;
      });

    const incomingSystem = messages.find((m) => m.role === "system")?.content;
    const incomingSystemText =
      incomingSystem === undefined
        ? undefined
        : typeof incomingSystem === "string"
          ? incomingSystem
          : extractText(incomingSystem);

    let ideScope: {
      projectScope: string | null;
      languageScope: string | null;
    } | null = null;

    if (isIdeTurn) {
      const headerProject = req.headers["x-tenure-project"] as
        | string
        | undefined;
      const headerLanguage = req.headers["x-tenure-language"] as
        | string
        | undefined;

      ideScope = {
        projectScope: headerProject
          ? `project:${headerProject
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "")}`
          : null,
        languageScope: headerLanguage
          ? `domain:code/${headerLanguage.toLowerCase()}`
          : null
      };

      if (!ideScope.projectScope && deps.workspaceState) {
        ideScope.projectScope = deps.workspaceState.resolveProjectScope(userId);
        ideScope.languageScope =
          ideScope.languageScope ??
          deps.workspaceState.resolveLanguageScope(userId);
      }
    }

    let systemPrompt: SystemPrompt;
    try {
      systemPrompt = buildSystemPrompt({
        incomingSystem: incomingSystemText,
        beliefCtx: injectionEnabled ? beliefCtx : EMPTY_CONTEXT,
        extractionEnabled,
        injectionEnabled,
        activeScope: scope[0],
        extractionMode,
        ideScope
      });
    } catch (err) {
      req.log.error(
        { err },
        "system prompt build failed — falling back to raw"
      );
      const fallback = messages.find((m) => m.role === "system")?.content ?? "";
      systemPrompt = typeof fallback === "string" ? fallback : "";
    }

    if (deps.injectionAudit && beliefCtx.beliefCount > 0) {
      deps.injectionAudit.log({
        userId,
        sessionId,
        requestId,
        userQuery: latestUserMessage,
        expandedQuery: beliefCtx.expandedQuery,
        scope,
        agentId,
        tokenId: req.tenureTokenId ?? null,
        tokenName: req.tenureTokenName ?? null,
        tokenKind: req.tenureTokenKind ?? null,
        injected: injectionEnabled,
        beliefCtx
      });
    }

    const passMessages = messages.filter(
      (m) => m.role !== "system"
    ) as Message[];

    const ideLanguageScope = ideScope?.languageScope ?? null;
    const ideActiveFile = deps.workspaceState?.get(userId)?.active_file ?? null;

    if (stream && (adapter as { callStream?: unknown }).callStream) {
      return handleStreamingResponse(
        reply,
        adapter,
        requestedModel,
        systemPrompt,
        passMessages,
        adapterBody,
        {
          requestId,
          sessionId,
          userId,
          tokenId: req.tenureTokenId ?? "root",
          tokenName: req.tenureTokenName ?? "",
          tokenKind: req.tenureTokenKind ?? "root",
          requestedModel,
          latestUserMessage,
          rawContent,
          scope,
          deps,
          session,
          adapter,
          tierWarning,
          logger: req.log,
          extractionEnabled,
          client,
          agentId,
          extractionMode,
          ideProjectScope: ideScope?.projectScope ?? null,
          ideLanguageScope,
          ideActiveFile
        }
      );
    }

    let providerResp: Awaited<ReturnType<OpenAIAdapter["call"]>>;
    try {
      providerResp = await adapter.call(
        requestedModel,
        systemPrompt,
        passMessages,
        adapterBody
      );
    } catch (e) {
      const reason = (e as Error).message;

      deps.errorLogger
        .log({
          severity: "error",
          stage: "provider_call",
          message: reason.slice(0, 500),
          error: e instanceof Error ? e : new Error(reason),
          user_id: userId,
          actor_id: userId,
          session_id: sessionId,
          request_id: requestId,
          provider: adapter.id,
          model: requestedModel,
          user_impacted: true,
          passthrough_succeeded: false
        })
        .catch(() => {});

      return reply.code(502).send({
        error: { message: (e as Error).message, type: "provider_error" }
      });
    }

    const { visible, sidecarRaw, parseStatus } = splitSidecar(
      providerResp.content ?? ""
    );

    if (tierWarning) reply.header("x-tenure-warning", tierWarning);

    const messagePayload: Record<string, unknown> = {
      role: "assistant",
      content: visible
    };
    if (providerResp.toolCalls?.length) {
      messagePayload.tool_calls = providerResp.toolCalls;
    }

    reply.send({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: providerResp.model,
      choices: [
        {
          index: 0,
          message: messagePayload,
          finish_reason: providerResp.finish_reason
        }
      ],
      usage: {
        prompt_tokens: providerResp.usage.input_tokens,
        completion_tokens: providerResp.usage.output_tokens,
        total_tokens:
          providerResp.usage.input_tokens + providerResp.usage.output_tokens
      }
    });

    try {
      if (!req.tenureTokenId || !req.tenureTokenKind) {
        throw new Error("missing token attribution for side effects");
      }

      runSideEffects({
        deps,
        userId,
        sessionId,
        requestId,
        latestUserMessage,
        visible,
        rawContent,
        sidecarRaw,
        parseStatus,
        scope,
        adapter,
        model: providerResp.model,
        session,
        logger: req.log,
        extractionEnabled,
        client,
        agentId,
        tokenId: req.tenureTokenId,
        tokenName: req.tenureTokenName ?? "",
        tokenKind: req.tenureTokenKind,
        extractionMode,
        ideProjectScope: ideScope?.projectScope ?? null,
        ideLanguageScope: ideScope?.languageScope ?? null,
        ideActiveFile: deps.workspaceState?.get(userId)?.active_file ?? null
      });
    } catch (err) {
      req.log.error(
        { err, sessionId, requestId },
        "side effects failed — response still delivered"
      );
    }
  });
}

interface StreamingCtx {
  requestId: string;
  sessionId: string;
  userId: string;
  tokenId: string;
  tokenName: string;
  tokenKind: "client" | "agent" | "root";
  requestedModel: string;
  latestUserMessage: string;
  rawContent: string | ContentPart[];
  scope: string[];
  deps: ChatDeps;
  session: (Session & { providerId: string; model: string }) | null;
  adapter: OpenAIAdapter;
  tierWarning: string | null;
  logger: FastifyBaseLogger;
  extractionEnabled: boolean;
  client: ParsedClient;
  agentId: string | null;
  extractionMode: "standard" | "ide";
  ideProjectScope: string | null;
  ideLanguageScope: string | null;
  ideActiveFile: string | null;
}

async function handleStreamingResponse(
  reply: FastifyReply,
  adapter: OpenAIAdapter,
  model: string,
  systemPrompt: SystemPrompt,
  messages: Message[],
  body: Record<string, unknown>,
  ctx: StreamingCtx
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;

  raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
    ...(ctx.tierWarning ? { "x-tenure-warning": ctx.tierWarning } : {})
  });

  const sseId = `chatcmpl-${ctx.requestId}`;
  const HOLDBACK = SIDECAR_BEGIN.length;

  let fullContent = "";
  let flushedIdx = 0;
  let sidecarDetected = false;
  let resolvedModel = model;
  let streamFinishReason = "stop";
  let streamUsage = { input_tokens: 0, output_tokens: 0 };

  writeSSE(raw, {
    id: sseId,
    object: "chat.completion.chunk",
    created: ts(),
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null
      }
    ]
  });

  const abortController = new AbortController();
  raw.on("close", () => abortController.abort());

  const heartbeat = setInterval(() => {
    if (!raw.writableEnded && !abortController.signal.aborted) {
      raw.write(": keep-alive\n\n");
    }
  }, 15_000);

  try {
    for await (const event of adapter.callStream(
      model,
      systemPrompt,
      messages,
      body,
      abortController.signal
    )) {
      if (abortController.signal.aborted) break;

      if (event.type === "stream_end") {
        resolvedModel = event.model ?? model;
        streamFinishReason = event.finish_reason ?? "stop";
        streamUsage = event.usage ?? streamUsage;
        continue;
      }

      if (event.type !== "content_delta") {
        continue;
      }

      fullContent += event.delta;

      if (sidecarDetected) continue;
      const markerIdx = fullContent.indexOf(SIDECAR_BEGIN);
      if (markerIdx !== -1) {
        const remaining = fullContent.slice(flushedIdx, markerIdx);
        if (remaining) {
          writeSSE(raw, {
            id: sseId,
            object: "chat.completion.chunk",
            created: ts(),
            model,
            choices: [
              {
                index: 0,
                delta: { content: remaining },
                finish_reason: null
              }
            ]
          });
        }
        flushedIdx = markerIdx;
        sidecarDetected = true;
      } else {
        const safeEnd = fullContent.length - HOLDBACK;
        if (safeEnd > flushedIdx) {
          writeSSE(raw, {
            id: sseId,
            object: "chat.completion.chunk",
            created: ts(),
            model,
            choices: [
              {
                index: 0,
                delta: { content: fullContent.slice(flushedIdx, safeEnd) },
                finish_reason: null
              }
            ]
          });
          flushedIdx = safeEnd;
        }
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      raw.end();
      return;
    }

    const message = (err as Error).message;

    ctx.deps.errorLogger
      .log({
        severity: "error",
        stage: "provider_call",
        message: message.slice(0, 500),
        error: err instanceof Error ? err : new Error(message),
        user_id: ctx.userId,
        actor_id: ctx.userId,
        session_id: ctx.sessionId,
        request_id: ctx.requestId,
        provider: ctx.adapter.id,
        model: ctx.requestedModel,
        user_impacted: true,
        passthrough_succeeded: false
      })
      .catch(() => {});

    ctx.logger.error(
      {
        err,
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        userId: ctx.userId,
        partialContent: fullContent,
        partialLength: fullContent.length
      },
      "streaming provider error — no turn persisted"
    );
    writeSSE(raw, { error: { message, type: "provider_error" } });
    raw.write("data: [DONE]\n\n");
    raw.end();
    return;
  } finally {
    clearInterval(heartbeat);
  }

  if (abortController.signal.aborted) {
    raw.end();
    return;
  }

  if (!sidecarDetected && flushedIdx < fullContent.length) {
    writeSSE(raw, {
      id: sseId,
      object: "chat.completion.chunk",
      created: ts(),
      model: resolvedModel,
      choices: [
        {
          index: 0,
          delta: { content: fullContent.slice(flushedIdx) },
          finish_reason: null
        }
      ]
    });
  }

  writeSSE(raw, {
    id: sseId,
    object: "chat.completion.chunk",
    created: ts(),
    model: resolvedModel,
    choices: [{ index: 0, delta: {}, finish_reason: streamFinishReason }],
    usage: {
      prompt_tokens: streamUsage.input_tokens,
      completion_tokens: streamUsage.output_tokens,
      total_tokens: streamUsage.input_tokens + streamUsage.output_tokens
    }
  });

  raw.write("data: [DONE]\n\n");
  raw.end();

  const { visible, sidecarRaw, parseStatus } = splitSidecar(fullContent);

  runSideEffects({
    deps: ctx.deps,
    userId: ctx.userId,
    agentId: ctx.agentId,
    tokenId: ctx.tokenId,
    tokenName: ctx.tokenName,
    tokenKind: ctx.tokenKind,
    sessionId: ctx.sessionId,
    requestId: ctx.requestId,
    latestUserMessage: ctx.latestUserMessage,
    visible,
    rawContent: ctx.rawContent,
    sidecarRaw,
    parseStatus,
    scope: ctx.scope,
    adapter: ctx.adapter,
    model,
    session: ctx.session,
    logger: ctx.logger,
    extractionEnabled: ctx.extractionEnabled,
    client: ctx.client,
    extractionMode: ctx.extractionMode,
    ideProjectScope: ctx.ideProjectScope,
    ideLanguageScope: ctx.ideLanguageScope,
    ideActiveFile: ctx.ideActiveFile
  });
}

async function writeSSE(raw: ServerResponse, data: unknown): Promise<void> {
  const record = data as Record<string, unknown>;
  const idLine = typeof record.id === "string" ? `id: ${record.id}\n` : "";
  const ok = raw.write(`${idLine}data: ${JSON.stringify(data)}\n\n`);
  if (!ok) {
    await new Promise<void>((resolve) => raw.once("drain", resolve));
  }
}

function ts(): number {
  return Math.floor(Date.now() / 1000);
}

async function resolveScope(args: ResolveScopeArgs): Promise<string[]> {
  const { ocAgentId, sessionScope, session, sessionId, userId, deps, logger } =
    args;

  if (ocAgentId && ocAgentId !== "main") {
    const currentAgentId = (session as any)?.agentId;
    if (currentAgentId !== ocAgentId) {
      await deps.sessions
        .update(sessionId, userId, { agentId: ocAgentId })
        .catch((err) =>
          logger.warn({ err, sessionId }, "agent id persist failed")
        );
    }
  }

  return sessionScope;
}
