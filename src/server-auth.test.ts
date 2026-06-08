import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { createHash } from "node:crypto";

const test = anyTest.serial as TestFn;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: any;
let app: any;
let deps: any;

async function buildApp() {
  const { buildServer } = await import("./server.js");
  const instance = await buildServer(deps);
  instance.get("/v1/test-auth", async (req: any) => ({
    userId: req.tenureUserId,
    method: req.tenureAuthMethod
  }));
  return instance;
}

async function insertPat(
  cols: any,
  userId: string,
  rawToken: string,
  overrides: Record<string, unknown> = {}
) {
  await cols.api_tokens.insertOne({
    token_hash: createHash("sha256").update(rawToken).digest("hex"),
    user_id: userId,
    name: "test token",
    created_at: new Date(),
    ...overrides
  });
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test-auth");

  process.env.TENURE_DISABLE_JOBS = "true";
  process.env.OIDC_PROXY_HEADER = "x-user-id";

  deps = {
    db,
    cols: {
      api_tokens: db.collection("api_tokens"),
      beliefs: db.collection("beliefs"),
      beliefs_plain: db.collection("beliefs_plain"),
      config: db.collection("config"),
      turns: db.collection("turns"),
      sessions: db.collection("sessions"),
      jobs: db.collection("jobs"),
      errors: db.collection("errors"),
      topic_index: db.collection("topic_index"),
      persona_cache: db.collection("persona_cache"),
      compaction_log: db.collection("compaction_log"),
      injection_audit: db.collection("injection_audit")
    },
    sessions: {},
    history: {},
    context: {},
    providers: { listModels: async () => [{ id: "gpt-4" }] },
    jobs: {},
    runtimeStore: { load: async () => ({}) },
    errorLogger: { log: async () => {} },
    persona: {},
    apiToken: "mp_test_root_token",
    userId: "local-admin",
    compactionRunner: {},
    extractionWorker: {},
    personaSummary: {},
    workspaceState: {}
  };
});

test.beforeEach(async () => {
  await deps.cols.api_tokens.deleteMany({});
  delete process.env.TENURE_MODE;
  // Reset apiToken in case a rotation test changed it
  deps.apiToken = "mp_test_root_token";
  app = await buildApp();
});

test.afterEach(async () => {
  await app.close();
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test("proxy header authenticates request and sets tenureUserId", async (t) => {
  const res = await app.inject({
    method: "GET",
    url: "/v1/test-auth",
    headers: { "x-user-id": "alice@example.com" }
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.is(body.userId, "alice@example.com");
  t.is(body.method, "proxy");
});

test("proxy header takes priority over a valid PAT", async (t) => {
  const token = "tpat_priority_001";
  await insertPat(deps.cols, "pat-user@example.com", token);

  const res = await app.inject({
    method: "GET",
    url: "/v1/test-auth",
    headers: {
      "x-user-id": "proxy-user@example.com",
      authorization: `Bearer ${token}`
    }
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.is(body.userId, "proxy-user@example.com");
  t.is(body.method, "proxy");
});

test("root token works in single mode", async (t) => {
  process.env.TENURE_MODE = "single";

  const res = await app.inject({
    method: "GET",
    url: "/v1/test-auth",
    headers: { authorization: `Bearer ${deps.apiToken}` }
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.is(body.userId, deps.userId);
  t.is(body.method, "root");
});

test("root token rotation invalidates old token and activates new one", async (t) => {
  process.env.TENURE_MODE = "single";
  const originalToken = deps.apiToken;

  const rotateRes = await app.inject({
    method: "POST",
    url: "/admin/token/rotate",
    headers: { authorization: `Bearer ${originalToken}` }
  });
  t.is(rotateRes.statusCode, 200);
  const { token: newToken } = JSON.parse(rotateRes.payload);

  const oldRes = await app.inject({
    method: "GET",
    url: "/v1/test-auth",
    headers: { authorization: `Bearer ${originalToken}` }
  });
  t.is(oldRes.statusCode, 401);

  const newRes = await app.inject({
    method: "GET",
    url: "/v1/test-auth",
    headers: { authorization: `Bearer ${newToken}` }
  });
  t.is(newRes.statusCode, 200);
  t.is(JSON.parse(newRes.payload).method, "root");
});

test("root token is blocked on non-bootstrap paths in teams mode", async (t) => {
  process.env.TENURE_MODE = "teams";

  const res = await app.inject({
    method: "GET",
    url: "/v1/test-auth",
    headers: { authorization: `Bearer ${deps.apiToken}` }
  });

  t.is(res.statusCode, 403);
  t.true(
    JSON.parse(res.payload).error.message.includes("Root token cannot access")
  );
});

test("root token is allowed on all bootstrap paths in teams mode", async (t) => {
  process.env.TENURE_MODE = "teams";

  const bootstrapPaths = [
    "/v1/models",
    "/admin/config",
    "/admin/providers",
    "/v1/onboarding/questions",
    "/v1/onboarding/validate-model"
  ];

  for (const path of bootstrapPaths) {
    const res = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${deps.apiToken}` }
    });
    t.not(res.statusCode, 403, `root token should not be forbidden on ${path}`);
  }
});

test("root token is forbidden on chat completions in teams mode", async (t) => {
  process.env.TENURE_MODE = "teams";

  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${deps.apiToken}` },
    payload: { model: "gpt-4", messages: [] }
  });

  t.is(res.statusCode, 403);
});

test("valid PAT authenticates on allowed paths and refreshes last_used_at", async (t) => {
  const token = "tpat_valid_123";
  const hash = createHash("sha256").update(token).digest("hex");
  await insertPat(deps.cols, "user1@example.com", token);

  const res = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${token}` }
  });

  t.is(res.statusCode, 200);

  const doc = await deps.cols.api_tokens.findOne({ token_hash: hash });
  t.truthy(doc?.last_used_at);
});

test("PAT is forbidden on admin paths", async (t) => {
  const token = "tpat_admin_123";
  await insertPat(deps.cols, "user1@example.com", token);

  const res = await app.inject({
    method: "GET",
    url: "/admin/config",
    headers: { authorization: `Bearer ${token}` }
  });

  t.is(res.statusCode, 403);
  t.is(JSON.parse(res.payload).error.message, "forbidden");
});

test("revoked PAT cannot access allowed paths", async (t) => {
  const token = "tpat_revoked_456";
  const hash = createHash("sha256").update(token).digest("hex");
  await insertPat(deps.cols, "revoked@example.com", token);

  const before = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${token}` }
  });
  t.is(before.statusCode, 200);

  await deps.cols.api_tokens.updateOne(
    { token_hash: hash },
    { $set: { revoked_at: new Date() } }
  );

  const after = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${token}` }
  });
  t.is(after.statusCode, 401);
});

test("unknown or missing token returns 401", async (t) => {
  const res = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: "Bearer unknown_token" }
  });
  t.is(res.statusCode, 401);
});

test("unauthenticated request to sensitive path returns 401 in teams mode", async (t) => {
  process.env.TENURE_MODE = "teams";
  for (const path of [
    "/v1/chat/completions",
    "/v1/messages",
    "/admin/config"
  ]) {
    const res = await app.inject({ method: "GET", url: path });
    t.is(res.statusCode, 401, `${path} should require auth`);
  }
});
