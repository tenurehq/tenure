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

async function createScimUser(userName: string) {
  const res = await app.inject({
    method: "POST",
    url: "/scim/v2/Users",
    headers: { authorization: "Bearer scim_secret_123" },
    payload: {
      userName,
      active: true,
      emails: [{ value: userName, primary: true }]
    }
  });
  if (res.statusCode !== 201) {
    throw new Error(
      `createScimUser failed for ${userName}: ${res.statusCode} ${res.payload}`
    );
  }
  return JSON.parse(res.payload);
}

async function insertPat(userId: string, rawToken: string) {
  await deps.cols.api_tokens.insertOne({
    token_hash: createHash("sha256").update(rawToken).digest("hex"),
    user_id: userId,
    name: "test token",
    created_at: new Date()
  });
}

async function probeAuth(rawToken: string) {
  return app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${rawToken}` }
  });
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test-scim");

  process.env.TENURE_DISABLE_JOBS = "true";
  process.env.TENURE_MODE = "teams";
  process.env.TENURE_SCIM_TOKEN = "scim_secret_123";

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
    providers: { listModels: async () => [] },
    jobs: {},
    runtimeStore: { load: async () => ({}) },
    errorLogger: { log: async () => {} },
    persona: {},
    apiToken: "mp_root_teams",
    userId: "local-admin",
    compactionRunner: {},
    extractionWorker: {},
    personaSummary: {},
    workspaceState: {}
  };
});

test.beforeEach(async () => {
  await deps.cols.api_tokens.deleteMany({});
  await deps.db.collection("scim_users").deleteMany({});
  process.env.TENURE_MODE = "teams";
  process.env.TENURE_SCIM_TOKEN = "scim_secret_123";
  app = await buildApp();
});

test.afterEach(async () => {
  await app.close();
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test("SCIM returns 401 for invalid bearer token", async (t) => {
  const res = await app.inject({
    method: "GET",
    url: "/scim/v2/Users",
    headers: { authorization: "Bearer wrong_token" }
  });
  t.is(res.statusCode, 401);
});

test("SCIM returns 503 when SCIM token env var is missing", async (t) => {
  // Close the app built in beforeEach (it captured the token at startup)
  await app.close();
  const saved = process.env.TENURE_SCIM_TOKEN;
  delete process.env.TENURE_SCIM_TOKEN;

  try {
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scim/v2/Users",
      headers: { authorization: "Bearer scim_secret_123" }
    });
    t.is(res.statusCode, 503);
  } finally {
    process.env.TENURE_SCIM_TOKEN = saved;
  }
});

test("SCIM routes return 404 in single mode", async (t) => {
  await app.close();
  process.env.TENURE_MODE = "single";

  try {
    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scim/v2/Users",
      headers: { authorization: "Bearer scim_secret_123" }
    });
    t.is(res.statusCode, 404);
  } finally {
    process.env.TENURE_MODE = "teams";
  }
});

test("PATCH deprovision revokes PATs and blocks resource access", async (t) => {
  const alice = await createScimUser("alice@example.com");
  const bob = await createScimUser("bob@example.com");
  const aliceToken = "tpat_alice_patch_001";
  const bobToken = "tpat_bob_patch_001";
  await insertPat("alice@example.com", aliceToken);
  await insertPat("bob@example.com", bobToken);

  t.is((await probeAuth(aliceToken)).statusCode, 200);
  t.is((await probeAuth(bobToken)).statusCode, 200);

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/scim/v2/Users/${alice.id}`,
    headers: {
      authorization: "Bearer scim_secret_123",
      "content-type": "application/json"
    },
    payload: { Operations: [{ op: "replace", value: { active: false } }] }
  });

  t.is(patchRes.statusCode, 200);
  t.is(JSON.parse(patchRes.payload).active, false);

  const docs = await deps.cols.api_tokens
    .find({ user_id: "alice@example.com" })
    .toArray();
  t.is(docs.length, 1);
  t.truthy(docs[0].revoked_at);

  t.is((await probeAuth(aliceToken)).statusCode, 401);

  const bobRes = await probeAuth(bobToken);
  t.is(bobRes.statusCode, 200);
});

test("PATCH deprovisioning an already-inactive user is idempotent", async (t) => {
  const alice = await createScimUser("alice@example.com");
  const aliceToken = "tpat_alice_idempotent_001";
  await insertPat("alice@example.com", aliceToken);

  await app.inject({
    method: "PATCH",
    url: `/scim/v2/Users/${alice.id}`,
    headers: {
      authorization: "Bearer scim_secret_123",
      "content-type": "application/json"
    },
    payload: { Operations: [{ op: "replace", value: { active: false } }] }
  });

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/scim/v2/Users/${alice.id}`,
    headers: {
      authorization: "Bearer scim_secret_123",
      "content-type": "application/json"
    },
    payload: { Operations: [{ op: "replace", value: { active: false } }] }
  });

  t.is(patchRes.statusCode, 200);
  t.is(JSON.parse(patchRes.payload).active, false);

  const docs = await deps.cols.api_tokens
    .find({ user_id: "alice@example.com" })
    .toArray();
  t.is(docs.length, 1);
  t.truthy(docs[0].revoked_at);

  t.is((await probeAuth(aliceToken)).statusCode, 401);
});

test("DELETE deprovision revokes PATs and blocks resource access", async (t) => {
  const bob = await createScimUser("bob@example.com");
  const bobToken = "tpat_bob_delete_001";
  await insertPat("bob@example.com", bobToken);

  t.is((await probeAuth(bobToken)).statusCode, 200);

  const delRes = await app.inject({
    method: "DELETE",
    url: `/scim/v2/Users/${bob.id}`,
    headers: { authorization: "Bearer scim_secret_123" }
  });

  t.is(delRes.statusCode, 204);

  const docs = await deps.cols.api_tokens
    .find({ user_id: "bob@example.com" })
    .toArray();
  t.is(docs.length, 1);
  t.truthy(docs[0].revoked_at);

  t.is((await probeAuth(bobToken)).statusCode, 401);

  const anon = await app.inject({ method: "GET", url: "/v1/test-auth" });
  t.is(anon.statusCode, 401);
});

test("DELETE deprovision of user with no PATs succeeds cleanly", async (t) => {
  const carol = await createScimUser("carol@example.com");

  const delRes = await app.inject({
    method: "DELETE",
    url: `/scim/v2/Users/${carol.id}`,
    headers: { authorization: "Bearer scim_secret_123" }
  });

  t.is(delRes.statusCode, 204);

  const docs = await deps.cols.api_tokens
    .find({ user_id: "carol@example.com" })
    .toArray();
  t.is(docs.length, 0);
});
