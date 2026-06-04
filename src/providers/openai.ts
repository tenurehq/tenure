import type {
  ContentPart,
  Message,
  ModelInfo,
  ProviderAdapter,
  StreamEvent,
  SystemPrompt,
} from "./types.js";
import type { OpenAIEndpointFlavor } from "../config/runtime.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function flattenSystemPrompt(sp: SystemPrompt): string {
  if (typeof sp === "string") return sp;
  return [sp.static, sp.beliefs, sp.dynamic].filter(Boolean).join("\n\n");
}

function buildMessages(
  systemPrompt: SystemPrompt,
  messages: Message[],
): Message[] {
  const flat = flattenSystemPrompt(systemPrompt);
  const existing = messages.find((m) => m.role === "system");
  const existingText = existing
    ? typeof existing.content === "string"
      ? existing.content
      : (existing.content as ContentPart[])
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n")
    : "";
  const merged = [flat, existingText].filter(Boolean).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  return merged ? [{ role: "system", content: merged }, ...rest] : rest;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  private readonly baseUrl: string;
  private readonly isBag: boolean;

  constructor(
    private readonly apiKey: string,
    baseUrl?: string,
    flavor: OpenAIEndpointFlavor = "generic",
  ) {
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.isBag = flavor === "bedrock-access-gateway";
  }

  async call(
    model: string,
    systemPrompt: SystemPrompt,
    messages: Message[],
    body: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<{
    content: string;
    model: string;
    finish_reason: string;
    usage: { input_tokens: number; output_tokens: number };
    toolCalls?: unknown[];
  }> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        model,
        messages: buildMessages(systemPrompt, messages),
        stream: false,
        ...(this.isBag && { prompt_caching: { system: true, messages: true } }),
      }),
      signal: abortSignal
        ? AbortSignal.any([AbortSignal.timeout(120_000), abortSignal])
        : AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new ProviderError(`openai ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      model: string;
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: unknown[];
        };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    if (!data.choices?.length) {
      throw new ProviderError("openai: empty choices in response");
    }

    const choice = data.choices[0];
    return {
      content: choice.message.content ?? "",
      model: data.model,
      finish_reason: choice.finish_reason,
      usage: {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
      },
      ...(choice.message.tool_calls?.length
        ? { toolCalls: choice.message.tool_calls }
        : {}),
    };
  }

  async *callStream(
    model: string,
    systemPrompt: SystemPrompt,
    messages: Message[],
    body: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        model,
        messages: buildMessages(systemPrompt, messages),
        stream: true,
        ...(this.isBag && { prompt_caching: { system: true, messages: true } }),
      }),
      signal: abortSignal
        ? AbortSignal.any([AbortSignal.timeout(120_000), abortSignal])
        : AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new ProviderError(`openai ${res.status}: ${await res.text()}`);
    }

    if (!res.body) {
      throw new ProviderError("openai: empty stream body");
    }

    let finishReason = "stop";
    let finalModel = model;
    let usage = { input_tokens: 0, output_tokens: 0 };

    const toolCallsBuffer: Record<
      number,
      { id?: string; type?: string; name?: string; arguments: string }
    > = {};

    for await (const line of sseLines(res.body)) {
      if (line === "[DONE]") break;

      let data: Record<string, any>;
      try {
        data = JSON.parse(line) as Record<string, any>;
      } catch {
        continue;
      }

      if (data.usage) {
        usage.input_tokens = data.usage.prompt_tokens ?? usage.input_tokens;
        usage.output_tokens =
          data.usage.completion_tokens ?? usage.output_tokens;
      }

      const choice = data.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        yield { type: "content_delta", delta: choice.delta.content };
      }

      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls as Array<{
          index: number;
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>) {
          const idx = tc.index;
          if (!toolCallsBuffer[idx]) {
            toolCallsBuffer[idx] = { arguments: "" };
          }
          const buf = toolCallsBuffer[idx];
          if (tc.id) buf.id = tc.id;
          if (tc.type) buf.type = tc.type;
          if (tc.function?.name) buf.name = tc.function.name;
          if (tc.function?.arguments) {
            buf.arguments += tc.function.arguments;
            yield {
              type: "tool_call_delta",
              toolCallIndex: idx,
              toolCallId: buf.id,
              toolCallName: buf.name,
              toolCallArguments: tc.function.arguments,
            };
          } else if (tc.id && tc.function?.name) {
            yield {
              type: "tool_call_delta",
              toolCallIndex: idx,
              toolCallId: tc.id,
              toolCallName: tc.function.name,
              toolCallArguments: "",
            };
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (data.model) {
        finalModel = data.model;
      }
    }

    yield {
      type: "stream_end",
      model: finalModel,
      finish_reason: finishReason,
      usage,
      ...(Object.keys(toolCallsBuffer).length
        ? {
            toolCalls: Object.values(toolCallsBuffer).map((tc) => ({
              id: tc.id ?? "",
              type: "function" as const,
              function: { name: tc.name ?? "", arguments: tc.arguments },
            })),
          }
        : {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 401) {
        throw new ProviderError(
          "OpenAI authentication failed — check your API key in the admin UI",
        );
      }
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: ModelInfo[] };
      return (data.data ?? []).map((m) => ({
        id: m.id,
        object: "model" as const,
        created: m.created ?? 0,
        owned_by: m.owned_by ?? this.id,
      }));
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      return [];
    }
  }
}

async function* sseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed.startsWith("data: ")) continue;
        yield trimmed.slice(6);
      }
    }

    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ")) {
      yield trimmed.slice(6);
    }
  } finally {
    reader.releaseLock();
  }
}

export class ProviderError extends Error {}
