/**
 * chat.beliefs.integration.test.ts
 *
 * Tests that beliefs are correctly injected into the system prompt sent to the
 * provider, and that the injection audit record is written to MongoDB.
 *
 * Two paths are tested separately:
 *
 *   1. PINNED FACTS PATH — beliefs with `pinned: true` are fetched via a
 *      regular MongoDB query in BeliefsReader.listPinnedFacts(). No Atlas
 *      Search involved. searchText is stubbed to return [] so only pinned
 *      facts flow through.
 *
 *   2. SIMULATED ATLAS PATH — searchText is stubbed to return seeded beliefs
 *      as if Atlas had matched them. This exercises the full relevantBeliefs
 *      branch of ContextBuilder including score projection and the injection
 *      audit snapshot.
 *
 * What is REAL:
 *   - SessionManager, ExtractionJobQueue, BeliefsReader (regular queries),
 *     ContextBuilder, InjectionAuditLogger, PersonaCache — all against
 *     in-memory MongoDB
 *   - The system prompt is built by the real buildSystemPrompt()
 *   - The adapter receives the real assembled system prompt — we spy on
 *     adapter.call() to assert on what it was actually passed
 *
 * What is STUBBED:
 *   - adapter.call() / callStream() — no real LLM
 *   - BeliefsReader.searchText() — returns [] or a seeded set depending on
 *     the test; Atlas Search is not available in MongoMemoryServer
 *   - BeliefsReader.expandRelationParticipants() — always []
 */

process.env.OIDC_PROXY_HEADER = "x-test-user";

import test from "ava";
import sinon from "sinon";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { randomUUID, createHash } from "node:crypto";

import { registerChatRoute, type ChatDeps } from "../routes/chat.js";
import { SessionManager } from "../session/manager.js";
import { ContextBuilder } from "../context/contextBuilder.js";
import { BeliefsReader, type ScoredBelief } from "../context/beliefsReader.js";
import { PersonaCache } from "../context/personaCache.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ExtractionJobQueue } from "../jobs/queue.js";
import { WorkspaceStateCache } from "../workspace/stateCache.js";
import { InjectionAuditLogger } from "../audit/injectionAuditLogger.js";
import { getCollections, type Collections } from "../db/collections.js";
import { ensureIndexes } from "../db/indexes.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { Belief } from "../types/belief.js";
import { SIDECAR_BEGIN, SIDECAR_END } from "../sidecar/splitter.js";

let mongod: MongoMemoryServer;
let mongoClient: MongoClient;
let db: Db;
let cols: Collections;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  mongoClient = new MongoClient(mongod.getUri());
  await mongoClient.connect();
  db = mongoClient.db("tenure_beliefs_test");
  cols = getCollections(db);
  await ensureIndexes(cols);
});

test.after.always(async () => {
  await mongoClient?.close();
  await mongod?.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    cols.sessions.deleteMany({}),
    cols.jobs.deleteMany({}),
    cols.beliefs.deleteMany({}),
    cols.turns.deleteMany({}),
    cols.persona_cache.deleteMany({}),
    cols.injection_audit.deleteMany({}),
    cols.api_tokens.deleteMany({}),
    db.collection("workspace_state").deleteMany({})
  ]);
  sinon.restore();
});

const USER_ID = "belief-test-user";
const MODEL = "claude-sonnet-4-5";
const PROXY_HEADER = "x-test-user";
const SCOPE = ["domain:code/typescript"];

function makeBelief(
  overrides: Partial<Belief> & { canonical_name: string; content: string }
): Belief {
  const { canonical_name, content, ...rest } = overrides;
  return {
    _id: randomUUID(),
    user_id: USER_ID,
    canonical_name,
    content,
    type: "fact" as Belief["type"],
    subtype: null,
    aliases: [],
    scope: SCOPE,
    pinned: false,
    epistemic_status: "active",
    confidence: 0.9,
    why_it_matters: "",
    resolved_at: null,
    superseded_by: null,
    agent_id: null,
    reinforcement_count: 0,
    last_reinforced_at: new Date(),
    user_edited: false,
    created_at: new Date(),
    updated_at: new Date(),
    change_log: [],
    provenance: {
      session_id: "test-session",
      turn_id: "test-turn",
      extracted_at: new Date(),
      source_model: "test-model"
    },
    ...rest
  };
}

type StubbedChatAdapter = ProviderAdapter & {
  call: sinon.SinonStub;
  callStream: sinon.SinonStub;
  listModels: sinon.SinonStub;
};

interface AppBundle {
  app: FastifyInstance;
  deps: ChatDeps;
  adapter: StubbedChatAdapter;
  searchTextStub: sinon.SinonStub;
}

interface SecureAppBundle extends AppBundle {
  rootToken: string;
  rootUserId: string;
}

async function buildDeps(): Promise<Omit<AppBundle, "app">> {
  const adapterStub = {
    id: "anthropic",
    call: sinon.stub().resolves({
      content: "Here is my response",
      model: MODEL,
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 20 },
      toolCalls: []
    }),
    callStream: sinon.stub(),
    listModels: sinon.stub().resolves([])
  } as unknown as StubbedChatAdapter;

  const registry = new ProviderRegistry();
  registry.register(adapterStub as unknown as ProviderAdapter);

  const beliefsReader = new BeliefsReader(cols.beliefs);
  const searchTextStub = sinon.stub(beliefsReader, "searchText").resolves([]);
  sinon.stub(beliefsReader, "expandRelationParticipants").resolves([]);

  const deps: ChatDeps = {
    sessions: new SessionManager(db),
    context: new ContextBuilder(
      beliefsReader,
      new PersonaCache(cols.persona_cache)
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0)
    } as any,
    runtimeStore: {
      load: sinon.stub().resolves({
        extraction_enabled: true,
        injection_enabled: true,
        managed_history_token_cap: 120_000,
        compaction_mode: "aggressive",
        scope_auto_detect: true,
        ide_extraction_enabled: true
      }),
      set: sinon.stub().resolves()
    } as any,
    errorLogger: { log: sinon.stub().resolves() } as any,
    workspaceState: new WorkspaceStateCache(db),
    injectionAudit: new InjectionAuditLogger(cols.injection_audit)
  };

  return { deps, adapter: adapterStub, searchTextStub };
}

async function buildApp(): Promise<AppBundle> {
  const { deps, adapter, searchTextStub } = await buildDeps();
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req: any) => {
    const userId = req.headers[PROXY_HEADER] as string | undefined;
    if (userId) {
      req.tenureUserId = userId;
      req.tenureAuthMethod = "proxy";
    }
  });

  registerChatRoute(app, deps);
  await app.ready();

  return { app, deps, adapter, searchTextStub };
}

async function buildSecureApp(): Promise<SecureAppBundle> {
  const { deps, adapter, searchTextStub } = await buildDeps();
  const app = Fastify({ logger: false });
  const rootToken = "root-secret-token";
  const rootUserId = "root-user";

  app.addHook("onRequest", async (req: any, reply: any) => {
    const proxyHeader = process.env.OIDC_PROXY_HEADER?.toLowerCase() || "";
    const pathOnly = req.url.split("?")[0];

    if (proxyHeader) {
      const userId = req.headers[proxyHeader] as string | undefined;
      if (userId) {
        req.tenureUserId = userId;
        req.tenureAuthMethod = "proxy";
        return;
      }
    }

    const requiresAuth =
      pathOnly.startsWith("/v1/") ||
      (pathOnly.startsWith("/admin/") && pathOnly !== "/admin/");

    if (!requiresAuth) return;

    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!bearer) {
      return reply.code(401).send({ error: { message: "unauthorized" } });
    }

    if (bearer === rootToken) {
      req.tenureUserId = rootUserId;
      req.tenureAuthMethod = "root";
      return;
    }

    const hash = createHash("sha256").update(bearer).digest("hex");
    const pat = await cols.api_tokens.findOne({
      token_hash: hash,
      revoked_at: null
    });

    if (pat) {
      const allowed = new Set([
        "/v1/chat/completions",
        "/v1/messages",
        "/v1/models",
        "/v1/ws/beliefs"
      ]);
      if (!allowed.has(pathOnly)) {
        return reply.code(403).send({ error: { message: "forbidden" } });
      }
      req.tenureUserId = pat.user_id;
      req.tenureAuthMethod = "pat";
      return;
    }

    return reply.code(401).send({ error: { message: "unauthorized" } });
  });

  registerChatRoute(app, deps);
  app.get("/admin/config", async (_req, reply) => reply.send({ ok: true }));
  await app.ready();

  return { app, deps, adapter, searchTextStub, rootToken, rootUserId };
}

async function post(
  app: FastifyInstance,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      [PROXY_HEADER]: USER_ID,
      ...headers
    },
    body: JSON.stringify({ model: MODEL, ...body })
  });
}

async function waitForDoc<T extends object>(
  collection: { findOne: (filter: any) => Promise<T | null> },
  filter: Record<string, unknown>,
  timeoutMs = 2_000
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const doc = await collection.findOne(filter);
    if (doc) return doc;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test.serial(
  "pinned facts: injected into system prompt, audit record written",
  async (t) => {
    const pinnedFact = makeBelief({
      canonical_name: "Prefer functional components",
      content:
        "Always use functional components with hooks, never class components.",
      pinned: true,
      scope: SCOPE
    });

    const pinnedQuestion = makeBelief({
      canonical_name: "Migration timeline unclear",
      content: "Should we migrate the auth module to the new SDK before Q3?",
      type: "open_question",
      pinned: true,
      scope: SCOPE
    });

    await cols.beliefs.insertMany([pinnedFact, pinnedQuestion]);

    const { app, adapter } = await buildApp();

    const res = await post(app, {
      messages: [
        { role: "user", content: "How should I structure my React components?" }
      ],
      metadata: { scope: SCOPE }
    });

    t.is(res.statusCode, 200);

    const callArgs = adapter.call.getCall(0).args;
    const systemPrompt =
      typeof callArgs === "string" ? callArgs : JSON.stringify(callArgs);

    t.true(
      systemPrompt.includes("Prefer functional components") ||
        systemPrompt.includes("functional components with hooks"),
      "pinned fact content should appear in the system prompt sent to the adapter"
    );

    const auditRecord = await waitForDoc(cols.injection_audit as any, {
      user_id: USER_ID
    });

    t.truthy(
      auditRecord,
      "injection audit record should be written to MongoDB"
    );

    const record = auditRecord as any;
    t.is(record.user_id, USER_ID);
    t.deepEqual(record.scope, SCOPE);
    t.true(record.injected, "injected flag should be true");

    const pinnedSnapshots = record.injected_beliefs.pinned_facts;
    t.true(
      pinnedSnapshots.length >= 1,
      "at least one pinned fact snapshot expected"
    );

    const factSnapshot = pinnedSnapshots.find(
      (s: any) => s.canonical_name === "Prefer functional components"
    );
    t.truthy(factSnapshot, "pinned fact snapshot should be recorded");
    t.is(factSnapshot.content, pinnedFact.content);
    t.is(factSnapshot.pinned, true);

    await app.close();
  }
);

test.serial(
  "pinned facts: injection disabled when injection_enabled is false in runtime config",
  async (t) => {
    await cols.beliefs.insertOne(
      makeBelief({
        canonical_name: "Should not appear",
        content: "This belief must not reach the adapter system prompt.",
        pinned: true,
        scope: SCOPE
      })
    );

    const { app, adapter, deps } = await buildApp();

    (deps.runtimeStore.load as sinon.SinonStub).resolves({
      extraction_enabled: true,
      injection_enabled: false,
      managed_history_token_cap: 120_000,
      compaction_mode: "aggressive",
      scope_auto_detect: true
    });

    const res = await post(app, {
      messages: [{ role: "user", content: "Tell me about React." }],
      metadata: { scope: SCOPE }
    });

    t.is(res.statusCode, 200);

    const systemPrompt =
      typeof adapter.call.getCall(0).args === "string"
        ? adapter.call.getCall(0).args
        : JSON.stringify(adapter.call.getCall(0).args);

    t.false(
      systemPrompt.includes("Should not appear"),
      "belief content must not appear in system prompt when injection is disabled"
    );

    const auditRecord = await waitForDoc(
      cols.injection_audit as any,
      { user_id: USER_ID },
      300
    );
    t.truthy(
      auditRecord,
      "audit record should still be written even when injection is disabled"
    );

    const record = auditRecord as any;
    t.false(
      record.injected,
      "injected flag should be false when injection is disabled"
    );

    await app.close();
  }
);

test.serial(
  "atlas path: relevant beliefs returned by searchText are injected and audited",
  async (t) => {
    const relevantBelief = makeBelief({
      canonical_name: "Use strict TypeScript config",
      content:
        "Always enable strict mode and noUncheckedIndexedAccess in tsconfig.",
      pinned: false,
      scope: SCOPE
    });

    await cols.beliefs.insertOne(relevantBelief);

    const { app, adapter, searchTextStub } = await buildApp();

    const scoredBelief: ScoredBelief = { ...relevantBelief, _searchScore: 8.5 };
    searchTextStub.resolves([scoredBelief]);

    const res = await post(app, {
      messages: [
        { role: "user", content: "How do I configure TypeScript strictly?" }
      ],
      metadata: { scope: SCOPE }
    });

    t.is(res.statusCode, 200);

    const systemPrompt =
      typeof adapter.call.getCall(0).args === "string"
        ? adapter.call.getCall(0).args
        : JSON.stringify(adapter.call.getCall(0).args);

    t.true(
      systemPrompt.includes("Use strict TypeScript config") ||
        systemPrompt.includes("noUncheckedIndexedAccess"),
      "Atlas-matched belief should appear in the system prompt"
    );

    t.true(searchTextStub.calledOnce);
    const [calledUserId, , calledScope] = searchTextStub.getCall(0).args;
    t.is(calledUserId, USER_ID);
    t.deepEqual(calledScope, SCOPE);

    const auditRecord = await waitForDoc(cols.injection_audit as any, {
      user_id: USER_ID
    });

    t.truthy(auditRecord);
    const record = auditRecord as any;

    const relevantSnapshots = record.injected_beliefs.relevant_beliefs;
    t.true(relevantSnapshots.length >= 1, "relevant belief snapshot expected");

    const snapshot = relevantSnapshots.find(
      (s: any) => s.canonical_name === "Use strict TypeScript config"
    );
    t.truthy(snapshot, "relevant belief snapshot should be recorded in audit");
    t.is(snapshot.content, relevantBelief.content);
    t.is(snapshot.pinned, false);

    await app.close();
  }
);

test.serial(
  "atlas path: both pinned facts and search results appear together in system prompt",
  async (t) => {
    const pinned = makeBelief({
      canonical_name: "Always use ESM imports",
      content:
        "Use .js extensions on all local imports, even for TypeScript files.",
      pinned: true,
      scope: SCOPE
    });

    const relevant = makeBelief({
      canonical_name: "Prefer type over interface for unions",
      content:
        "Use the type keyword when defining union or intersection types.",
      pinned: false,
      scope: SCOPE
    });

    await cols.beliefs.insertMany([pinned, relevant]);

    const { app, adapter, searchTextStub } = await buildApp();
    searchTextStub.resolves([
      { ...relevant, _searchScore: 7.2 } as ScoredBelief
    ]);

    const res = await post(app, {
      messages: [
        { role: "user", content: "What are our TypeScript conventions?" }
      ],
      metadata: { scope: SCOPE }
    });

    t.is(res.statusCode, 200);

    const systemPrompt =
      typeof adapter.call.getCall(0).args === "string"
        ? adapter.call.getCall(0).args
        : JSON.stringify(adapter.call.getCall(0).args);

    t.true(
      systemPrompt.includes("ESM imports") ||
        systemPrompt.includes(".js extensions"),
      "pinned fact should be in system prompt"
    );
    t.true(
      systemPrompt.includes("type over interface") ||
        systemPrompt.includes("union"),
      "Atlas-matched relevant belief should also be in system prompt"
    );

    const auditRecord = await waitForDoc(cols.injection_audit as any, {
      user_id: USER_ID
    });
    t.truthy(auditRecord);

    const record = auditRecord as any;
    t.is(record.injected_beliefs.pinned_facts.length, 1);
    t.is(record.injected_beliefs.relevant_beliefs.length, 1);
    t.is(record.belief_count, 2);

    await app.close();
  }
);

test.serial(
  "IDE turn: project and language headers drive IDE scope in system prompt and job payload",
  async (t) => {
    const { app, deps, adapter } = await buildApp();

    const enqueueStub = sinon.stub().resolves(randomUUID());
    deps.jobs = { enqueue: enqueueStub } as any;

    const res = await post(
      app,
      {
        messages: [
          { role: "user", content: "How do I write a React component?" }
        ],
        metadata: { scope: SCOPE }
      },
      {
        "x-tenure-ide": "1",
        "x-tenure-project": "My Project",
        "x-tenure-language": "typescript"
      }
    );

    t.is(res.statusCode, 200);

    const systemPrompt =
      typeof adapter.call.getCall(0).args === "string"
        ? adapter.call.getCall(0).args
        : JSON.stringify(adapter.call.getCall(0).args);

    t.true(
      systemPrompt.includes("project:my-project"),
      "IDE project scope should appear in system prompt"
    );

    await new Promise((r) => setTimeout(r, 100));
    t.is(enqueueStub.callCount, 1);

    const jobPayload = enqueueStub.getCall(0).args[0];
    t.is(jobPayload.extractionMode, "ide");
    t.is(jobPayload.workspaceContext?.project_scope, "project:my-project");
    t.is(jobPayload.workspaceContext?.language_scope, "domain:code/typescript");

    await app.close();
  }
);

test.serial(
  "IDE turn: falls back to WorkspaceStateCache when headers are absent",
  async (t) => {
    const { app, deps, adapter } = await buildApp();

    await deps.workspaceState!.set(USER_ID, {
      workspace_root: "/home/user/workspace",
      project_name: "FallbackProject",
      git_remote: null,
      active_file: null,
      active_language: null,
      updated_at: new Date()
    });

    const res = await post(
      app,
      {
        messages: [{ role: "user", content: "Hello" }],
        metadata: { scope: SCOPE }
      },
      { "x-tenure-ide": "1" }
    );

    t.is(res.statusCode, 200);

    const systemPrompt =
      typeof adapter.call.getCall(0).args === "string"
        ? adapter.call.getCall(0).args
        : JSON.stringify(adapter.call.getCall(0).args);

    t.true(
      systemPrompt.includes("project:fallbackproject"),
      "workspace state project scope should drive the system prompt"
    );

    await app.close();
  }
);

test.serial("auth: missing auth header returns 401", async (t) => {
  const { app } = await buildSecureApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }]
    })
  });
  t.is(res.statusCode, 401);
  await app.close();
});

test.serial("auth: invalid bearer token returns 401", async (t) => {
  const { app } = await buildSecureApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer invalid-token"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }]
    })
  });
  t.is(res.statusCode, 401);
  await app.close();
});

test.serial(
  "auth: valid PAT authenticates as the token owner, not root",
  async (t) => {
    const patToken = "pat-valid-token-abc";
    const patHash = createHash("sha256").update(patToken).digest("hex");
    await cols.api_tokens.insertOne({
      _id: randomUUID(),
      token_hash: patHash,
      name: "Test PAT",
      user_id: "pat-user-id",
      created_at: new Date()
    });

    const { app, deps } = await buildSecureApp();
    const getOrCreateSpy = sinon.spy(deps.sessions, "getOrCreate");

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${patToken}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }]
      })
    });

    t.is(res.statusCode, 200);
    t.is(getOrCreateSpy.callCount, 1);
    t.is(getOrCreateSpy.getCall(0).args[1], "pat-user-id");

    await app.close();
  }
);

test.serial("auth: revoked PAT returns 401", async (t) => {
  const patToken = "pat-revoked-token";
  const patHash = createHash("sha256").update(patToken).digest("hex");
  await cols.api_tokens.insertOne({
    _id: randomUUID(),
    token_hash: patHash,
    name: "Revoked PAT",
    user_id: "revoked-user",
    created_at: new Date(),
    revoked_at: new Date()
  });

  const { app } = await buildSecureApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${patToken}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }]
    })
  });

  t.is(res.statusCode, 401);
  await app.close();
});

test.serial("auth: PAT on non-allowed path returns 403", async (t) => {
  const patToken = "pat-admin-token";
  const patHash = createHash("sha256").update(patToken).digest("hex");
  await cols.api_tokens.insertOne({
    _id: randomUUID(),
    token_hash: patHash,
    name: "Admin PAT",
    user_id: "admin-user",
    created_at: new Date()
  });

  const { app } = await buildSecureApp();
  const res = await app.inject({
    method: "GET",
    url: "/admin/config",
    headers: { authorization: `Bearer ${patToken}` }
  });

  t.is(res.statusCode, 403);
  await app.close();
});

test.serial("malformed: missing messages returns 400", async (t) => {
  const { app } = await buildApp();
  const res = await post(app, { model: MODEL });
  t.is(res.statusCode, 400);
  t.true(
    res.json().error.message.toLowerCase().includes("messages"),
    "error should mention messages"
  );
  await app.close();
});

test.serial("malformed: missing model returns 400", async (t) => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      [PROXY_HEADER]: USER_ID
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
  });
  t.is(res.statusCode, 400);
  t.true(
    res.json().error.message.toLowerCase().includes("model"),
    "error should mention model"
  );
  await app.close();
});

test.serial("malformed: empty messages array returns 400", async (t) => {
  const { app } = await buildApp();
  const res = await post(app, { messages: [] });
  t.is(res.statusCode, 400);
  t.true(
    res.json().error.message.toLowerCase().includes("messages"),
    "error should mention messages"
  );
  await app.close();
});

test.serial("malformed: unsupported model tier returns 422", async (t) => {
  const { app } = await buildApp();
  const res = await post(app, {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-3.5-turbo"
  });
  t.is(res.statusCode, 422);
  t.is(res.json().error.type, "model_not_supported");
  await app.close();
});

test.serial("malformed: invalid JSON body returns 400", async (t) => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      [PROXY_HEADER]: USER_ID
    },
    body: "{ invalid json"
  });
  t.is(res.statusCode, 400);
  await app.close();
});

test.serial(
  "streaming: SSE shape, content-type, and [DONE] terminator",
  async (t) => {
    const { app, adapter } = await buildApp();

    adapter.callStream.callsFake(async function* () {
      yield { type: "content_delta", delta: "Hello" };
      yield { type: "content_delta", delta: " world" };
      yield {
        type: "stream_end",
        model: MODEL,
        finish_reason: "stop",
        usage: { input_tokens: 2, output_tokens: 2 }
      };
    });

    const res = await post(app, {
      messages: [{ role: "user", content: "Hi" }],
      stream: true
    });

    t.is(res.statusCode, 200);
    t.true(
      (res.headers["content-type"] as string).includes("text/event-stream")
    );

    const body = res.body as string;
    t.true(body.includes("data: [DONE]"));

    const events = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));

    t.is(events[0].object, "chat.completion.chunk");
    t.is(events[0].choices[0].delta.role, "assistant");

    const last = events[events.length - 1];
    t.is(last.choices[0].finish_reason, "stop");
    t.truthy(last.usage);

    await app.close();
  }
);

test.serial(
  "streaming: sidecar is stripped — only visible content reaches the wire",
  async (t) => {
    const { app, adapter } = await buildApp();

    const visible = "Visible response text.";
    const hidden = `${SIDECAR_BEGIN}{"orientation_tax":false}${SIDECAR_END}`;

    adapter.callStream.callsFake(async function* () {
      yield { type: "content_delta", delta: visible + hidden };
      yield {
        type: "stream_end",
        model: MODEL,
        finish_reason: "stop",
        usage: { input_tokens: 3, output_tokens: 3 }
      };
    });

    const res = await post(app, {
      messages: [{ role: "user", content: "Hi" }],
      stream: true
    });

    t.is(res.statusCode, 200);
    const body = res.body as string;

    t.true(body.includes(visible));
    t.false(body.includes(SIDECAR_BEGIN));
    t.false(body.includes("orientation_tax"));
    t.true(body.includes("data: [DONE]"));

    await app.close();
  }
);

test.serial(
  "streaming: provider error mid-stream emits error SSE and [DONE]",
  async (t) => {
    const { app, adapter } = await buildApp();

    adapter.callStream.callsFake(async function* () {
      yield {
        type: "content_delta",
        delta: "Partial response text that is longer than the holdback buffer"
      };
      throw new Error("connection reset");
    });

    const res = await post(app, {
      messages: [{ role: "user", content: "Hi" }],
      stream: true
    });

    t.is(res.statusCode, 200);
    const body = res.body as string;

    t.true(body.includes("Partial"));
    t.true(body.includes('"error"'));
    t.true(body.includes("connection reset"));
    t.true(body.includes("data: [DONE]"));

    await app.close();
  }
);
