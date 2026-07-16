import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Db } from "mongodb";

import { ContextBuilder } from "./context/contextBuilder.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ExtractionJobQueue } from "./jobs/queue.js";
import { registerChatRoute, type ChatDeps } from "./routes/chat.js";
import { registerMessagesRoute } from "./routes/messages.js";
import { registerAdminRoutes, type AdminDeps } from "./routes/admin.js";
import { registerBeliefsRoutes, type BeliefsDeps } from "./routes/beliefs.js";
import type { RuntimeConfigStore } from "./config/runtime.js";
import type { ErrorLogger } from "./errors/logger.js";
import type { Collections, TokenDoc } from "./db/collections.js";
import {
  registerOnboardingRoutes,
  type OnboardingDeps
} from "./routes/onboarding.js";
import { registerBeliefsUiRoute } from "./routes/beliefs-ui.js";
import { registerAdminUiRoute } from "./routes/admin-ui.js";
import type { PersonaCache } from "./context/personaCache.js";
import fastifySchedule from "@fastify/schedule";
import { SimpleIntervalJob, AsyncTask } from "toad-scheduler";
import type { ExtractionWorker } from "./extraction/worker.js";
import type { PersonaSummaryService } from "./context/personaSummary.js";
import { fileURLToPath } from "node:url";
import path, { dirname } from "node:path";
import fastifyStatic from "@fastify/static";
import { registerBackupRoutes, type BackupDeps } from "./routes/backup.js";
import { registerPersonaRoutes, type PersonaDeps } from "./routes/persona.js";
import { registerCommandsRoute } from "./routes/commands.js";
import { BeliefWriter } from "./extraction/beliefWriter.js";
import type { WorkspaceStateCache } from "./workspace/stateCache.js";
import {
  registerWorkspaceRoutes,
  type WorkspaceDeps
} from "./routes/workspace.js";
import fastifyWebsocket from "@fastify/websocket";
import { registerBeliefsWsRoute } from "./routes/beliefs-ws.js";
import { startBeliefChangeStream } from "./db/beliefChangeStream.js";
import { InjectionAuditLogger } from "./audit/injectionAuditLogger.js";
import { registerAuditRoutes, type AuditDeps } from "./routes/audit.js";
import { registerAuditUiRoute } from "./routes/audit-ui.js";
import { randomBytes } from "node:crypto";
import helmet from "@fastify/helmet";
import type { ProjectResumeService } from "./context/projectResume.js";
import { registerResumeRoutes, type ResumeRouteDeps } from "./routes/resume.js";
import type { TokenService } from "./auth/tokenService.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import type { CredentialVault } from "./config/encryption.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const jobsEnabled = process.env.TENURE_DISABLE_JOBS !== "true";

const SAFE_ERROR_PATTERNS = [
  "authentication failed",
  "api key",
  "rate limit",
  "no model specified",
  "no provider configured",
  "not configured"
];

function isSafeToForward(message: string): boolean {
  const lower = message.toLowerCase();
  return SAFE_ERROR_PATTERNS.some((p) => lower.includes(p));
}

export function getProjectScopes(scopes: string[]): string[] {
  return scopes.filter((s) => s.startsWith("project:"));
}

export function tokenAllowsProjectScopes(
  tokenProjectScopes: string[] | null | undefined,
  scopes: string[]
): boolean {
  if (tokenProjectScopes == null) return true;
  const requestedProjects = getProjectScopes(scopes);
  if (requestedProjects.length === 0) return true;
  return requestedProjects.every((scope) => tokenProjectScopes.includes(scope));
}

export function assertTokenProjectScopes(
  req: FastifyRequest,
  scopes: string[]
): { ok: true } | { ok: false; message: string } {
  const allowed = req.tenureTokenProjectScopes;
  if (tokenAllowsProjectScopes(allowed, scopes)) {
    return { ok: true };
  }
  return {
    ok: false,
    message: "Token is not authorized for one or more requested project scopes"
  };
}

function requiresAuth(pathOnly: string): boolean {
  return (
    pathOnly.startsWith("/v1/") ||
    (pathOnly.startsWith("/admin/") && pathOnly !== "/admin/")
  );
}

function isChatRoute(pathOnly: string): boolean {
  return pathOnly === "/v1/chat/completions" || pathOnly === "/v1/messages";
}

function isBeliefsRoute(pathOnly: string): boolean {
  return pathOnly.startsWith("/v1/beliefs") || pathOnly === "/v1/ws/beliefs";
}

function isAdminRoute(pathOnly: string): boolean {
  return pathOnly.startsWith("/admin/");
}

function applyTokenRequestContext(req: FastifyRequest, doc: TokenDoc): void {
  req.tenureUserId = doc.user_id;
  req.tenureAuthMethod = "token";
  req.tenureTokenId = doc._id;
  req.tenureTokenName = doc.name;
  req.tenureTokenProjectScopes = doc.project_scopes;
  req.tenureTokenKind = doc.kind;
  req.tenureTokenCapabilities = doc.capabilities;
  req.tenureTokenExtractionEnabled =
    doc.kind === "root" || doc.capabilities.includes("extraction");
  req.tenureTokenInjectionEnabled =
    doc.kind === "root" || doc.capabilities.includes("injection");
}

export interface ServerDeps {
  db: Db;
  cols: Collections;
  context: ContextBuilder;
  providers: ProviderRegistry;
  jobs: ExtractionJobQueue;
  runtimeStore: RuntimeConfigStore;
  errorLogger: ErrorLogger;
  persona: PersonaCache;
  userId: string;
  extractionWorker: ExtractionWorker;
  personaSummary: PersonaSummaryService;
  projectResume: ProjectResumeService;
  workspaceState: WorkspaceStateCache;
  tokenService: TokenService;
  vault: CredentialVault;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "info" } });

  app.addHook("onRequest", async (_req, reply) => {
    (reply.raw as any).cspNonce = randomBytes(16).toString("base64");
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          (_req, res) => `'nonce-${(res as any).cspNonce}'`
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", "wss:"],
        imgSrc: ["'self'", "data:"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  });

  app.register(fastifyStatic, { root: path.join(__dirname, "static") });

  app.addHook("onRequest", async (req, reply) => {
    const pathOnly = req.url.split("?")[0];

    if (!requiresAuth(pathOnly)) return;

    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!bearer) {
      return reply.code(401).send({ error: { message: "unauthorized" } });
    }

    const tokenResult = await deps.tokenService.validate(bearer);

    if (!tokenResult) {
      return reply.code(401).send({ error: { message: "unauthorized" } });
    }

    applyTokenRequestContext(req, tokenResult.doc as TokenDoc);
    await deps.tokenService.touch(tokenResult.doc._id);
  });

  app.addHook("preHandler", async (req, reply) => {
    const pathOnly = req.url.split("?")[0];
    const capabilities = req.tenureTokenCapabilities ?? [];
    const tokenKind = req.tenureTokenKind;

    if (isAdminRoute(pathOnly)) {
      if (tokenKind !== "root") {
        return reply.code(403).send({
          error: {
            message: "Only the root token can access admin endpoints"
          }
        });
      }
      return;
    }

    if (tokenKind === "root") {
      return;
    }

    if (isChatRoute(pathOnly)) {
      if (!capabilities.includes("chat")) {
        return reply.code(403).send({
          error: {
            message: 'This endpoint requires capability "chat"',
            required_capability: "chat",
            token_capabilities: capabilities
          }
        });
      }
      return;
    }

    if (isBeliefsRoute(pathOnly)) {
      const isWrite =
        req.method === "POST" ||
        req.method === "PUT" ||
        req.method === "PATCH" ||
        req.method === "DELETE";

      if (isWrite) {
        if (tokenKind === "agent") {
          return reply.code(403).send({
            error: {
              message:
                "Agent tokens cannot modify beliefs. Use a client token for manual belief management.",
              token_kind: tokenKind,
              token_capabilities: capabilities
            }
          });
        }

        if (!capabilities.includes("beliefs:write")) {
          return reply.code(403).send({
            error: {
              message: 'This endpoint requires capability "beliefs:write"',
              required_capability: "beliefs:write",
              token_capabilities: capabilities
            }
          });
        }
      } else {
        if (!capabilities.includes("beliefs:read")) {
          return reply.code(403).send({
            error: {
              message: 'This endpoint requires capability "beliefs:read"',
              required_capability: "beliefs:read",
              token_capabilities: capabilities
            }
          });
        }
      }
    }
  });

  app.setErrorHandler((error, req, reply) => {
    req.log.error({ err: error, method: req.method, url: req.url });

    const fastifyError = error as { statusCode?: number; message: string };

    deps.errorLogger
      .log({
        severity:
          fastifyError.statusCode && fastifyError.statusCode < 500
            ? "warning"
            : "error",
        stage: req.url.startsWith("/v1/chat")
          ? "provider_call"
          : req.url.startsWith("/admin")
            ? "config"
            : req.url.startsWith("/v1/beliefs")
              ? "belief_write"
              : "provider_call",
        message: fastifyError.message,
        error: error instanceof Error ? error : new Error(fastifyError.message),
        user_id: req.tenureUserId ?? deps.userId,
        actor_id: req.tenureUserId ?? deps.userId
      })
      .catch(() => {});

    if (reply.sent) return;

    const statusCode = fastifyError.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.status(statusCode).send({
        error: { message: fastifyError.message, type: "client_error" }
      });
    }

    const clientMessage = isSafeToForward(fastifyError.message)
      ? fastifyError.message
      : "internal server error";

    return reply.status(500).send({
      error: { message: clientMessage, type: "internal_error" }
    });
  });

  app.get("/healthz", async (_req, reply) => {
    try {
      await deps.db.command({ ping: 1 });
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: "database unreachable" });
    }
  });

  app.get("/v1/models", async (_req, _reply) => {
    const models = await deps.providers.listModels();
    return { object: "list", data: models };
  });

  const chatDeps: ChatDeps = {
    context: deps.context,
    providers: deps.providers,
    jobs: deps.jobs,
    extractionWorker: deps.extractionWorker,
    runtimeStore: deps.runtimeStore,
    errorLogger: deps.errorLogger,
    workspaceState: deps.workspaceState,
    injectionAudit: new InjectionAuditLogger(deps.cols.injection_audit),
    tokenScopes: {
      getActiveScope: deps.tokenService.getActiveScope.bind(deps.tokenService),
      setActiveScope: deps.tokenService.setActiveScope.bind(deps.tokenService)
    }
  };
  registerChatRoute(app, chatDeps);
  registerMessagesRoute(app, chatDeps);

  const adminDeps: AdminDeps = {
    runtimeStore: deps.runtimeStore,
    providers: deps.providers,
    db: deps.db,
    vault: deps.vault,
    tokenService: deps.tokenService
  } as AdminDeps;
  registerAdminRoutes(app, adminDeps);

  const beliefsDeps: BeliefsDeps = {
    beliefs: deps.cols.beliefs,
    jobs: deps.jobs,
    extractionWorker: deps.extractionWorker,
    runtimeStore: deps.runtimeStore,
    providers: deps.providers,
    beliefWriter: new BeliefWriter(deps.cols.beliefs),
    suggestions: deps.cols.belief_suggestions
  };
  registerBeliefsRoutes(app, beliefsDeps);

  const onboardingDeps: OnboardingDeps = {
    runtimeStore: deps.runtimeStore,
    jobs: deps.jobs,
    providers: deps.providers,
    extractionWorker: deps.extractionWorker,
    personaSummary: deps.personaSummary
  };
  registerOnboardingRoutes(app, onboardingDeps, deps.cols);

  registerBeliefsUiRoute(app);
  registerAdminUiRoute(app);
  registerAuditUiRoute(app);

  const backupDeps: BackupDeps = {
    db: deps.db,
    runtimeStore: deps.runtimeStore
  };
  registerBackupRoutes(app, backupDeps);

  const personaDeps: PersonaDeps = {
    persona: deps.persona,
    personaSummary: deps.personaSummary
  };

  registerPersonaRoutes(app, personaDeps);

  registerCommandsRoute(app);

  const workspaceDeps: WorkspaceDeps = {
    workspaceState: deps.workspaceState
  };
  registerWorkspaceRoutes(app, workspaceDeps);

  const auditDeps: AuditDeps = {
    injectionAudit: deps.cols.injection_audit
  };
  registerAuditRoutes(app, auditDeps);

  const resumeDeps: ResumeRouteDeps = {
    projectResume: deps.projectResume
  };
  registerResumeRoutes(app, resumeDeps);

  registerTokenRoutes(app, { tokenService: deps.tokenService });

  await app.register(fastifyWebsocket);

  registerBeliefsWsRoute(app, {
    beliefs: deps.cols.beliefs,
    fileMeta: deps.cols.file_meta,
    beliefWriter: new BeliefWriter(deps.cols.beliefs),
    workspaceState: deps.workspaceState,
    runtimeStore: deps.runtimeStore
  });

  await app.register(fastifySchedule);

  if (jobsEnabled) {
    app.addHook("onReady", async () => {
      let consecutiveEmpty = 0;
      const BASE_INTERVAL_MS = 60_000;
      const MAX_INTERVAL_MS = 5 * 60_000;
      const BACKOFF_AFTER = 3;

      let currentJob: SimpleIntervalJob | null = null;

      const createSweepTask = () =>
        new AsyncTask(
          "extraction-sweep",
          async () => {
            try {
              const processed = await deps.extractionWorker.sweep(20);

              if (processed === 0) {
                consecutiveEmpty++;
                if (consecutiveEmpty >= BACKOFF_AFTER) {
                  const newInterval = Math.min(
                    BASE_INTERVAL_MS *
                      Math.pow(2, consecutiveEmpty - BACKOFF_AFTER),
                    MAX_INTERVAL_MS
                  );
                  if (currentJob) app.scheduler.removeById("extraction-sweep");
                  currentJob = new SimpleIntervalJob(
                    { milliseconds: newInterval, runImmediately: false },
                    createSweepTask(),
                    { id: "extraction-sweep", preventOverrun: true }
                  );
                  app.scheduler.addSimpleIntervalJob(currentJob);
                }
              } else {
                if (consecutiveEmpty >= BACKOFF_AFTER) {
                  if (currentJob) app.scheduler.removeById("extraction-sweep");
                  currentJob = new SimpleIntervalJob(
                    { milliseconds: BASE_INTERVAL_MS, runImmediately: false },
                    createSweepTask(),
                    { id: "extraction-sweep", preventOverrun: true }
                  );
                  app.scheduler.addSimpleIntervalJob(currentJob);
                }
                consecutiveEmpty = 0;
              }
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err));
              throw e;
            } finally {
            }
          },
          (err: Error) => {
            deps.errorLogger
              .log({
                severity: "warning",
                stage: "belief_extraction",
                message: err.message,
                error: err,
                user_id: deps.userId,
                actor_id: deps.userId
              })
              .catch(() => {});
          }
        );

      currentJob = new SimpleIntervalJob(
        { milliseconds: BASE_INTERVAL_MS, runImmediately: true },
        createSweepTask(),
        { id: "extraction-sweep", preventOverrun: true }
      );
      app.scheduler.addSimpleIntervalJob(currentJob);
    });
  }

  app.get("/", async (_req, reply) => {
    const cfg = await deps.runtimeStore.load();
    const target =
      cfg.onboarding_status === "completed" ? "/beliefs" : "/onboarding";
    return reply.redirect(target, 302);
  });

  const isReplicaSet = await deps.db
    .admin()
    .command({ hello: 1 })
    .then((r) => !!(r.setName || r.hosts))
    .catch(() => false);

  const stopChangeStream = isReplicaSet
    ? startBeliefChangeStream(deps.cols.beliefs_plain, deps.cols.beliefs)
    : null;

  app.addHook("onClose", (_instance, done) => {
    stopChangeStream?.();
    done();
  });

  return app;
}
