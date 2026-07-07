import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import sinon from "sinon";

import { buildServer, type ServerDeps } from "./server.js";
import { getCollections } from "./db/collections.js";
import { SessionManager } from "./session/manager.js";
import { ContextBuilder } from "./context/contextBuilder.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ExtractionJobQueue } from "./jobs/queue.js";
import { ErrorLogger } from "./errors/logger.js";
import type { PersonaCache } from "./context/personaCache.js";
import type { FastifyInstance } from "fastify";
import type { ExtractionWorker } from "./extraction/worker.js";
import type { ProjectResumeService } from "./context/projectResume.js";
import type { WorkspaceStateCache } from "./workspace/stateCache.js";
import type { TokenService } from "./auth/tokenService.js";
import type { CredentialVault } from "./config/encryption.js";

const test = anyTest.serial as TestFn;

const USER_ID = "test-user";
const ROOT_TOKEN = "mp_root-token";
const CLIENT_TOKEN = "pat_client-token";
const AGENT_TOKEN = "agt_agent-token";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.afterEach(() => {
  sinon.restore();
});

function makeTokenDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "token-id",
    user_id: USER_ID,
    name: "Test Token",
    kind: "root",
    capabilities: ["admin"],
    project_scopes: null,
    token_prefix: "mp_",
    token_hash: "hash",
    created_at: new Date(),
    revoked_at: null,
    expires_at: null,
    encrypted_value: null,
    ...overrides
  };
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  const cols = getCollections(db);
  const tokenService = {
    validate: sinon.stub().callsFake(async (token: string) => {
      if (token === ROOT_TOKEN) {
        return { doc: makeTokenDoc() };
      }
      if (token === CLIENT_TOKEN) {
        return {
          doc: makeTokenDoc({
            _id: "client-token-id",
            kind: "client",
            name: "Client Token",
            token_prefix: "pat_",
            capabilities: ["chat", "beliefs:read", "beliefs:write", "extraction", "injection"]
          })
        };
      }
      if (token === AGENT_TOKEN) {
        return {
          doc: makeTokenDoc({
            _id: "agent-token-id",
            kind: "agent",
            name: "Agent Token",
            token_prefix: "agt_",
            capabilities: ["chat", "extraction", "injection"]
          })
        };
      }
      return null;
    }),
    touch: sinon.stub().resolves(),
    listTokens: sinon.stub().resolves([]),
    issueToken: sinon.stub(),
    revokeToken: sinon.stub(),
    revokeAllForUser: sinon.stub()
  } as unknown as TokenService;

  return {
    db,
    cols,
    sessions: new SessionManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedFacts: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
        searchText: sinon.stub().resolves([])
      } as any,
      { get: sinon.stub().resolves(null) } as unknown as PersonaCache
    ),
    providers: new ProviderRegistry(),
    jobs: new ExtractionJobQueue(db),
    runtimeStore: {
      load: sinon.stub().resolves({ onboarding_status: "pending" }),
      set: sinon.stub().resolves()
    } as any,
    errorLogger: new ErrorLogger(cols),
    persona: { get: sinon.stub().resolves(null) } as unknown as PersonaCache,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0)
    } as unknown as ExtractionWorker,
    userId: USER_ID,
    personaSummary: {
      ensureFresh: sinon.stub().resolves("regenerated")
    } as any,
    projectResume: {
      get: sinon.stub().resolves(null)
    } as unknown as ProjectResumeService,
    workspaceState: {
      get: sinon.stub().resolves(null),
      set: sinon.stub().resolves(),
      clear: sinon.stub().resolves()
    } as unknown as WorkspaceStateCache,
    tokenService,
    vault: {} as CredentialVault,
    ...overrides
  };
}

let servers: FastifyInstance[] = [];

async function createServer(overrides: Partial<ServerDeps> = {}) {
  const server = await buildServer(makeDeps(overrides));
  servers.push(server);
  return server;
}

test.afterEach.always(async () => {
  sinon.restore();
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

function auth(token = ROOT_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

test("GET /healthz returns 200 without auth header", async (t) => {
  const server = await createServer();
  const res = await server.inject({ method: "GET", url: "/healthz" });
  t.is(res.statusCode, 200);
});

test("GET /v1/models returns 401 without auth header", async (t) => {
  const server = await createServer();
  const res = await server.inject({ method: "GET", url: "/v1/models" });
  t.is(res.statusCode, 401);
});

test("GET /v1/models returns 401 with wrong bearer token", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: "Bearer wrong-token" }
  });
  t.is(res.statusCode, 401);
});

test("GET /v1/models returns 401 with malformed auth header", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: ROOT_TOKEN }
  });
  t.is(res.statusCode, 401);
});

test("POST /v1/chat/completions returns 401 without auth", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "x",
      messages: [{ role: "user", content: "hi" }]
    })
  });
  t.is(res.statusCode, 401);
});

test("401 body contains { error: { message: 'unauthorized' } }", async (t) => {
  const server = await createServer();
  const res = await server.inject({ method: "GET", url: "/v1/models" });
  const body = JSON.parse(res.body);
  t.deepEqual(body, { error: { message: "unauthorized" } });
});

test("GET /v1/models returns 200 with valid bearer token", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });
  t.is(res.statusCode, 200);
});

test("GET /healthz returns { ok: true } when db is reachable", async (t) => {
  const server = await createServer();
  const res = await server.inject({ method: "GET", url: "/healthz" });
  t.is(res.statusCode, 200);
  t.deepEqual(JSON.parse(res.body), { ok: true });
});

test("GET /healthz returns 503 when db is unreachable", async (t) => {
  sinon.stub(db, "command").rejects(new Error("connection refused"));
  const server = await createServer();

  const res = await server.inject({ method: "GET", url: "/healthz" });

  t.is(res.statusCode, 503);
  const body = JSON.parse(res.body);
  t.is(body.ok, false);
  t.is(body.error, "database unreachable");
});

test("GET /v1/models returns { object: 'list', data } envelope", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });
  const body = JSON.parse(res.body);
  t.is(body.object, "list");
  t.true(Array.isArray(body.data));
});

test("GET /v1/models returns empty data when no providers registered", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });
  t.deepEqual(JSON.parse(res.body).data, []);
});

test("GET /v1/models returns models from registered providers", async (t) => {
  const providers = new ProviderRegistry();
  providers.register({
    id: "stub",
    call: sinon.stub(),
    listModels: sinon.stub().resolves([
      { id: "model-a", object: "model", created: 0, owned_by: "stub" },
      { id: "model-b", object: "model", created: 0, owned_by: "stub" }
    ])
  } as any);

  const server = await createServer({ providers });
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });
  const body = JSON.parse(res.body);
  t.is(body.data.length, 2);
  t.is(body.data[0].id, "model-a");
  t.is(body.data[1].id, "model-b");
});

test("unhandled error returns 500 with type 'internal_error'", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").rejects(new Error("kaboom"));

  const server = await createServer({ providers });
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });

  t.is(res.statusCode, 500);
  const body = JSON.parse(res.body);
  t.is(body.error.type, "internal_error");
  t.is(body.error.message, "internal server error");
});

test("unhandled error does not leak original message or stack trace", async (t) => {
  const providers = new ProviderRegistry();
  sinon
    .stub(providers, "listModels")
    .rejects(new Error("secret db credentials in error"));

  const server = await createServer({ providers });
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });

  t.false(res.body.includes("secret db credentials"));
  t.false(res.body.includes("at Object"));
});

test("safe provider-like 5xx error forwards original message", async (t) => {
  const providers = new ProviderRegistry();
  sinon
    .stub(providers, "listModels")
    .rejects(new Error("No provider configured, add credentials in the UI"));

  const server = await createServer({ providers });
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });

  t.is(res.statusCode, 500);
  const body = JSON.parse(res.body);
  t.is(body.error.type, "internal_error");
  t.is(body.error.message, "No provider configured, add credentials in the UI");
});

test("error with statusCode < 500 returns original status and message", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").callsFake(async () => {
    const err = new Error("invalid scope parameter") as Error & {
      statusCode: number;
    };
    err.statusCode = 422;
    throw err;
  });

  const server = await createServer({ providers });
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });

  t.is(res.statusCode, 422);
  const body = JSON.parse(res.body);
  t.is(body.error.type, "client_error");
  t.is(body.error.message, "invalid scope parameter");
});

test("error handler logs to ErrorLogger on 5xx", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").rejects(new Error("should be logged"));

  const errorLogger = {
    log: sinon.stub().resolves()
  } as unknown as ErrorLogger;

  const server = await createServer({ providers, errorLogger });
  await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });

  t.true((errorLogger.log as sinon.SinonStub).calledOnce);
  const input = (errorLogger.log as sinon.SinonStub).firstCall.args[0];
  t.is(input.message, "should be logged");
  t.is(input.user_id, USER_ID);
});

test("error handler sets severity 'error' for 5xx errors", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").rejects(new Error("boom"));

  const errorLogger = {
    log: sinon.stub().resolves()
  } as unknown as ErrorLogger;

  const server = await createServer({ providers, errorLogger });
  await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });

  const input = (errorLogger.log as sinon.SinonStub).firstCall.args[0];
  t.is(input.severity, "error");
});

test("error handler sets severity 'warning' for 4xx errors", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").callsFake(async () => {
    const err = new Error("bad input") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  });

  const errorLogger = {
    log: sinon.stub().resolves()
  } as unknown as ErrorLogger;

  const server = await createServer({ providers, errorLogger });
  await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });

  const input = (errorLogger.log as sinon.SinonStub).firstCall.args[0];
  t.is(input.severity, "warning");
});

test("error handler passes the Error object for stack extraction", async (t) => {
  const providers = new ProviderRegistry();
  const original = new TypeError("type mismatch");
  sinon.stub(providers, "listModels").rejects(original);

  const errorLogger = {
    log: sinon.stub().resolves()
  } as unknown as ErrorLogger;

  const server = await createServer({ providers, errorLogger });
  await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });

  const input = (errorLogger.log as sinon.SinonStub).firstCall.args[0];
  t.is(input.error, original);
});

test("error handler does not throw when ErrorLogger rejects", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").rejects(new Error("trigger"));

  const errorLogger = {
    log: sinon.stub().rejects(new Error("logger broken"))
  } as unknown as ErrorLogger;

  const server = await createServer({ providers, errorLogger });
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth()
  });

  t.is(res.statusCode, 500);
});

test("successful auth applies token request context and touches token", async (t) => {
  const tokenService = {
    validate: sinon.stub().resolves({
      doc: makeTokenDoc({
        _id: "client-token-id",
        user_id: "scoped-user",
        kind: "client",
        name: "Client Token",
        capabilities: ["chat", "beliefs:read"],
        project_scopes: ["project:alpha"],
        token_prefix: "pat_"
      })
    }),
    touch: sinon.stub().resolves(),
    listTokens: sinon.stub().resolves([]),
    issueToken: sinon.stub(),
    revokeToken: sinon.stub(),
    revokeAllForUser: sinon.stub()
  } as unknown as TokenService;

  const providers = new ProviderRegistry();
  const listModels = sinon.stub().resolves([]);
  sinon.stub(providers, "listModels").callsFake(listModels);

  const server = await createServer({ providers, tokenService });
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(CLIENT_TOKEN)
  });

  t.is(res.statusCode, 200);
  t.true((tokenService.validate as sinon.SinonStub).calledOnceWithExactly(CLIENT_TOKEN));
  t.true((tokenService.touch as sinon.SinonStub).calledOnceWithExactly("client-token-id"));
});

test("POST /v1/chat/completions returns 403 when token lacks chat capability", async (t) => {
  const tokenService = {
    validate: sinon.stub().resolves({
      doc: makeTokenDoc({
        _id: "client-no-chat",
        kind: "client",
        capabilities: ["beliefs:read"],
        token_prefix: "pat_"
      })
    }),
    touch: sinon.stub().resolves(),
    listTokens: sinon.stub().resolves([]),
    issueToken: sinon.stub(),
    revokeToken: sinon.stub(),
    revokeAllForUser: sinon.stub()
  } as unknown as TokenService;

  const server = await createServer({ tokenService });
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      ...auth(CLIENT_TOKEN),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "x",
      messages: [{ role: "user", content: "hi" }]
    })
  });

  t.is(res.statusCode, 403);
  const body = JSON.parse(res.body);
  t.is(body.error.message, 'This endpoint requires capability "chat"');
  t.is(body.error.required_capability, "chat");
});

test("GET /admin returns 403 for non-root token", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/admin/config",
    headers: auth(CLIENT_TOKEN)
  });

  t.is(res.statusCode, 403);
  const body = JSON.parse(res.body);
  t.is(body.error.message, "Only the root token can access admin endpoints");
});

test("GET beliefs route returns 403 when token lacks beliefs:read", async (t) => {
  const tokenService = {
    validate: sinon.stub().resolves({
      doc: makeTokenDoc({
        _id: "client-no-beliefs-read",
        kind: "client",
        capabilities: ["chat"],
        token_prefix: "pat_"
      })
    }),
    touch: sinon.stub().resolves(),
    listTokens: sinon.stub().resolves([]),
    issueToken: sinon.stub(),
    revokeToken: sinon.stub(),
    revokeAllForUser: sinon.stub()
  } as unknown as TokenService;

  const server = await createServer({ tokenService });
  const res = await server.inject({
    method: "GET",
    url: "/v1/beliefs",
    headers: auth(CLIENT_TOKEN)
  });

  t.is(res.statusCode, 403);
  const body = JSON.parse(res.body);
  t.is(body.error.message, 'This endpoint requires capability "beliefs:read"');
  t.is(body.error.required_capability, "beliefs:read");
});

test("POST beliefs route returns 403 for agent token even with write-like intent", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "POST",
    url: "/v1/beliefs",
    headers: {
      ...auth(AGENT_TOKEN),
      "content-type": "application/json"
    },
    body: JSON.stringify({ content: "x" })
  });

  t.is(res.statusCode, 403);
  const body = JSON.parse(res.body);
  t.is(
    body.error.message,
    "Agent tokens cannot modify beliefs. Use a client token for manual belief management."
  );
  t.is(body.error.token_kind, "agent");
});

test("POST beliefs route returns 403 when client token lacks beliefs:write", async (t) => {
  const tokenService = {
    validate: sinon.stub().resolves({
      doc: makeTokenDoc({
        _id: "client-no-beliefs-write",
        kind: "client",
        capabilities: ["beliefs:read"],
        token_prefix: "pat_"
      })
    }),
    touch: sinon.stub().resolves(),
    listTokens: sinon.stub().resolves([]),
    issueToken: sinon.stub(),
    revokeToken: sinon.stub(),
    revokeAllForUser: sinon.stub()
  } as unknown as TokenService;

  const server = await createServer({ tokenService });
  const res = await server.inject({
    method: "POST",
    url: "/v1/beliefs",
    headers: {
      ...auth(CLIENT_TOKEN),
      "content-type": "application/json"
    },
    body: JSON.stringify({ content: "x" })
  });

  t.is(res.statusCode, 403);
  const body = JSON.parse(res.body);
  t.is(body.error.message, 'This endpoint requires capability "beliefs:write"');
  t.is(body.error.required_capability, "beliefs:write");
});
