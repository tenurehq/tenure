import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { resolveTurnScope, type ChatDeps } from "./chat.js";
import { ProviderNotConfiguredError } from "../providers/registry.js";
import { checkModelTier, listSupportedFamilies } from "../providers/tiers.js";
import type { Message, ContentPart, SystemPrompt } from "../providers/types.js";
import { splitSidecar, SIDECAR_BEGIN } from "../sidecar/splitter.js";
import { parseClient } from "../helpers/clientDetector.js";
import { EMPTY_CONTEXT } from "../context/contextBuilder.js";
import { buildSystemPrompt } from "../context/systemPromptBuilder.js";
import {
  AnthropicAdapter,
  type AnthropicCallRequest,
  type AnthropicCallResponse
} from "../providers/anthropic.js";
import { runSideEffects } from "./shared/sideEffects.js";
import { extractLatestUserText } from "../helpers/content.js";
import { assertTokenProjectScopes } from "../server.js";
import {
  tryInterceptScopeCommand,
  tryInterceptExtractCommand,
  tryInterceptInjectCommand
} from "../helpers/scopeDetector.js";

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicRequestBody {
  model: string;
  messages: unknown[];
  system?: string | AnthropicSystemBlock[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  metadata?: { user_id?: string; scope?: string[] };
  [key: string]: unknown;
}

interface AnthropicTextOutputBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseOutputBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicOutputBlock =
  | AnthropicTextOutputBlock
  | AnthropicToolUseOutputBlock;

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicOutputBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

function extractSystemText(
  system: string | AnthropicSystemBlock[] | undefined
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system.trim() || undefined;
  return (
    system
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim() || undefined
  );
}

function mapStopReasonToAnthropic(
  finishReason: string
): "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

function buildAnthropicResponse(
  messageId: string,
  model: string,
  visibleText: string,
  finishReason: string,
  usage: { input_tokens: number; output_tokens: number },
  toolUses?: AnthropicToolUseOutputBlock[]
): AnthropicResponse {
  const content: AnthropicOutputBlock[] = [];

  if (visibleText) {
    content.push({ type: "text", text: visibleText });
  }

  if (toolUses?.length) {
    for (const tu of toolUses) {
      content.push(tu);
    }
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: mapStopReasonToAnthropic(finishReason),
    stop_sequence: null,
    usage
  };
}

async function writeAnthropicSSE(
  raw: import("node:http").ServerResponse,
  eventType: string,
  data: unknown
): Promise<void> {
  const ok = raw.write(
    `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
  );
  if (!ok) {
    await new Promise<void>((resolve) => raw.once("drain", resolve));
  }
}

export function registerMessagesRoute(
  app: FastifyInstance,
  deps: ChatDeps
): void {
  app.post<{ Body: AnthropicRequestBody }>(
    "/v1/messages",
    async (req, reply) => {
      const body = req.body;

      if (!body?.messages?.length) {
        return reply.code(400).send({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "messages is required"
          }
        });
      }

      const requestedModel = body.model;
      if (!requestedModel) {
        return reply.code(400).send({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "model is required"
          }
        });
      }

      const tierResult = checkModelTier(requestedModel);
      if (!tierResult.supported && tierResult.family !== null) {
        return reply.code(422).send({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: tierResult.reason,
            supported_families: listSupportedFamilies()
          }
        });
      }

      const tierWarning = !tierResult.supported
        ? `Model "${requestedModel}" is not in a verified tier.`
        : null;

      let adapter: AnthropicAdapter;
      try {
        adapter = deps.providers.detectFromModel(
          requestedModel,
          "anthropic"
        ) as unknown as AnthropicAdapter;
      } catch (e) {
        if (e instanceof ProviderNotConfiguredError) {
          return reply.code(401).send({
            type: "error",
            error: {
              type: "authentication_error",
              message: `No credentials for provider detected from model "${requestedModel}"`
            }
          });
        }
        throw e;
      }

      const userId = req.tenureUserId;

      const requestId = randomUUID();

      const systemText = extractSystemText(body.system);
      const latestUserMessage = extractLatestUserText(
        body.messages as Message[]
      );

      const ocAgentId =
        (req.headers["x-agent-id"] as string | undefined)
          ?.trim()
          .toLowerCase() || undefined;
      if (!req.tenureTokenId) {
        return reply.code(401).send({
          type: "error",
          error: { type: "authentication_error", message: "unauthorized" }
        });
      }

      const explicitScope = resolveExplicitScope(
        body.metadata?.scope,
        req.headers["x-tenure-scope"]
      );

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
        scopeCommand?.message ?? extractCommand?.message ?? injectCommand?.message;

      if (commandMessage) {
        return reply.send(
          buildAnthropicResponse(
            `msg_${requestId}`,
            requestedModel,
            commandMessage,
            "stop",
            { input_tokens: 0, output_tokens: 0 }
          )
        );
      }

      const cfg = await deps.runtimeStore.load().catch(() => ({
        extraction_enabled: true,
        injection_enabled: true,
        scope_auto_detect: true
      }));

      const client = parseClient(
        req.headers["user-agent"] as string | undefined
      );


      const noExtractHeader = req.headers["x-tenure-no-extract"] === "true";
      const bootstrapInProgress = req.headers["x-tenure-bootstrapping"] === "1";
      const isIdeTurn = req.headers["x-tenure-ide"] === "1";
      const ideExtractionEnabled =
        (cfg as any).ide_extraction_enabled !== false;

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
          type: "error",
          error: {
            type: "permission_error",
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


      let systemPrompt: SystemPrompt;
      try {
        systemPrompt = buildSystemPrompt({
          incomingSystem: systemText,
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
        systemPrompt = systemText ?? "";
      }

      if (deps.injectionAudit && beliefCtx.beliefCount > 0) {
        deps.injectionAudit
          .log({
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
          })
          .catch((err) =>
            req.log.warn({ err, requestId }, "injection audit write failed")
          );
      }

      const {
        system: _system,
        stream,
        metadata: _metadata,
        model: _model,
        messages,
        temperature,
        max_tokens,
        ...extraFields
      } = body;

      const normalizedReq: AnthropicCallRequest = {
        model: requestedModel,
        messages: messages as Message[],
        ...(temperature !== undefined && { temperature }),
        ...(max_tokens !== undefined && { max_tokens }),
        ...(Object.keys(extraFields).length > 0 && {
          passThrough: extraFields
        })
      };

      const rawContent =
        (body.messages.at(-1) as { content?: string | ContentPart[] })
          ?.content ?? "";

      if (stream) {
        return handleAnthropicStream(
          reply,
          adapter,
          normalizedReq,
          systemPrompt,
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
            ideLanguageScope: ideScope?.languageScope ?? null,
            ideActiveFile: deps.workspaceState?.get(userId)?.active_file ?? null
          }
        );
      }

      let providerResp: AnthropicCallResponse;
      try {
        providerResp = await adapter.call(normalizedReq, systemPrompt);
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
          type: "error",
          error: { type: "api_error", message: reason }
        });
      }

      const { visible, sidecarRaw, parseStatus } = splitSidecar(
        providerResp.content ?? ""
      );

      const warning = scopeResolution.usedUniversalFallback
        ? "No project scope is selected; using user:universal only."
        : tierWarning;
      if (warning) reply.header("x-tenure-warning", warning);

      reply.send(
        buildAnthropicResponse(
          `msg_${requestId}`,
          providerResp.model,
          visible,
          providerResp.finish_reason,
          {
            input_tokens: providerResp.usage.input_tokens,
            output_tokens: providerResp.usage.output_tokens
          },
          providerResp.toolUses
        )
      );

      if (!req.tenureTokenId || !req.tenureTokenKind) {
        throw new Error("missing token attribution for side effects");
      }

      await runSideEffects({
        deps,
        userId,
        agentId,
        tokenId: req.tenureTokenId,
        tokenName: req.tenureTokenName ?? "",
        tokenKind: req.tenureTokenKind,
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
        extractionMode,
        ideProjectScope: ideScope?.projectScope ?? null,
        ideLanguageScope: ideScope?.languageScope ?? null,
        ideActiveFile: deps.workspaceState?.get(userId)?.active_file ?? null
      });
    }
  );
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
  adapter: AnthropicAdapter;
  tierWarning: string | null;
  logger: import("fastify").FastifyBaseLogger;
  extractionEnabled: boolean;
  client: ReturnType<typeof parseClient>;
  agentId: string | null;
  extractionMode: "standard" | "ide";
  ideProjectScope: string | null;
  ideLanguageScope: string | null;
  ideActiveFile: string | null;
}

async function handleAnthropicStream(
  reply: import("fastify").FastifyReply,
  adapter: AnthropicAdapter,
  normalizedReq: Parameters<AnthropicAdapter["call"]>[0],
  systemPrompt: SystemPrompt,
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

  const messageId = `msg_${ctx.requestId}`;
  const HOLDBACK = SIDECAR_BEGIN.length;

  let messageStarted = false;
  const startMessage = async (
    model: string,
    inputTokens: number
  ): Promise<void> => {
    if (messageStarted) return;
    messageStarted = true;
    await writeAnthropicSSE(raw, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 }
      }
    });
  };

  await writeAnthropicSSE(raw, "ping", { type: "ping" });

  let fullContent = "";
  let flushedIdx = 0;
  let sidecarDetected = false;
  let finalModel = ctx.requestedModel;
  let finishReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };

  let nextBlockIndex = 0;
  let currentTextBlockIndex = -1;
  let currentToolBlockIndex = -1;
  let activeBlockIndex = -1;

  const abortController = new AbortController();
  raw.on("close", () => abortController.abort());

  const heartbeat = setInterval(() => {
    if (!raw.writableEnded && !abortController.signal.aborted) {
      if (!raw.writableNeedDrain) raw.write(": keep-alive\n\n");
    }
  }, 15_000);

  try {
    for await (const event of adapter.callStream(
      { ...normalizedReq, abortSignal: abortController.signal },
      systemPrompt
    )) {
      if (abortController.signal.aborted) break;

      if (event.type === "message_start") {
        finalModel = event.model;
        usage.input_tokens = event.input_tokens;
        await startMessage(event.model, event.input_tokens);
        continue;
      }

      if (!messageStarted) {
        await startMessage(finalModel, usage.input_tokens);
      }

      if (event.type === "content_delta" && event.delta) {
        fullContent += event.delta;

        if (sidecarDetected) continue;

        if (currentTextBlockIndex === -1) {
          currentTextBlockIndex = nextBlockIndex;
          activeBlockIndex = nextBlockIndex;
          nextBlockIndex++;
          await writeAnthropicSSE(raw, "content_block_start", {
            type: "content_block_start",
            index: currentTextBlockIndex,
            content_block: { type: "text", text: "" }
          });
        }

        const markerIdx = fullContent.indexOf(SIDECAR_BEGIN);
        if (markerIdx !== -1) {
          const remaining = fullContent.slice(flushedIdx, markerIdx);
          if (remaining) {
            await writeAnthropicSSE(raw, "content_block_delta", {
              type: "content_block_delta",
              index: currentTextBlockIndex,
              delta: { type: "text_delta", text: remaining }
            });
          }
          flushedIdx = markerIdx;
          sidecarDetected = true;
        } else {
          const safeEnd = fullContent.length - HOLDBACK;
          if (safeEnd > flushedIdx) {
            await writeAnthropicSSE(raw, "content_block_delta", {
              type: "content_block_delta",
              index: currentTextBlockIndex,
              delta: {
                type: "text_delta",
                text: fullContent.slice(flushedIdx, safeEnd)
              }
            });
            flushedIdx = safeEnd;
          }
        }
      }

      if (event.type === "text_block_start") {
        if (activeBlockIndex !== -1) {
          await writeAnthropicSSE(raw, "content_block_stop", {
            type: "content_block_stop",
            index: activeBlockIndex
          });
        }
        currentTextBlockIndex = nextBlockIndex;
        activeBlockIndex = nextBlockIndex;
        nextBlockIndex++;
        await writeAnthropicSSE(raw, "content_block_start", {
          type: "content_block_start",
          index: currentTextBlockIndex,
          content_block: { type: "text", text: "" }
        });
      }

      if (event.type === "tool_use_start") {
        if (activeBlockIndex !== -1) {
          await writeAnthropicSSE(raw, "content_block_stop", {
            type: "content_block_stop",
            index: activeBlockIndex
          });
        }

        currentToolBlockIndex = nextBlockIndex;
        activeBlockIndex = nextBlockIndex;
        nextBlockIndex++;

        await writeAnthropicSSE(raw, "content_block_start", {
          type: "content_block_start",
          index: currentToolBlockIndex,
          content_block: {
            type: "tool_use",
            id: event.id ?? `toolu_${randomUUID()}`,
            name: event.name ?? "",
            input: {}
          }
        });
      }

      if (event.type === "tool_use_delta") {
        if (currentToolBlockIndex === -1) continue;

        await writeAnthropicSSE(raw, "content_block_delta", {
          type: "content_block_delta",
          index: currentToolBlockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: event.partialJson
          }
        });
      }

      if (event.type === "stream_end") {
        if (event.model) finalModel = event.model;
        if (event.finish_reason) {
          finishReason = mapStopReasonToAnthropic(event.finish_reason);
        }
        if (event.usage) usage = event.usage;
      }
    }
  } catch (err) {
    clearInterval(heartbeat);

    if (!abortController.signal.aborted) {
      ctx.deps.errorLogger
        .log({
          severity: "error",
          stage: "provider_call",
          message: (err as Error).message.slice(0, 500),
          error: err instanceof Error ? err : new Error((err as Error).message),
          user_id: ctx.userId,
          actor_id: ctx.userId,
          request_id: ctx.requestId,
          provider: ctx.adapter.id,
          model: ctx.requestedModel,
          user_impacted: true,
          passthrough_succeeded: false
        })
        .catch(() => {});

      await writeAnthropicSSE(raw, "error", {
        type: "error",
        error: { type: "api_error", message: (err as Error).message }
      });
    }

    raw.end();
    return;
  } finally {
    clearInterval(heartbeat);
  }

  if (abortController.signal.aborted) {
    raw.end();
    return;
  }

  await startMessage(finalModel, usage.input_tokens);

  if (!sidecarDetected && flushedIdx < fullContent.length) {
    await writeAnthropicSSE(raw, "content_block_delta", {
      type: "content_block_delta",
      index: currentTextBlockIndex,
      delta: {
        type: "text_delta",
        text: fullContent.slice(flushedIdx)
      }
    });
  }

  if (activeBlockIndex !== -1) {
    await writeAnthropicSSE(raw, "content_block_stop", {
      type: "content_block_stop",
      index: activeBlockIndex
    });
  }

  await writeAnthropicSSE(raw, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: finishReason, stop_sequence: null },
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens
    }
  });

  await writeAnthropicSSE(raw, "message_stop", { type: "message_stop" });

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
    model: finalModel,
    logger: ctx.logger,
    extractionEnabled: ctx.extractionEnabled,
    client: ctx.client,
    extractionMode: ctx.extractionMode,
    ideProjectScope: ctx.ideProjectScope,
    ideLanguageScope: ctx.ideLanguageScope,
    ideActiveFile: ctx.ideActiveFile
  });
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
