import * as vscode from "vscode";
import type { TokenStore } from "./tokenStore.js";

export interface TenureProviderInfo {
  id: string;
  configured: boolean;
  base_url: string | null;
  endpoint_flavor: string | undefined;
  registered: boolean;
}

export interface TenureModelInfo {
  id: string;
  owned_by: string;
  supported: boolean;
  family: string | null;
  tier: number | null;
  reason: string | null;
}

function makeModelInfo(modelId: string): vscode.LanguageModelChatInformation {
  return {
    id: modelId,
    name: `Tenure: ${modelId}`,
    family: "tenure",
    version: "1",
    maxInputTokens: 128_000,
    maxOutputTokens: 16_000,
    capabilities: {
      toolCalling: true
    }
  };
}

async function* sseLines(
  body: ReadableStream<Uint8Array>
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
        if (trimmed.startsWith("data: ")) yield trimmed.slice(6);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class TenureLmProvider
  implements
    vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>
{
  private readonly _onDidChangeLanguageModelChatInformation =
    new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private readonly tokenStore: TokenStore,
    private readonly getBaseUrl: () => string
  ) {}

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const apiToken = await this.tokenStore.get();
    if (!apiToken) return [];

    const baseUrl = this.getBaseUrl();

    try {
      const providersRes = await fetch(`${baseUrl}/admin/providers`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(5_000)
      });
      if (!providersRes.ok) return [];

      const providersData = (await providersRes.json()) as {
        providers: TenureProviderInfo[];
      };
      const hasConfigured = providersData.providers.some((p) => p.configured);
      if (!hasConfigured) return [];

      const cfgRes = await fetch(`${baseUrl}/admin/config`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(5_000)
      });
      if (!cfgRes.ok) return [];

      const cfg = (await cfgRes.json()) as {
        default_model: string | null;
        default_provider: string | null;
      };
      if (!cfg.default_model) return [];

      const models: vscode.LanguageModelChatInformation[] = [];
      const configuredProvider = providersData.providers.find(
        (p) => p.configured
      );

      if (configuredProvider) {
        try {
          const probeRes = await fetch(
            `${baseUrl}/v1/onboarding/probe-models/${configuredProvider.id}`,
            {
              headers: { Authorization: `Bearer ${apiToken}` },
              signal: AbortSignal.timeout(10_000)
            }
          );
          if (probeRes.ok) {
            const probeData = (await probeRes.json()) as {
              models: TenureModelInfo[];
              supports_listing: boolean;
            };
            const supported = probeData.models.filter((m) => m.supported);
            for (const m of supported) {
              models.push(makeModelInfo(m.id));
            }
          }
        } catch {}
      }

      if (!models.find((m) => m.id === cfg.default_model)) {
        models.unshift(makeModelInfo(cfg.default_model));
      }

      return models;
    } catch {
      return [];
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiToken = await this.tokenStore.get();
    if (!apiToken) {
      throw new Error(
        "Tenure: no API token configured. Run 'Tenure: Set API Token'."
      );
    }

    const baseUrl = this.getBaseUrl();

    const oaiMessages = messages.map((m) => {
      const role =
        m.role === vscode.LanguageModelChatMessageRole.User
          ? "user"
          : "assistant";

      let content: string;
      if (typeof m.content === "string") {
        content = m.content;
      } else {
        content = (m.content as vscode.LanguageModelInputPart[])
          .filter(
            (p): p is vscode.LanguageModelTextPart =>
              p instanceof vscode.LanguageModelTextPart
          )
          .map((p) => p.value)
          .join("");
      }

      return { role, content };
    });

    const tools =
      options.tools && options.tools.length > 0
        ? options.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema ?? { type: "object", properties: {} }
            }
          }))
        : undefined;

    const abortController = new AbortController();
    const cancelListener = token.onCancellationRequested(() =>
      abortController.abort()
    );

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
          "x-tenure-ide": "1",
          "x-tenure-editor": vscode.env.appName,
          "x-tenure-editor-version": vscode.version
        },
        body: JSON.stringify({
          model: model.id,
          messages: oaiMessages,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools ? { tools } : {})
        }),
        signal: abortController.signal
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`Tenure proxy error: ${errText}`);
      }

      if (!res.body) throw new Error("Tenure proxy: empty response body");

      const toolCallAccumulator: Record<
        number,
        { id: string; name: string; arguments: string }
      > = {};

      for await (const line of sseLines(res.body)) {
        if (token.isCancellationRequested) break;
        if (line === "[DONE]") break;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        const choices = data.choices as
          | Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>
          | undefined;

        const choice = choices?.[0];

        if (choice?.delta?.content) {
          progress.report(
            new vscode.LanguageModelTextPart(choice.delta.content)
          );
        }

        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            if (!toolCallAccumulator[tc.index]) {
              toolCallAccumulator[tc.index] = {
                id: "",
                name: "",
                arguments: ""
              };
            }
            const acc = toolCallAccumulator[tc.index];
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }
      }

      for (const tc of Object.values(toolCallAccumulator)) {
        if (!tc.name) continue;
        let parsedInput: object = {};
        try {
          parsedInput = JSON.parse(tc.arguments) as object;
        } catch {
          parsedInput = {};
        }
        progress.report(
          new vscode.LanguageModelToolCallPart(tc.id, tc.name, parsedInput)
        );
      }
    } finally {
      cancelListener.dispose();
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const str =
      typeof text === "string"
        ? text
        : (text.content as vscode.LanguageModelInputPart[])
            .filter(
              (p): p is vscode.LanguageModelTextPart =>
                p instanceof vscode.LanguageModelTextPart
            )
            .map((p) => p.value)
            .join("");
    return Math.ceil(str.length / 4);
  }

  refresh(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  dispose(): void {
    this._onDidChangeLanguageModelChatInformation.dispose();
  }
}
