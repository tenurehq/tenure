import Anthropic from "@anthropic-ai/sdk";

import type {
  ProviderAdapter,
  StreamEvent,
  ModelInfo,
  Message,
  SystemPrompt,
} from "./types.ts";

export interface AnthropicCallRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  passThrough?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export interface AnthropicCallResponse {
  content: string;
  model: string;
  finish_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  toolCalls?: unknown[];
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async call(
    req: AnthropicCallRequest,
    systemPrompt: SystemPrompt,
  ): Promise<AnthropicCallResponse> {
    if (!req.model) {
      throw new Error(
        "No model specified — select a model in your client settings.",
      );
    }

    const base = this.buildCallParams(req, systemPrompt);

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        ...base,
        stream: false as const,
      });
    } catch (e) {
      throw mapError(e);
    }

    const { text, toolCalls } = extractResponseParts(response.content);

    return {
      content: text,
      model: response.model,
      finish_reason: mapStopReason(response.stop_reason),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      ...(toolCalls.length && { toolCalls }),
    };
  }

  async *callStream(
    req: AnthropicCallRequest,
    systemPrompt: SystemPrompt,
  ): AsyncGenerator<StreamEvent> {
    if (!req.model) {
      throw new Error(
        "No model specified — select a model in your client settings.",
      );
    }

    const base = this.buildCallParams(req, systemPrompt);
    const stream = this.client.messages.stream({
      ...base,
      ...(req.abortSignal ? { signal: req.abortSignal } : {}),
    } as unknown as Parameters<typeof this.client.messages.stream>[0]);

    try {
      let currentToolIndex = -1;

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "content_delta", delta: event.delta.text };
        }

        if (
          event.type === "content_block_start" &&
          event.content_block.type === "text"
        ) {
          yield {
            type: "text_block_start" as const,
          };
        }

        if (
          event.type === "content_block_start" &&
          event.content_block.type === "tool_use"
        ) {
          currentToolIndex++;
          yield {
            type: "tool_call_delta" as const,
            toolCallIndex: currentToolIndex,
            toolCallId: event.content_block.id,
            toolCallName: event.content_block.name,
            toolCallArguments: "",
          };
        }

        if (
          event.type === "content_block_delta" &&
          event.delta.type === "input_json_delta"
        ) {
          yield {
            type: "tool_call_delta" as const,
            toolCallIndex: currentToolIndex,
            toolCallId: undefined,
            toolCallName: undefined,
            toolCallArguments: event.delta.partial_json,
          };
        }
      }
      const final = await stream.finalMessage();
      const { toolCalls } = extractResponseParts(final.content);

      yield {
        type: "stream_end",
        model: final.model,
        finish_reason: mapStopReason(final.stop_reason),
        usage: {
          input_tokens: final.usage.input_tokens,
          output_tokens: final.usage.output_tokens,
        },
        ...(toolCalls.length
          ? {
              toolCalls: toolCalls as Array<{
                id: string;
                type: "function";
                function: { name: string; arguments: string };
              }>,
            }
          : {}),
      };
    } catch (e) {
      throw mapError(e);
    }
  }

  async callPositional(
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
  }> {
    const req: AnthropicCallRequest = {
      model,
      messages,
      ...(body.temperature !== undefined && {
        temperature: body.temperature as number,
      }),
      ...(body.max_tokens !== undefined && {
        max_tokens: body.max_tokens as number,
      }),
      passThrough: body,
      ...(abortSignal !== undefined && { abortSignal }),
    };

    const resp = await this.call(req, systemPrompt);
    return {
      content: resp.content,
      model: resp.model,
      finish_reason: resp.finish_reason,
      usage: resp.usage,
    };
  }
  async listModels(): Promise<ModelInfo[]> {
    try {
      const page = await this.client.models.list({ limit: 100 });
      return page.data.map((m) => ({
        id: m.id,
        object: "model" as const,
        created: Math.floor(new Date(m.created_at).getTime() / 1000),
        owned_by: "anthropic",
      }));
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw mapError(e);
      return [];
    }
  }

  private buildCallParams(
    req: AnthropicCallRequest,
    systemPrompt: SystemPrompt,
  ) {
    let system: string | Anthropic.TextBlockParam[] | undefined;

    if (typeof systemPrompt === "string") {
      system = (systemPrompt as string).trim() || undefined;
    } else {
      const blocks: Anthropic.TextBlockParam[] = [];

      if (systemPrompt.static) {
        blocks.push({
          type: "text",
          text: systemPrompt.static,
          cache_control: { type: "ephemeral" },
        });
      }

      const beliefText = systemPrompt.beliefs;
      if (beliefText) {
        blocks.push({
          type: "text",
          text: beliefText,
          cache_control: { type: "ephemeral" },
        });
      }

      if (systemPrompt.dynamic) {
        blocks.push({
          type: "text",
          text: systemPrompt.dynamic,
        });
      }

      system = blocks.length > 0 ? blocks : undefined;
    }

    const conversation = req.messages.filter(
      (m) => m.role !== "system",
    ) as unknown as Anthropic.MessageParam[];

    const {
      temperature: _t,
      max_tokens: _m,
      ...nativeFields
    } = req.passThrough ?? {};

    return {
      model: req.model,
      messages: conversation,
      max_tokens: req.max_tokens ?? 120000,
      ...(system !== undefined ? { system } : {}),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      ...nativeFields,
    };
  }
}

function extractResponseParts(blocks: Anthropic.ContentBlock[]): {
  text: string;
  toolCalls: unknown[];
} {
  let text = "";
  const toolCalls: unknown[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  return { text, toolCalls };
}

function mapStopReason(reason: string | null): string {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

function mapError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) {
    return new Error(
      "Anthropic authentication failed — check your API key in the admin UI",
    );
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new Error("Anthropic rate limit exceeded — retry after back-off");
  }
  if (e instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error ${e.status}: ${e.message}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
