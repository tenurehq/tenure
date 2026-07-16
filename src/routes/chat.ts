import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyBaseLogger } from "fastify";
import type { ServerResponse } from "node:http";
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
import { checkModelTier, listSupportedFamilies } from "../providers/tiers.js";
import type { ExtractionWorkerLike } from "../extraction/worker.js";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ErrorLogger } from "../errors/logger.js";
import { parseClient, type ParsedClient } from "../helpers/clientDetector.js";
import type { WorkspaceStateCache } from "../workspace/stateCache.js";
import { buildSystemPrompt } from "../context/systemPromptBuilder.js";
import { runSideEffects } from "./shared/sideEffects.js";
import type { InjectionAuditLogger } from "../audit/injectionAuditLogger.js";
import { assertTokenProjectScopes } from "../server.js";
import {
  tryInterceptScopeCommand,
  tryInterceptExtractCommand,
  tryInterceptInjectCommand
} from "../helpers/scopeDetector.js";

export interface ChatDeps {
  context: ContextBuilder;
  providers: ProviderRegistry;
  jobs: ExtractionJobQueue;
  extractionWorker: ExtractionWorkerLike;
  runtimeStore: RuntimeConfigStore;
  errorLogger: ErrorLogger;
  workspaceState?: WorkspaceStateCache;
  injectionAudit?: InjectionAuditLogger;
  tokenScopes: {
    getActiveScope(userId: string, tokenId: string): Promise<string[] | null>;
    setActiveScope(
      userId: string,
      tokenId: string,
      scope: string[]
    ): Promise<void>;
  };
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
  metadata?: { scope?: string[] };
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

    const requestId = randomUUID();
    const ocAgentId =
      (req.headers["x-agent-id"] as string | undefined)?.trim().toLowerCase() ||
      undefined;
    if (!req.tenureTokenId) {
      return reply.code(401).send({ error: { message: "unauthorized" } });
    }

    const explicitScope = resolveExplicitScope(
      metadata?.scope,
      req.headers["x-tenure-scope"]
    );

    const rawContent: string | ContentPart[] = messages.at(-1)?.content ?? "";
    const latestUserMessage = extractLatestUserText(messages);

    const scopeCommand = await tryInterceptScopeCommand(
      latestUserMessage,
      userId,
      req.tenureTokenId,
      req.tenureTokenProjectScopes,
      deps.tokenScopes,
      req.log
    );
    const extractCommand = await tryInterceptExtractCommand(
      latestUserMessage,
      deps.runtimeStore,
      req.log
    );
    const injectCommand = await tryInterceptInjectCommand(
      latestUserMessage,
      deps.runtimeStore,
      req.log
    );
    const commandMessage =
      scopeCommand?.message ??
      extractCommand?.message ??
      injectCommand?.message;

    if (commandMessage) {
      return reply.send({
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: commandMessage },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }

    const cfg = await deps.runtimeStore.load().catch(() => ({
      extraction_enabled: true,
      injection_enabled: true,
      scope_auto_detect: true
    }));

    const client = parseClient(req.headers["user-agent"] as string | undefined);

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
      req.tenureTokenExtractionEnabled !== false &&
      !noExtractHeader &&
      !bootstrapInProgress &&
      (isIdeTurn ? ideExtractionEnabled : true);

    const injectionEnabled =
      cfg.injection_enabled !== false &&
      req.tenureTokenInjectionEnabled !== false &&
      !bootstrapInProgress;

    const extractionMode: "standard" | "ide" = isIdeTurn ? "ide" : "standard";

    const scopeResolution = await resolveTurnScope({
      tokenId: req.tenureTokenId,
      explicitScope,
      tokenProjectScopes: req.tenureTokenProjectScopes,
      isIdeTurn,
      userId,
      headers: req.headers,
      deps
    });
    const scope = scopeResolution.scope;
    const ideScope = scopeResolution.ideScope;

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
          userId,
          tokenId: req.tenureTokenId ?? "root",
          tokenName: req.tenureTokenName ?? "",
          tokenKind: req.tenureTokenKind ?? "root",
          requestedModel,
          latestUserMessage,
          rawContent,
          scope,
          deps,
          adapter,
          tierWarning: scopeResolution.usedUniversalFallback
            ? "No project scope is selected; using user:universal only."
            : tierWarning,
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

    const warning = scopeResolution.usedUniversalFallback
      ? "No project scope is selected; using user:universal only."
      : tierWarning;
    if (warning) reply.header("x-tenure-warning", warning);

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

      await runSideEffects({
        deps,
        userId,
        agentId,
        requestId,
        latestUserMessage,
        visible,
        rawContent,
        sidecarRaw,
        parseStatus,
        scope,
        adapter,
        model: providerResp.model,
        logger: req.log,
        extractionEnabled,
        client,
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
        { err, requestId },
        "side effects failed — response still delivered"
      );
    }
  });
}

interface StreamingCtx {
  requestId: string;
  userId: string;
  tokenId: string;
  tokenName: string;
  tokenKind: "client" | "agent" | "root";
  requestedModel: string;
  latestUserMessage: string;
  rawContent: string | ContentPart[];
  scope: string[];
  deps: ChatDeps;
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

  await writeSSE(raw, {
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
      if (!raw.writableNeedDrain) raw.write(": keep-alive\n\n");
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

      if (event.type === "tool_call_delta") {
        await writeSSE(raw, {
          id: sseId,
          object: "chat.completion.chunk",
          created: ts(),
          model: resolvedModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: event.toolCallIndex,
                    ...(event.toolCallId !== undefined && {
                      id: event.toolCallId,
                      type: "function"
                    }),
                    function: {
                      ...(event.toolCallName !== undefined && {
                        name: event.toolCallName
                      }),
                      arguments: event.toolCallArguments
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        });
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
          await writeSSE(raw, {
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
          await writeSSE(raw, {
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
        requestId: ctx.requestId,
        userId: ctx.userId,
        partialContent: fullContent,
        partialLength: fullContent.length
      },
      "streaming provider error — no turn persisted"
    );
    await writeSSE(raw, { error: { message, type: "provider_error" } });
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
    await writeSSE(raw, {
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

  await writeSSE(raw, {
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

  await runSideEffects({
    deps: ctx.deps,
    userId: ctx.userId,
    agentId: ctx.agentId,
    tokenId: ctx.tokenId,
    tokenName: ctx.tokenName,
    tokenKind: ctx.tokenKind,
    requestId: ctx.requestId,
    latestUserMessage: ctx.latestUserMessage,
    visible,
    rawContent: ctx.rawContent,
    sidecarRaw,
    parseStatus,
    scope: ctx.scope,
    adapter: ctx.adapter,
    model,
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

function resolveExplicitScope(
  bodyScope: string[] | undefined,
  headerScope: string | string[] | undefined
): string[] {
  const values = bodyScope?.length
    ? bodyScope
    : typeof headerScope === "string"
      ? headerScope.split(",")
      : Array.isArray(headerScope)
        ? headerScope.flatMap((value) => value.split(","))
        : [];

  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export async function resolveTurnScope(args: {
  tokenId: string;
  explicitScope: string[];
  tokenProjectScopes: string[] | null | undefined;
  isIdeTurn: boolean;
  userId: string;
  headers: { [key: string]: string | string[] | undefined };
  deps: ChatDeps;
}): Promise<{
  scope: string[];
  ideScope: {
    projectScope: string | null;
    languageScope: string | null;
  } | null;
  usedUniversalFallback: boolean;
}> {
  if (args.isIdeTurn) {
    const projectHeader = readHeader(args.headers["x-tenure-project"]);
    const languageHeader = readHeader(args.headers["x-tenure-language"]);
    const projectScope = projectHeader
      ? normalizeProjectScope(projectHeader)
      : (args.deps.workspaceState?.resolveProjectScope(args.userId) ?? null);
    const languageScope = languageHeader
      ? `domain:code/${languageHeader.toLowerCase()}`
      : (args.deps.workspaceState?.resolveLanguageScope(args.userId) ?? null);

    if (!projectScope) {
      throw Object.assign(
        new Error("IDE mode requires a resolved project scope"),
        {
          statusCode: 400
        }
      );
    }

    const scope = [projectScope, ...(languageScope ? [languageScope] : [])];
    assertAllowedScope(args.tokenProjectScopes, scope);
    await args.deps.tokenScopes.setActiveScope(
      args.userId,
      args.tokenId,
      scope
    );
    return {
      scope,
      ideScope: { projectScope, languageScope },
      usedUniversalFallback: false
    };
  }

  if (args.explicitScope.length > 0) {
    assertAllowedScope(args.tokenProjectScopes, args.explicitScope);
    await args.deps.tokenScopes.setActiveScope(
      args.userId,
      args.tokenId,
      args.explicitScope
    );
    return {
      scope: args.explicitScope,
      ideScope: null,
      usedUniversalFallback: false
    };
  }

  const activeScope = await args.deps.tokenScopes.getActiveScope(
    args.userId,
    args.tokenId
  );
  if (activeScope?.length) {
    assertAllowedScope(args.tokenProjectScopes, activeScope);
    return { scope: activeScope, ideScope: null, usedUniversalFallback: false };
  }

  if (args.tokenProjectScopes?.length === 1) {
    const scope = [args.tokenProjectScopes[0]];
    await args.deps.tokenScopes.setActiveScope(
      args.userId,
      args.tokenId,
      scope
    );
    return { scope, ideScope: null, usedUniversalFallback: false };
  }

  return {
    scope: ["user:universal"],
    ideScope: null,
    usedUniversalFallback: true
  };
}

function readHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}

function normalizeProjectScope(value: string): string {
  const raw = value.startsWith("project:") ? value.slice(8) : value;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `project:${normalized}`;
}

function assertAllowedScope(
  allowed: string[] | null | undefined,
  scope: string[]
): void {
  if (allowed == null) return;
  if (
    scope.some(
      (value) => value.startsWith("project:") && !allowed.includes(value)
    )
  ) {
    throw Object.assign(
      new Error(
        "Token is not authorized for one or more requested project scopes"
      ),
      { statusCode: 403 }
    );
  }
}
