import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ChatDeps } from "./chat.js";
import { ProviderNotConfiguredError } from "../providers/registry.js";
import { checkModelTier, listSupportedFamilies } from "../providers/tiers.js";
import { deriveSessionId } from "../session/derivation.js";
import type { Message, ContentPart, SystemPrompt } from "../providers/types.js";
import { splitSidecar, SIDECAR_BEGIN } from "../sidecar/splitter.js";
import { parseClient } from "../helpers/clientDetector.js";
import {
  tryInterceptScopeCommand,
  tryInterceptExtractCommand,
  tryInterceptInjectCommand,
  tryInterceptSessionCommand,
  detectScopeFromMessage,
  fetchExistingUserScopes,
} from "../helpers/scopeDetector.js";
import type { Session } from "../session/manager.js";
import { EMPTY_CONTEXT } from "../context/contextBuilder.js";
import { buildSystemPrompt } from "../context/systemPromptBuilder.js";
import {
  AnthropicAdapter,
  type AnthropicCallRequest,
  type AnthropicCallResponse,
} from "../providers/anthropic.js";
import { runSideEffects } from "./shared/sideEffects.js";
import { extractLatestUserText } from "../helpers/content.js";

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
  metadata?: { user_id?: string; session_id?: string };
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
  system: string | AnthropicSystemBlock[] | undefined,
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
  finishReason: string,
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
  toolCalls?: unknown[],
): AnthropicResponse {
  const content: AnthropicOutputBlock[] = [];

  if (visibleText) {
    content.push({ type: "text", text: visibleText });
  }

  if (toolCalls?.length) {
    for (const tc of toolCalls as Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
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
    usage,
  };
}

function writeAnthropicSSE(
  raw: import("node:http").ServerResponse,
  eventType: string,
  data: unknown,
): void {
  raw.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerMessagesRoute(
  app: FastifyInstance,
  deps: ChatDeps,
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
            message: "messages is required",
          },
        });
      }

      const requestedModel = body.model;
      if (!requestedModel) {
        return reply.code(400).send({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "model is required",
          },
        });
      }

      const tierResult = checkModelTier(requestedModel);
      if (!tierResult.supported && tierResult.family !== null) {
        return reply.code(422).send({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: tierResult.reason,
            supported_families: listSupportedFamilies(),
          },
        });
      }

      const tierWarning = !tierResult.supported
        ? `Model "${requestedModel}" is not in a verified tier.`
        : null;

      let adapter: AnthropicAdapter;
      try {
        adapter = deps.providers.detectFromModel(
          requestedModel,
          "anthropic",
        ) as unknown as AnthropicAdapter;
      } catch (e) {
        if (e instanceof ProviderNotConfiguredError) {
          return reply.code(401).send({
            type: "error",
            error: {
              type: "authentication_error",
              message: `No credentials for provider detected from model "${requestedModel}"`,
            },
          });
        }
        throw e;
      }

      const { userId } = deps;
      const requestId = randomUUID();

      const systemText = extractSystemText(body.system);
      const latestUserMessage = extractLatestUserText(
        body.messages as Message[],
      );

      let sessionId: string;
      try {
        sessionId =
          body.metadata?.session_id ??
          (req.headers["x-session-id"] as string | undefined) ??
          deriveSessionId(body.messages as Message[], userId, undefined);
      } catch {
        sessionId = randomUUID();
      }

      let ocAgentId =
        (req.headers["x-agent-id"] as string | undefined)
          ?.trim()
          .toLowerCase() || undefined;

      let session: (Session & { providerId: string; model: string }) | null =
        null;
      try {
        const raw = await deps.sessions.getOrCreate(sessionId, userId);
        const needsBind =
          !raw.providerId || !raw.model || raw.model !== requestedModel;
        if (needsBind) {
          const updated = await deps.sessions.update(sessionId, userId, {
            providerId: adapter.id,
            model: requestedModel,
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
        req.log.warn({ err, sessionId }, "session load failed");
      }

      let scope = session?.activeScope ?? [];

      const cfg = await deps.runtimeStore.load().catch(() => ({
        extraction_enabled: true,
        injection_enabled: true,
        managed_history_token_cap: 120000,
        compaction_mode: "aggressive" as const,
        scope_auto_detect: true,
      }));

      const client = parseClient(
        req.headers["user-agent"] as string | undefined,
      );

      const sessionIntercepted = await tryInterceptSessionCommand(
        latestUserMessage,
        userId,
        deps,
        req.log,
      );
      if (sessionIntercepted) {
        sessionId = sessionIntercepted.sessionId;
        ocAgentId = sessionIntercepted.agentId;
      }

      const intercepted = await tryInterceptScopeCommand(
        latestUserMessage,
        sessionId,
        userId,
        deps,
        req.log,
      );
      if (intercepted) {
        return reply.send(
          buildAnthropicResponse(
            `msg_${requestId}`,
            requestedModel,
            intercepted.message,
            "stop",
            { input_tokens: 0, output_tokens: 0 },
          ),
        );
      }

      const extractIntercepted = await tryInterceptExtractCommand(
        latestUserMessage,
        sessionId,
        userId,
        { sessions: deps.sessions, runtimeStore: deps.runtimeStore },
        req.log,
      );
      if (extractIntercepted) {
        return reply.send(
          buildAnthropicResponse(
            `msg_${requestId}`,
            requestedModel,
            extractIntercepted.message,
            "stop",
            { input_tokens: 0, output_tokens: 0 },
          ),
        );
      }

      const injectIntercepted = await tryInterceptInjectCommand(
        latestUserMessage,
        sessionId,
        userId,
        { sessions: deps.sessions, runtimeStore: deps.runtimeStore },
        req.log,
      );
      if (injectIntercepted) {
        return reply.send(
          buildAnthropicResponse(
            `msg_${requestId}`,
            requestedModel,
            injectIntercepted.message,
            "stop",
            { input_tokens: 0, output_tokens: 0 },
          ),
        );
      }

      if (ocAgentId && ocAgentId !== "main") {
        const currentAgentId = (session as any)?.agentId;
        if (currentAgentId !== ocAgentId) {
          await deps.sessions
            .update(sessionId, userId, { agentId: ocAgentId })
            .catch((err) =>
              req.log.warn({ err, sessionId }, "agent id persist failed"),
            );
        }
      }

      if (scope.length === 0) {
        const isFirstTurn =
          (session?.turnCounter ?? 0) === 0 &&
          deps.scopeDetector != null &&
          cfg.scope_auto_detect !== false;

        if (isFirstTurn && deps.scopeDetector) {
          try {
            const existingScopes = await fetchExistingUserScopes(
              userId,
              deps.scopeDetector.db,
            );
            const detected = await detectScopeFromMessage(
              latestUserMessage,
              existingScopes,
              deps.scopeDetector,
              req.log,
            );
            if (detected.length > 0) {
              await deps.sessions
                .update(sessionId, userId, { activeScope: detected })
                .catch((err) =>
                  req.log.warn({ err, sessionId }, "scope persist failed"),
                );
              scope = detected;
            }
          } catch (err) {
            req.log.warn({ err, sessionId }, "scope detection failed");
          }
        }
      }

      const noExtractHeader = req.headers["x-tenure-no-extract"] === "true";
      const bootstrapInProgress = req.headers["x-tenure-bootstrapping"] === "1";
      const isIdeTurn = req.headers["x-tenure-ide"] === "1";
      const ideExtractionEnabled =
        (cfg as any).ide_extraction_enabled !== false;

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
            : null,
        };
        if (!ideScope.projectScope && deps.workspaceState) {
          ideScope.projectScope =
            deps.workspaceState.resolveProjectScope(userId);
          ideScope.languageScope =
            ideScope.languageScope ??
            deps.workspaceState.resolveLanguageScope(userId);
        }
      }

      const systemPrompt = buildSystemPrompt({
        incomingSystem: systemText,
        beliefCtx: injectionEnabled ? beliefCtx : EMPTY_CONTEXT,
        extractionEnabled,
        injectionEnabled,
        activeScope: scope[0],
        scopeAutoDetect: cfg.scope_auto_detect !== false,
        extractionMode,
        ideScope,
      });

      if (deps.injectionAudit && beliefCtx.beliefCount > 0) {
        deps.injectionAudit
          .log({
            userId,
            sessionId,
            requestId,
            userQuery: latestUserMessage,
            expandedQuery: beliefCtx.expandedQuery,
            scope,
            agentId,
            injected: injectionEnabled,
            beliefCtx,
          })
          .catch((err) =>
            req.log.warn({ err, requestId }, "injection audit write failed"),
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
          passThrough: extraFields,
        }),
      };

      const rawContent = body.messages.at(-1) as string | ContentPart[];

      if (stream) {
        return handleAnthropicStream(
          reply,
          adapter,
          normalizedReq,
          systemPrompt,
          {
            requestId,
            sessionId,
            userId,
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
            ideLanguageScope: ideScope?.languageScope ?? null,
            ideActiveFile:
              deps.workspaceState?.get(userId)?.active_file ?? null,
          },
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
            session_id: sessionId,
            request_id: requestId,
            provider: adapter.id,
            model: requestedModel,
            user_impacted: true,
            passthrough_succeeded: false,
          })
          .catch(() => {});

        return reply.code(502).send({
          type: "error",
          error: { type: "api_error", message: reason },
        });
      }

      const { visible, sidecarRaw, parseStatus } = splitSidecar(
        providerResp.content ?? "",
      );

      if (tierWarning) reply.header("x-tenure-warning", tierWarning);

      reply.send(
        buildAnthropicResponse(
          `msg_${requestId}`,
          providerResp.model,
          visible,
          providerResp.finish_reason,
          {
            input_tokens: providerResp.usage.input_tokens,
            output_tokens: providerResp.usage.output_tokens,
          },
          providerResp.toolCalls,
        ),
      );

      runSideEffects({
        deps,
        userId,
        agentId,
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
        extractionMode,
        ideProjectScope: ideScope?.projectScope ?? null,
        ideLanguageScope: ideScope?.languageScope ?? null,
        ideActiveFile: deps.workspaceState?.get(userId)?.active_file ?? null,
      });
    },
  );
}

interface StreamingCtx {
  requestId: string;
  sessionId: string;
  userId: string;
  requestedModel: string;
  latestUserMessage: string;
  rawContent: string | ContentPart[];
  scope: string[];
  deps: ChatDeps;
  session: (Session & { providerId: string; model: string }) | null;
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
  ctx: StreamingCtx,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;

  raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
    ...(ctx.tierWarning ? { "x-tenure-warning": ctx.tierWarning } : {}),
  });

  const messageId = `msg_${ctx.requestId}`;
  const HOLDBACK = SIDECAR_BEGIN.length;

  writeAnthropicSSE(raw, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: ctx.requestedModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  writeAnthropicSSE(raw, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  writeAnthropicSSE(raw, "ping", { type: "ping" });

  let fullContent = "";
  let flushedIdx = 0;
  let sidecarDetected = false;
  let finalModel = ctx.requestedModel;
  let finishReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };

  let nextBlockIndex = 1;
  let currentTextBlockIndex = 0;
  let currentToolBlockIndex = -1;
  const toolCallAccumulator: Record<
    number,
    { id: string; name: string; arguments: string }
  > = {};

  const abortController = new AbortController();
  raw.on("close", () => abortController.abort());

  const heartbeat = setInterval(() => {
    if (!raw.writableEnded && !abortController.signal.aborted) {
      raw.write(": keep-alive\n\n");
    }
  }, 15_000);

  try {
    for await (const event of adapter.callStream(
      { ...normalizedReq, abortSignal: abortController.signal },
      systemPrompt,
    )) {
      if (abortController.signal.aborted) break;

      if (event.type === "content_delta" && event.delta) {
        fullContent += event.delta;

        if (sidecarDetected) continue;

        const markerIdx = fullContent.indexOf(SIDECAR_BEGIN);
        if (markerIdx !== -1) {
          const remaining = fullContent.slice(flushedIdx, markerIdx);
          if (remaining) {
            writeAnthropicSSE(raw, "content_block_delta", {
              type: "content_block_delta",
              index: currentTextBlockIndex,
              delta: { type: "text_delta", text: remaining },
            });
          }
          flushedIdx = markerIdx;
          sidecarDetected = true;
        } else {
          const safeEnd = fullContent.length - HOLDBACK;
          if (safeEnd > flushedIdx) {
            writeAnthropicSSE(raw, "content_block_delta", {
              type: "content_block_delta",
              index: currentTextBlockIndex,
              delta: {
                type: "text_delta",
                text: fullContent.slice(flushedIdx, safeEnd),
              },
            });
            flushedIdx = safeEnd;
          }
        }
      }

      if (event.type === "text_block_start") {
        writeAnthropicSSE(raw, "content_block_stop", {
          type: "content_block_stop",
          index: currentTextBlockIndex,
        });
        currentTextBlockIndex = nextBlockIndex++;
        writeAnthropicSSE(raw, "content_block_start", {
          type: "content_block_start",
          index: currentTextBlockIndex,
          content_block: { type: "text", text: "" },
        });
      }

      if (event.type === "tool_call_delta") {
        const idx = event.toolCallIndex;
        if (idx === undefined) continue;

        if (!toolCallAccumulator[idx]) {
          toolCallAccumulator[idx] = { id: "", name: "", arguments: "" };
          currentToolBlockIndex++;
          writeAnthropicSSE(raw, "content_block_stop", {
            type: "content_block_stop",
            index: currentToolBlockIndex - 1,
          });
          writeAnthropicSSE(raw, "content_block_start", {
            type: "content_block_start",
            index: currentToolBlockIndex,
            content_block: {
              type: "tool_use",
              id: event.toolCallId ?? `toolu_${randomUUID()}`,
              name: event.toolCallName ?? "",
              input: {},
            },
          });
        }

        const acc = toolCallAccumulator[idx];
        if (event.toolCallId) acc.id = event.toolCallId;
        if (event.toolCallName) acc.name = event.toolCallName;
        if (event.toolCallArguments) {
          acc.arguments += event.toolCallArguments;
          writeAnthropicSSE(raw, "content_block_delta", {
            type: "content_block_delta",
            index: currentToolBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: event.toolCallArguments,
            },
          });
        }
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
          session_id: ctx.sessionId,
          request_id: ctx.requestId,
          provider: ctx.adapter.id,
          model: ctx.requestedModel,
          user_impacted: true,
          passthrough_succeeded: false,
        })
        .catch(() => {});

      writeAnthropicSSE(raw, "error", {
        type: "error",
        error: { type: "api_error", message: (err as Error).message },
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

  if (!sidecarDetected && flushedIdx < fullContent.length) {
    writeAnthropicSSE(raw, "content_block_delta", {
      type: "content_block_delta",
      index: currentTextBlockIndex,
      delta: {
        type: "text_delta",
        text: fullContent.slice(flushedIdx),
      },
    });
  }

  writeAnthropicSSE(raw, "content_block_stop", {
    type: "content_block_stop",
    index:
      currentToolBlockIndex !== -1
        ? currentToolBlockIndex
        : currentTextBlockIndex,
  });

  writeAnthropicSSE(raw, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: finishReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });

  writeAnthropicSSE(raw, "message_stop", { type: "message_stop" });

  raw.end();

  const { visible, sidecarRaw, parseStatus } = splitSidecar(fullContent);

  runSideEffects({
    deps: ctx.deps,
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    requestId: ctx.requestId,
    latestUserMessage: ctx.latestUserMessage,
    visible,
    rawContent: ctx.rawContent,
    sidecarRaw,
    parseStatus,
    scope: ctx.scope,
    adapter: ctx.adapter,
    model: finalModel,
    session: ctx.session,
    logger: ctx.logger,
    extractionEnabled: ctx.extractionEnabled,
    client: ctx.client,
    extractionMode: ctx.extractionMode,
    ideProjectScope: ctx.ideProjectScope,
    ideLanguageScope: ctx.ideLanguageScope,
    ideActiveFile: ctx.ideActiveFile,
  });
}
