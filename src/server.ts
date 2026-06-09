import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Db } from "mongodb";

import { SessionManager } from "./session/manager.js";
import { HistoryManager } from "./history/manager.js";
import { ContextBuilder } from "./context/contextBuilder.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ExtractionJobQueue } from "./jobs/queue.js";
import { registerChatRoute, type ChatDeps } from "./routes/chat.js";
import { registerAdminRoutes, type AdminDeps } from "./routes/admin.js";
import { registerBeliefsRoutes, type BeliefsDeps } from "./routes/beliefs.js";
import type { RuntimeConfigStore } from "./config/runtime.js";
import type { ErrorLogger } from "./errors/logger.js";
import type { Collections } from "./db/collections.js";
import {
  registerOnboardingRoutes,
  type OnboardingDeps
} from "./routes/onboarding.js";
import { registerBeliefsUiRoute } from "./routes/beliefs-ui.js";
import { registerAdminUiRoute } from "./routes/admin-ui.js";
import type { PersonaCache } from "./context/personaCache.js";
import type { BeliefCompactionRunner } from "./jobs/compactionRunner.js";
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
import { createHash, randomBytes } from "node:crypto";
import {
  getGroupsForUser,
  getScimUserIdByUserName,
  registerScimRoutes,
  type ScimDeps
} from "./routes/scim.js";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { registerAdminSetupRoute } from "./routes/admin-setup.js";
import helmet from "@fastify/helmet";
import type { TeamResolutionStrategy } from "./config/teamResolution.js";
import type { OrgSummaryService } from "./context/orgSummary.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const jobsEnabled = process.env.TENURE_DISABLE_JOBS !== "true";
const proxyAuthHeader = process.env.OIDC_PROXY_HEADER?.toLowerCase() || "";

const defaultTeamId = process.env.TENURE_DEFAULT_TEAM_ID;
const defaultOrgId = process.env.TENURE_DEFAULT_ORG_ID;

declare module "fastify" {
  interface FastifyRequest {
    tenureUserId: string;
    tenureAuthMethod: "proxy" | "root" | "pat";
    tenureTeamId?: string;
    tenureOrgId?: string;
  }
}

const patAllowedPaths = new Set([
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/models",
  "/v1/ws/beliefs"
]);

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

export interface ServerDeps {
  db: Db;
  cols: Collections;
  sessions: SessionManager;
  history: HistoryManager;
  context: ContextBuilder;
  providers: ProviderRegistry;
  jobs: ExtractionJobQueue;
  runtimeStore: RuntimeConfigStore;
  errorLogger: ErrorLogger;
  persona: PersonaCache;
  apiToken: string;
  userId: string;
  compactionRunner: BeliefCompactionRunner;
  extractionWorker: ExtractionWorker;
  personaSummary: PersonaSummaryService;
  orgSummaryService: OrgSummaryService;
  workspaceState: WorkspaceStateCache;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const tracer = trace.getTracer("tenure");

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

  let liveToken = deps.apiToken;

  app.register(fastifyStatic, { root: path.join(__dirname, "static") });

  async function resolveMembership(
    req: FastifyRequest,
    userId: string
  ): Promise<{ teamId: string; orgId: string } | null> {
    if (process.env.TENURE_MODE !== "teams") return null;

    const cfg = (await deps.runtimeStore.load()) as any;

    const strategy = (cfg.team_resolution_strategy ??
      "static") as TeamResolutionStrategy;

    switch (strategy) {
      case "disabled":
        return null;

      case "static": {
        if (!defaultTeamId || !defaultOrgId) return null;
        return { teamId: defaultTeamId, orgId: defaultOrgId };
      }

      case "header": {
        const teamHeader = (cfg.team_header_name ?? "x-team-id").toLowerCase();
        const orgHeader = (cfg.org_header_name ?? "x-org-id").toLowerCase();
        const teamId = req.headers[teamHeader] as string | undefined;
        const orgId = req.headers[orgHeader] as string | undefined;
        if (teamId && orgId) return { teamId, orgId };
        // Graceful fallback to static if headers absent
        if (defaultTeamId && defaultOrgId)
          return { teamId: defaultTeamId, orgId: defaultOrgId };
        return null;
      }

      case "manual":
        // Future: look up user_id -> team_id in an admin-managed collection
        return null;

      case "scim_group": {
        // cfg.scim_group_mappings is an array of
        // { groupId: string; teamId: string; orgId: string }
        // stored in runtime config or a collection
        const mappings: Array<{
          groupId: string;
          teamId: string;
          orgId: string;
        }> = cfg.scim_group_mappings ?? [];
        if (!mappings.length) {
          // Fall through to static defaults
          if (defaultTeamId && defaultOrgId)
            return { teamId: defaultTeamId, orgId: defaultOrgId };
          return null;
        }

        const scimUserId = await getScimUserIdByUserName(deps.db, userId);
        if (!scimUserId) {
          if (defaultTeamId && defaultOrgId)
            return { teamId: defaultTeamId, orgId: defaultOrgId };
          return null;
        }

        const groupIds = await getGroupsForUser(deps.db, scimUserId);
        for (const mapping of mappings) {
          if (groupIds.includes(mapping.groupId)) {
            return { teamId: mapping.teamId, orgId: mapping.orgId };
          }
        }

        // User is provisioned but not in any mapped group — fall back
        if (defaultTeamId && defaultOrgId)
          return { teamId: defaultTeamId, orgId: defaultOrgId };
        return null;
      }
    }
  }

  app.addHook("onRequest", async (req, reply) => {
    const pathOnly = req.url.split("?")[0];

    if (proxyAuthHeader) {
      const userId = req.headers[proxyAuthHeader] as string | undefined;
      if (userId) {
        req.tenureUserId = userId;
        req.tenureAuthMethod = "proxy";

        const span = trace.getActiveSpan();
        if (span) span.setAttribute("user.id", userId);

        const membership = await resolveMembership(req, userId);
        if (membership) {
          req.tenureTeamId = membership.teamId;
          req.tenureOrgId = membership.orgId;
        }

        return;
      }
    }

    const requiresAuth =
      pathOnly.startsWith("/v1/") ||
      (pathOnly.startsWith("/admin/") && pathOnly !== "/admin/");

    if (!requiresAuth) return;

    if (req.tenureAuthMethod === "proxy") return;

    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!bearer) {
      return reply.code(401).send({ error: { message: "unauthorized" } });
    }

    if (bearer === liveToken) {
      if (process.env.TENURE_MODE === "teams") {
        const isBootstrapPath =
          pathOnly === "/admin/config" ||
          pathOnly === "/admin/providers" ||
          pathOnly === "/admin/setup" ||
          pathOnly.startsWith("/admin/providers/") ||
          pathOnly === "/v1/models" ||
          pathOnly === "/v1/onboarding/questions" ||
          pathOnly === "/v1/onboarding/skip" ||
          pathOnly === "/v1/onboarding/validate-model" ||
          pathOnly === "/v1/onboarding/complete" ||
          pathOnly === "/v1/onboarding/commit" ||
          pathOnly.startsWith("/v1/onboarding/probe-models/");

        if (!isBootstrapPath) {
          return reply.code(403).send({
            error: {
              message:
                "Root token cannot access this endpoint in team mode. Use SSO."
            }
          });
        }
      }

      req.tenureUserId = deps.userId;
      req.tenureAuthMethod = "root";

      const span = trace.getActiveSpan();
      if (span) span.setAttribute("user.id", deps.userId);

      return;
    }

    const hash = createHash("sha256").update(bearer).digest("hex");
    const pat = await deps.cols.api_tokens.findOne({
      token_hash: hash,
      revoked_at: null
    });

    if (pat) {
      if (!patAllowedPaths.has(pathOnly)) {
        return reply.code(403).send({ error: { message: "forbidden" } });
      }
      req.tenureUserId = pat.user_id;
      req.tenureAuthMethod = "pat";

      const span = trace.getActiveSpan();
      if (span) span.setAttribute("user.id", pat.user_id);

      const membership = await resolveMembership(req, pat.user_id);
      if (membership) {
        req.tenureTeamId = membership.teamId;
        req.tenureOrgId = membership.orgId;
      }

      deps.cols.api_tokens
        .updateOne({ _id: pat._id }, { $set: { last_used_at: new Date() } })
        .catch(() => {});
      return;
    }

    return reply.code(401).send({ error: { message: "unauthorized" } });
  });

  app.setErrorHandler((error, req, reply) => {
    const span = trace.getActiveSpan();
    if (span) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    }

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
    sessions: deps.sessions,
    context: deps.context,
    providers: deps.providers,
    jobs: deps.jobs,
    extractionWorker: deps.extractionWorker,
    runtimeStore: deps.runtimeStore,
    errorLogger: deps.errorLogger,
    workspaceState: deps.workspaceState,
    injectionAudit: new InjectionAuditLogger(deps.cols.injection_audit)
  };
  registerChatRoute(app, chatDeps);

  const adminDeps: AdminDeps = {
    runtimeStore: deps.runtimeStore,
    providers: deps.providers,
    db: deps.db,
    updateToken: (t: string) => {
      liveToken = t;
    },
    compactionRunner: deps.compactionRunner
  };
  registerAdminRoutes(app, adminDeps);

  const beliefsDeps: BeliefsDeps = {
    beliefs: deps.cols.beliefs,
    jobs: deps.jobs,
    extractionWorker: deps.extractionWorker,
    runtimeStore: deps.runtimeStore,
    providers: deps.providers,
    beliefWriter: new BeliefWriter(deps.cols.beliefs)
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
  registerAdminSetupRoute(app, { runtimeStore: deps.runtimeStore });
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

  const scimDeps: ScimDeps = { db: deps.db, cols: deps.cols };
  registerScimRoutes(app, scimDeps);

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
      const task = new AsyncTask(
        "belief-compaction",
        async () => {
          await tracer.startActiveSpan("belief-compaction", async (span) => {
            try {
              const activeUserIds = await deps.db
                .collection<{ userId: string }>("sessions")
                .distinct("userId", {
                  updated_at: {
                    $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                  }
                });

              const targets = activeUserIds.length
                ? activeUserIds
                : [deps.userId];

              for (const uid of targets) {
                try {
                  await deps.compactionRunner.run(uid);
                } catch (err) {
                  await deps.errorLogger
                    .log({
                      severity: "warning",
                      stage: "belief_extraction",
                      message: (err as Error).message,
                      error: err as Error,
                      user_id: uid,
                      actor_id: deps.userId
                    })
                    .catch(() => {});
                }
              }
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err));
              span.recordException(e);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: e.message
              });
              throw e;
            } finally {
              span.end();
            }
          });
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

      app.scheduler.addSimpleIntervalJob(
        new SimpleIntervalJob({ minutes: 30, runImmediately: false }, task, {
          id: "belief-compaction",
          preventOverrun: true
        })
      );
    });
  }

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
            await tracer.startActiveSpan("extraction-sweep", async (span) => {
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
                    if (currentJob)
                      app.scheduler.removeById("extraction-sweep");
                    currentJob = new SimpleIntervalJob(
                      { milliseconds: newInterval, runImmediately: false },
                      createSweepTask(),
                      { id: "extraction-sweep", preventOverrun: true }
                    );
                    app.scheduler.addSimpleIntervalJob(currentJob);
                  }
                } else {
                  if (consecutiveEmpty >= BACKOFF_AFTER) {
                    if (currentJob)
                      app.scheduler.removeById("extraction-sweep");
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
                span.recordException(e);
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: e.message
                });
                throw e;
              } finally {
                span.end();
              }
            });
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
