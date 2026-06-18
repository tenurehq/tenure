export interface TextPart {
  type: "text";
  text: string;
  cache_control?: { type: string };
}

export interface ImageUrlPart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export interface FilePart {
  type: "file";
  file: { url: string; name?: string };
}

export type ContentPart = TextPart | ImageUrlPart | FilePart;

export interface Message {
  role: "system" | "user" | "assistant" | "tool" | "developer" | "function";
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export type StreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "text_block_start" }
  | {
      type: "tool_call_delta";
      toolCallIndex: number;
      toolCallId?: string | undefined;
      toolCallName?: string | undefined;
      toolCallArguments: string;
    }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_delta"; index: number; partialJson: string }
  | {
      type: "stream_end";
      model: string;
      finish_reason: string;
      usage: { input_tokens: number; output_tokens: number };
      toolCalls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
      toolUses?: Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;
    };

export interface SystemPromptParts {
  static: string;
  beliefs: string;
  dynamic: string;
}

export type SystemPrompt = string | SystemPromptParts;

export function flattenSystemPrompt(sp: SystemPrompt): string {
  if (typeof sp === "string") return sp;
  return [sp.static, sp.beliefs, sp.dynamic].filter(Boolean).join("\n\n");
}

/**
 * Minimal shared interface. Only used for model listing and provider
 * registration/detection. Route handlers call the concrete adapter type
 * directly for call/callStream.
 */
export interface ProviderAdapter {
  readonly id: string;
  listModels?(): Promise<ModelInfo[]>;
}

/**
 * Interface for internal callers (compaction, persona, scope detection)
 * that need to make LLM calls with positional arguments.
 */
export interface InternalLLMCaller {
  call(
    model: string,
    systemPrompt: SystemPrompt,
    messages: Message[],
    body: Record<string, unknown>
  ): Promise<{
    content: string;
    model: string;
    finish_reason: string;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}
