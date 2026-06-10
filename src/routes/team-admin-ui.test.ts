import test from "ava";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import sinon from "sinon";
import type { TeamAdminUiDeps } from "./team-admin-ui.js";

/**
 * Shared in-memory MongoDB.
 * We do NOT mock collections; every route hits the real DB.
 */
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

test.beforeEach(async () => {
  await db.collection("org_summaries").deleteMany({});
});

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

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
  "GET /admin/team/org-summary requires authentication",
  async (t) => {
    const app = await buildApp();
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "GET",
      url: "/admin/team/org-summary"
    });
    t.is(res.statusCode, 401);
  }
);

test.serial(
  "POST /admin/team/org-summary requires authentication",
  async (t) => {
    const app = await buildApp();
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "POST",
      url: "/admin/team/org-summary",
      payload: { text: "hello" }
    });

    t.is(res.statusCode, 401);
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

test.serial(
  "GET /admin/team/org-summary returns nulls when document missing",
  async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "GET",
      url: "/admin/team/org-summary"
    });
    const body = JSON.parse(res.payload);

    t.is(res.statusCode, 200);
    t.is(body.summary, null);
    t.is(body.updated_at, null);
  }
);

test.serial(
  "GET /admin/team/org-summary returns existing document",
  async (t) => {
    await db.collection("org_summaries").insertOne({
      org_id: "default",
      summary: "Use TypeScript strict mode.",
      updated_at: new Date("2024-06-01T12:00:00.000Z")
    });

    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "GET",
      url: "/admin/team/org-summary"
    });
    const body = JSON.parse(res.payload);

    t.is(res.statusCode, 200);
    t.is(body.summary, "Use TypeScript strict mode.");
    t.is(body.updated_at, "2024-06-01T12:00:00.000Z");
  }
);

test.serial("GET /admin/team/org-summary prefers tenureOrgId", async (t) => {
  await db.collection("org_summaries").insertOne({
    org_id: "org-acme",
    summary: "Acme rules",
    updated_at: new Date()
  });

  const app = await buildApp({ userId: "u-1", orgId: "org-acme" });
  const deps = buildDeps();
  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({
    method: "GET",
    url: "/admin/team/org-summary"
  });
  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 200);
  t.is(body.summary, "Acme rules");
});

test.serial(
  "GET /admin/team/org-summary falls back to TENURE_DEFAULT_ORG_ID env var",
  async (t) => {
    const prev = process.env.TENURE_DEFAULT_ORG_ID;
    process.env.TENURE_DEFAULT_ORG_ID = "env-org";
    await db.collection("org_summaries").insertOne({
      org_id: "env-org",
      summary: "Env fallback",
      updated_at: new Date()
    });

    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "GET",
      url: "/admin/team/org-summary"
    });
    const body = JSON.parse(res.payload);

    t.is(body.summary, "Env fallback");

    if (prev === undefined) delete process.env.TENURE_DEFAULT_ORG_ID;
    else process.env.TENURE_DEFAULT_ORG_ID = prev;
  }
);

test.serial(
  "GET /admin/team/org-summary is not gated by isTeams",
  async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("solo");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "GET",
      url: "/admin/team/org-summary"
    });
    t.is(res.statusCode, 200);
    t.is(JSON.parse(res.payload).summary, null);
  }
);

test.serial(
  "GET /admin/team/org-summary handles partial doc gracefully",
  async (t) => {
    await db.collection("org_summaries").insertOne({ org_id: "default" });

    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "GET",
      url: "/admin/team/org-summary"
    });
    const body = JSON.parse(res.payload);

    t.is(body.summary, null);
    t.is(body.updated_at, null);
  }
);

test.serial("POST /admin/team/org-summary rejects missing text", async (t) => {
  const app = await buildApp({ userId: "u-1" });
  const deps = buildDeps();
  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({
    method: "POST",
    url: "/admin/team/org-summary",
    payload: {}
  });

  t.is(res.statusCode, 400);
  t.deepEqual(JSON.parse(res.payload), {
    error: { message: "text is required" }
  });
});

test.serial(
  "POST /admin/team/org-summary rejects whitespace-only text",
  async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "POST",
      url: "/admin/team/org-summary",
      payload: { text: "   \n\t  " }
    });

    t.is(res.statusCode, 400);
  }
);

test.serial(
  "POST /admin/team/org-summary rejects when default_model is missing",
  async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps({
      loadResult: { default_model: null, default_provider: "openai" }
    });
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "POST",
      url: "/admin/team/org-summary",
      payload: { text: "hello" }
    });

    t.is(res.statusCode, 400);
    t.is(
      JSON.parse(res.payload).error.message,
      "no default model or provider configured"
    );
  }
);

test.serial(
  "POST /admin/team/org-summary rejects when default_provider is missing",
  async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps({
      loadResult: { default_model: "gpt-4", default_provider: null }
    });
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "POST",
      url: "/admin/team/org-summary",
      payload: { text: "hello" }
    });

    t.is(res.statusCode, 400);
    t.is(
      JSON.parse(res.payload).error.message,
      "no default model or provider configured"
    );
  }
);

test.serial("POST generates, upserts and returns summary", async (t) => {
  const app = await buildApp({ userId: "u-1", orgId: "org-42" });
  const deps = buildDeps();
  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({
    method: "POST",
    url: "/admin/team/org-summary",
    payload: { text: "Use TypeScript. Enforce tracing." }
  });

  const body = JSON.parse(res.payload);

  t.is(res.statusCode, 200);
  t.true(body.ok);
  t.is(body.summary, "Synthesized governance prelude.");

  t.is(deps.providers.detectFromModel.callCount, 1);
  t.deepEqual(deps.providers.detectFromModel.firstCall.args, [
    "gpt-4",
    "openai"
  ]);

  const doc = await db
    .collection("org_summaries")
    .findOne({ org_id: "org-42" });
  t.truthy(doc);
  t.is(doc!.summary, "Synthesized governance prelude.");
  t.is(doc!.org_id, "org-42");
  t.true(doc!.updated_at instanceof Date);
});

test.serial("POST handles JSON-fenced LLM output", async (t) => {
  const app = await buildApp({ userId: "u-1" });
  const deps = buildDeps();
  deps.providers.detectFromModel.returns({
    call: sinon
      .stub()
      .resolves({ content: '```json\n{ "summary": "Fenced response." }\n```' })
  });

  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({
    method: "POST",
    url: "/admin/team/org-summary",
    payload: { text: "Policy doc" }
  });

  t.is(JSON.parse(res.payload).summary, "Fenced response.");

  const doc = await db
    .collection("org_summaries")
    .findOne({ org_id: "default" });
  t.is(doc?.summary, "Fenced response.");
});

test.serial("POST handles unparseable LLM JSON as 502", async (t) => {
  const app = await buildApp({ userId: "u-1" });
  const deps = buildDeps();
  deps.providers.detectFromModel.returns({
    call: sinon.stub().resolves({ content: "this is not json" })
  });

  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({
    method: "POST",
    url: "/admin/team/org-summary",
    payload: { text: "bad model" }
  });

  t.is(res.statusCode, 502);
  t.is(JSON.parse(res.payload).error.message, "LLM generation failed");
});

test.serial("POST returns 502 on LLM call rejection", async (t) => {
  const app = await buildApp({ userId: "u-1" });
  const deps = buildDeps();
  deps.providers.detectFromModel.returns({
    call: sinon.stub().rejects(new Error("model overloaded"))
  });

  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({
    method: "POST",
    url: "/admin/team/org-summary",
    payload: { text: "Some policy" }
  });

  t.is(res.statusCode, 502);
  t.is(JSON.parse(res.payload).error.message, "LLM generation failed");
});

test.serial(
  "POST falls back to default orgId when no org context",
  async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("teams");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "POST",
      url: "/admin/team/org-summary",
      payload: { text: "hello" }
    });

    t.is(res.statusCode, 200);
    const doc = await db
      .collection("org_summaries")
      .findOne({ org_id: "default" });
    t.truthy(doc);
  }
);

test.serial("POST falls back to env TENURE_DEFAULT_ORG_ID", async (t) => {
  const prev = process.env.TENURE_DEFAULT_ORG_ID;
  process.env.TENURE_DEFAULT_ORG_ID = "env-post-org";

  const app = await buildApp({ userId: "u-1" });
  const deps = buildDeps();
  const { registerTeamAdminUiRoute } = await importModule("teams");
  registerTeamAdminUiRoute(app, deps);

  const res = await app.inject({
    method: "POST",
    url: "/admin/team/org-summary",
    payload: { text: "hello" }
  });

  t.is(res.statusCode, 200);
  const doc = await db
    .collection("org_summaries")
    .findOne({ org_id: "env-post-org" });
  t.truthy(doc);

  if (prev === undefined) delete process.env.TENURE_DEFAULT_ORG_ID;
  else process.env.TENURE_DEFAULT_ORG_ID = prev;
});

test.serial(
  "POST /admin/team/org-summary is not gated by isTeams",
  async (t) => {
    const app = await buildApp({ userId: "u-1" });
    const deps = buildDeps();
    const { registerTeamAdminUiRoute } = await importModule("solo");
    registerTeamAdminUiRoute(app, deps);

    const res = await app.inject({
      method: "POST",
      url: "/admin/team/org-summary",
      payload: { text: "hello" }
    });

    t.is(res.statusCode, 200);
    t.true(JSON.parse(res.payload).ok);
  }
);
