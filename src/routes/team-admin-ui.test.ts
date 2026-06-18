import test from "ava";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import sinon from "sinon";
import type { TeamAdminUiDeps } from "./team-admin-ui.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test-admin-ui");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

function buildDeps(overrides: { loadResult?: Record<string, unknown> } = {}) {
  return {
    runtimeStore: {
      set: sinon.stub().resolves(),
      load: sinon.stub().resolves({
        default_model: "gpt-4",
        default_provider: "openai",
        ...overrides.loadResult
      })
    },
    providers: {
      detectFromModel: sinon.stub().returns({
        call: sinon.stub().resolves({
          content: '{"summary": "Synthesized governance prelude."}'
        })
      })
    },
    db
  } as unknown as TeamAdminUiDeps & {
    runtimeStore: { set: sinon.SinonStub; load: sinon.SinonStub };
    providers: { detectFromModel: sinon.SinonStub };
  };
}

async function buildApp(
  opts: {
    userId?: string;
    orgId?: string;
    nonce?: string;
  } = {}
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  if (opts.nonce !== undefined) {
    app.addHook("onRequest", async (_req, reply) => {
      (reply.raw as any).cspNonce = opts.nonce;
    });
  }

  app.addHook("preHandler", async (req) => {
    if (opts.userId !== undefined) (req as any).tenureUserId = opts.userId;
    if (opts.orgId !== undefined) (req as any).tenureOrgId = opts.orgId;
  });

  return app;
}

/**
 * Re-import the module under a specific TENURE_MODE so the top-level
 * `const isTeams = ...` is re-evaluated. The query string busts the
 * ESM cache under tsx.
 */
async function importModule(mode: "teams" | "solo") {
  const prev = process.env.TENURE_MODE;
  if (mode === "teams") process.env.TENURE_MODE = "teams";
  else delete process.env.TENURE_MODE;

  const qs = `?mode=${mode}&t=${Date.now()}`;
  const mod = await import(`./team-admin-ui.js${qs}`);

  if (prev === undefined) delete process.env.TENURE_MODE;
  else process.env.TENURE_MODE = prev;

  return mod as {
    registerTeamAdminUiRoute: typeof import("./team-admin-ui.js").registerTeamAdminUiRoute;
  };
}

test.serial("GET /admin/team redirects in solo mode before auth", async (t) => {
  const app = await buildApp(); // no auth
  const deps = buildDeps();
  const { registerTeamAdminUiRoute } = await importModule("solo");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({ method: "GET", url: "/admin/team" });

  t.is(res.statusCode, 302);
  t.is(res.headers.location, "/admin");
});

test.serial(
  "PUT /admin/team/memory-mode returns 403 in solo mode",
  async (t) => {
    const app = await buildApp(); // no auth
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("solo");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "PUT",
      url: "/admin/team/memory-mode",
      payload: { memory_mode: "curated" }
    });

    t.is(res.statusCode, 403);
    t.deepEqual(JSON.parse(res.payload), {
      error: { message: "Not in teams mode" }
    });
    t.false(deps.runtimeStore.set.called);
  }
);

test.serial("GET /admin/team requires SSO auth", async (t) => {
  const app = await buildApp(); // no userId
  const deps = buildDeps();
  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({ method: "GET", url: "/admin/team" });

  t.is(res.statusCode, 401);
  t.deepEqual(JSON.parse(res.payload), {
    error: { message: "SSO authentication required" }
  });
});

test.serial(
  "GET /admin/team treats empty tenureUserId as unauthenticated",
  async (t) => {
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (req) => {
      (req as any).tenureUserId = "";
    });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({ method: "GET", url: "/admin/team" });
    t.is(res.statusCode, 401);
  }
);

test.serial(
  "PUT /admin/team/memory-mode requires authentication",
  async (t) => {
    const app = await buildApp();
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "PUT",
      url: "/admin/team/memory-mode",
      payload: { memory_mode: "curated" }
    });

    t.is(res.statusCode, 401);
    t.deepEqual(JSON.parse(res.payload), {
      error: { message: "Unauthorized" }
    });
  }
);

test.serial(
  "GET /admin/team returns HTML with embedded ssoUserId",
  async (t) => {
    const app = await buildApp({ userId: "sso|user-42" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({ method: "GET", url: "/admin/team" });

    t.is(res.statusCode, 200);
    t.is(res.headers["content-type"], "text/html; charset=utf-8");
    t.true(res.payload.includes("Team settings"));
    t.true(res.payload.includes('const ssoUserId = "sso|user-42"'));
  }
);

test.serial(
  "GET /admin/team includes CSP nonce when present on reply.raw",
  async (t) => {
    const app = await buildApp({ userId: "u-1", nonce: "nonce-abc-123" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({ method: "GET", url: "/admin/team" });
    t.is(res.statusCode, 200);
    t.true(res.payload.includes('nonce="nonce-abc-123"'));
  }
);

test.serial(
  "GET /admin/team omits nonce attribute when cspNonce is absent",
  async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({ method: "GET", url: "/admin/team" });
    t.is(res.statusCode, 200);
    t.false(res.payload.includes("nonce="));
  }
);

test.serial("PUT /admin/team/memory-mode rejects invalid mode", async (t) => {
  const app = await buildApp({ userId: "u-1" });
  const deps = buildDeps();
  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({
    method: "PUT",
    url: "/admin/team/memory-mode",
    payload: { memory_mode: "super_mode" }
  });

  t.is(res.statusCode, 400);
  t.deepEqual(JSON.parse(res.payload), {
    error: { message: "Invalid memory mode" }
  });
  t.false(deps.runtimeStore.set.called);
});

test.serial("PUT /admin/team/memory-mode is case-sensitive", async (t) => {
  const app = await buildApp({ userId: "u-1" });
  const deps = buildDeps();
  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({
    method: "PUT",
    url: "/admin/team/memory-mode",
    payload: { memory_mode: "Curated" }
  });

  t.is(res.statusCode, 400);
});

["inject_only", "curated", "autonomous", "reflective"].forEach((mode) => {
  test.serial(`PUT accepts memory_mode=${mode} and persists it`, async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "PUT",
      url: "/admin/team/memory-mode",
      payload: { memory_mode: mode }
    });

    t.is(res.statusCode, 200);
    t.deepEqual(JSON.parse(res.payload), { ok: true });
    t.is(deps.runtimeStore.set.callCount, 1);
    t.deepEqual(deps.runtimeStore.set.firstCall.args, ["memory_mode", mode]);
  });
});

test.serial(
  "PUT /admin/team/memory-mode ignores extra body fields",
  async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "PUT",
      url: "/admin/team/memory-mode",
      payload: { memory_mode: "curated", extra: "ignored" }
    });

    t.is(res.statusCode, 200);
    t.deepEqual(JSON.parse(res.payload), { ok: true });
  }
);
