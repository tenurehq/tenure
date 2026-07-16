import type { FastifyBaseLogger } from "fastify";
import type { ProviderAdapter } from "../../providers/types.js";
import type { ContentPart } from "../../providers/types.js";
import type { ParsedClient } from "../../helpers/clientDetector.js";

export interface SideEffectInput {
  deps: SideEffectDeps;
  userId: string;
  agentId: string | null;
  tokenId: string;
  tokenName: string;
  tokenKind: "client" | "agent" | "root";
  requestId: string;
  latestUserMessage: string;
  visible: string;
  rawContent: string | ContentPart[];
  sidecarRaw: string | null;
  parseStatus: string;
  scope: string[];
  adapter: ProviderAdapter;
  model: string;
  logger: FastifyBaseLogger;
  extractionEnabled: boolean;
  client: ParsedClient;
  extractionMode: "standard" | "ide";
  ideProjectScope: string | null;
  ideLanguageScope: string | null;
  ideActiveFile: string | null;
}

export interface SideEffectDeps {
  jobs: {
    enqueue: (args: {
      userId: string;
      agentId: string | null;
      tokenId: string;
      tokenName: string;
      tokenKind: "client" | "agent" | "root";
      requestId: string;
      userMessage: string;
      assistantMessage: string;
      sidecarRaw: string | null;
      parseStatus: "parsed" | "needs_repair" | "missing";
      scope: string[];
      sourceModel: string;
      clientCategory: string;
      extractionMode: "standard" | "ide";
      workspaceContext?: {
        project_scope: string | null;
        language_scope: string | null;
        active_file: string | null;
      };
    }) => Promise<string>;
  };
  extractionWorker: {
    processById: (jobId: string) => Promise<void>;
  };
}

export async function runSideEffects(input: SideEffectInput): Promise<void> {
  if (input.extractionEnabled) {
    try {
      const workspaceContext =
        input.ideProjectScope || input.ideActiveFile
          ? ({
              project_scope: input.ideProjectScope,
              language_scope: input.ideLanguageScope,
              active_file: input.ideActiveFile
            } as const)
          : undefined;

      const jobId = await input.deps.jobs.enqueue({
        userId: input.userId,
        agentId: input.agentId,
        tokenId: input.tokenId,
        tokenName: input.tokenName,
        tokenKind: input.tokenKind,
        requestId: input.requestId,
        userMessage: input.latestUserMessage,
        assistantMessage: input.visible,
        sidecarRaw: input.sidecarRaw,
        parseStatus: input.parseStatus as "parsed" | "needs_repair" | "missing",
        scope: input.scope,
        sourceModel: `${input.adapter.id}:${input.model}`,
        clientCategory: input.client.category,
        extractionMode: input.extractionMode,
        ...(workspaceContext !== undefined && { workspaceContext })
      });

      input.deps.extractionWorker
        .processById(jobId)
        .catch((err) =>
          input.logger.warn(
            { err, jobId },
            "inline extraction failed — sweep will retry"
          )
        );
    } catch (err) {
      input.logger.error(
        { err, requestId: input.requestId },
        "job enqueue failed — turn persisted but extraction will not run"
      );
    }
  }
}
