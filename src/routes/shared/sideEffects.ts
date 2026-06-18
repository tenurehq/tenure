import type { FastifyBaseLogger } from "fastify";
import type { Session } from "../../session/manager.js";
import type { ProviderAdapter } from "../../providers/types.js";
import type { ContentPart } from "../../providers/types.js";
import type { ParsedClient } from "../../helpers/clientDetector.js";

export interface SideEffectInput {
  deps: SideEffectDeps;
  userId: string;
  teamId: string | null;
  orgId: string | null;
  agentId: string | null;
  sessionId: string;
  requestId: string;
  latestUserMessage: string;
  visible: string;
  rawContent: string | ContentPart[];
  sidecarRaw: string | null;
  parseStatus: string;
  scope: string[];
  adapter: ProviderAdapter;
  model: string;
  session: (Session & { providerId: string; model: string }) | null;
  logger: FastifyBaseLogger;
  extractionEnabled: boolean;
  client: ParsedClient;
  extractionMode: "standard" | "ide";
  ideProjectScope: string | null;
  ideLanguageScope: string | null;
  ideActiveFile: string | null;
}

export interface SideEffectDeps {
  sessions: {
    touch: (sessionId: string, userId: string) => Promise<void>;
  };
  jobs: {
    enqueue: (args: {
      userId: string;
      teamId: string | null;
      orgId: string | null;
      sessionId: string;
      requestId: string;
      userMessage: string;
      assistantMessage: string;
      sidecarRaw: string | null;
      parseStatus: "parsed" | "needs_repair" | "missing";
      scope: string[];
      sourceModel: string;
      clientCategory: string;
      agentId: string | null;
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
        teamId: input.teamId,
        orgId: input.orgId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        userMessage: input.latestUserMessage,
        assistantMessage: input.visible,
        sidecarRaw: input.sidecarRaw,
        parseStatus: input.parseStatus as "parsed" | "needs_repair" | "missing",
        scope: input.scope,
        sourceModel: `${input.adapter.id}:${input.model}`,
        clientCategory: input.client.category,
        agentId: input.agentId,
        extractionMode: input.extractionMode,
        ...(workspaceContext !== undefined && { workspaceContext })
      });

      input.deps.extractionWorker
        .processById(jobId)
        .catch((err) =>
          input.logger.warn(
            { err, jobId, sessionId: input.sessionId },
            "inline extraction failed — sweep will retry"
          )
        );
    } catch (err) {
      input.logger.error(
        { err, sessionId: input.sessionId, requestId: input.requestId },
        "job enqueue failed — turn persisted but extraction will not run"
      );
    }
  }

  if (input.session) {
    input.deps.sessions
      .touch(input.sessionId, input.userId)
      .catch((err) =>
        input.logger.warn(
          { err, sessionId: input.sessionId },
          "session touch failed"
        )
      );
  }
}
