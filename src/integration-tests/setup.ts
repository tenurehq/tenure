import { execSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import type { FastifyInstance } from "fastify";
import sinon from "sinon";

import { getCollections } from "../db/collections.js";
import { ensureIndexes, ensureSearchIndexes } from "../db/indexes.js";
import { ExtractionWorker } from "../extraction/worker.js";
import { BeliefWriter } from "../extraction/beliefWriter.js";
import { BeliefsReader } from "../context/beliefsReader.js";
import { BeliefMerger } from "../extraction/merger.js";
import { PersonaCache } from "../context/personaCache.js";
import { PersonaSummaryService } from "../context/personaSummary.js";
import type {
  InternalLLMCaller,
  Message,
  ModelInfo,
  ProviderAdapter,
  StreamEvent,
  SystemPrompt
} from "../providers/types.js";
import { CredentialVault } from "../config/encryption.js";
import { RuntimeConfigStore } from "../config/runtime.js";
import { TokenService } from "../auth/tokenService.js";
import { SessionManager } from "../session/manager.js";
import { ContextBuilder } from "../context/contextBuilder.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ExtractionJobQueue } from "../jobs/queue.js";
import { ErrorLogger } from "../errors/logger.js";
import { WorkspaceStateCache } from "../workspace/stateCache.js";
import { ProjectResumeService } from "../context/projectResume.js";
import { buildServer } from "../server.js";
import type { TokenCapability, TokenKind } from "../types/token.js";

const ATLAS_IMAGE = "mongodb/mongodb-atlas-local:8";
const CONTAINER_NAME = "tenure-integration-atlas";
const HOST_PORT = 27019;
const MONGO_URI = `mongodb://localhost:${HOST_PORT}/?directConnection=true`;
const DB_NAME = "tenure_integration_test";
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 200;

const ROOT_TOKEN = "mp_integration_root_token_123456";
const CLIENT_TOKEN = "pat_integration_client_token_123456";
const AGENT_TOKEN = "agt_integration_agent_token_123456";
const USER_ID = "integration-test-user";
const TOKEN_HMAC_KEY_B64 = Buffer.from(
  "integration-test-hmac-key-seed-32"
).toString("base64");
const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_PROVIDER = "anthropic";
const ANTHROPIC_API_KEY = "integration-anthropic-key";

let sharedClient: MongoClient | null = null;
let sharedDb: Db | null = null;
let sharedEnv: IntegrationEnv | null = null;
let sharedRefCount = 0;
let cleanupInstalled = false;
let cleanupHandler: (() => void) | null = null;
let searchIndexesReady = false;

function containerExists(): boolean {
  const r = spawnSync("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^${CONTAINER_NAME}$`,
    "--format",
    "{{.Names}}"
  ]);
  return r.stdout.toString().trim() === CONTAINER_NAME;
}

function containerRunning(): boolean {
  const r = spawnSync("docker", [
    "ps",
    "--filter",
    `name=^${CONTAINER_NAME}$`,
    "--format",
    "{{.Names}}"
  ]);
  return r.stdout.toString().trim() === CONTAINER_NAME;
}

function startContainer(): void {
  if (containerRunning()) return;
  if (containerExists()) {
    execSync(`docker start ${CONTAINER_NAME}`, { stdio: "pipe" });
    return;
  }
  execSync(
    `docker run -d --name ${CONTAINER_NAME} -p ${HOST_PORT}:27017 ${ATLAS_IMAGE}`,
    { stdio: "pipe" }
  );
}

function stopContainer(): void {
  if (containerExists()) {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "pipe" });
    try {
      execSync(`docker volume rm ${CONTAINER_NAME}-data`, { stdio: "pipe" });
    } catch {}
  }
}

async function waitForMongo(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const c = new MongoClient(MONGO_URI, {
        serverSelectionTimeoutMS: READY_POLL_MS
      } as any);
      await c.connect();
      await c.db("admin").command({ ping: 1 });
      await c.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }
  throw new Error(
    `Atlas Local container not ready within ${READY_TIMEOUT_MS}ms`
  );
}

async function retryUntilReady<T>(
  fn: () => Promise<T>,
  label: string,
  timeoutMs = READY_TIMEOUT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }
  throw new Error(
    `${label} did not succeed within ${timeoutMs}ms: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

function tokenHash(token: string, hmacKey: Buffer): string {
  return createHmac("sha256", hmacKey).update(token).digest("hex");
}

function tokenPrefix(kind: TokenKind): string {
  return kind === "root" ? "mp_" : kind === "client" ? "pat_" : "agt_";
}

async function seedBaseConfig(runtimeStore: RuntimeConfigStore): Promise<void> {
  await runtimeStore.set("default_provider", DEFAULT_PROVIDER as any);
  await runtimeStore.set("default_model", DEFAULT_MODEL as any);
  await runtimeStore.set("anthropic_api_key", ANTHROPIC_API_KEY as any);
  await runtimeStore.set("token_hmac_key", TOKEN_HMAC_KEY_B64 as any);
  await runtimeStore.set("scope_auto_detect", true as any);
  await runtimeStore.set("extraction_enabled", true as any);
  await runtimeStore.set("injection_enabled", true as any);
  await runtimeStore.set("ide_extraction_enabled", true as any);
}

async function clearChatState(
  cols: ReturnType<typeof getCollections>
): Promise<void> {
  await Promise.all([
    cols.jobs.deleteMany({}),
    cols.beliefs.deleteMany({}),
    cols.sessions.deleteMany({}),
    cols.injection_audit.deleteMany({}),
    cols.belief_suggestions.deleteMany({}),
    cols.persona_cache.deleteMany({}),
    cols.file_meta.deleteMany({}),
    cols.errors.deleteMany({}),
    cols.db.collection("orientation_tax_events").deleteMany({}),
    cols.db.collection("workspace_state").deleteMany({})
  ]);
}

export interface LLMSpy extends InternalLLMCaller {
  call: sinon.SinonStub;
}

export interface ProviderResponse {
  content?: string;
  model?: string;
  finish_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
  toolCalls?: unknown[];
}

export interface TestProviderAdapter extends ProviderAdapter {
  id: string;
  call: sinon.SinonStub<
    [string, SystemPrompt, Message[], Record<string, unknown>, AbortSignal?],
    Promise<{
      content: string;
      model: string;
      finish_reason: string;
      usage: { input_tokens: number; output_tokens: number };
      toolCalls?: unknown[];
    }>
  >;
  callStream: sinon.SinonStub<
    [string, SystemPrompt, Message[], Record<string, unknown>, AbortSignal?],
    AsyncIterable<StreamEvent>
  >;
  listModels: sinon.SinonStub<[], Promise<ModelInfo[]>>;
}

export interface IntegrationEnv {
  client: MongoClient;
  db: Db;
  cols: ReturnType<typeof getCollections>;
  vault: CredentialVault;
  runtimeStore: RuntimeConfigStore;
  tokenService: TokenService;
  userId: string;
  tokens: {
    root: string;
    client: string;
    agent: string;
  };
  makeWorker(): ExtractionWorker;
  makeWriter(): BeliefWriter;
  makeReader(): BeliefsReader;
  makeMerger(): BeliefMerger;
  createLLMSpy(responses: object[]): LLMSpy;
  seedToken(input: {
    token: string;
    kind: TokenKind;
    name: string;
    user_id?: string;
    capabilities: TokenCapability[];
    project_scopes?: string[] | null;
  }): Promise<void>;
  seedRuntimeConfig(overrides: Partial<Record<string, unknown>>): Promise<void>;
  buildChatServer(options?: {
    providerId?: string;
    providerResponses?: ProviderResponse[];
  }): Promise<{ app: FastifyInstance; adapter: TestProviderAdapter }>;
  resetChatState(): Promise<void>;
  resetAll(): Promise<void>;
  release(): Promise<void>;
  teardown(): Promise<void>;
}

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupHandler = () => {
    try {
      stopContainer();
    } finally {
      process.exit();
    }
  };
  process.on("SIGINT", cleanupHandler);
  process.on("SIGTERM", cleanupHandler);
  cleanupInstalled = true;
}

function uninstallCleanup(): void {
  if (!cleanupInstalled || !cleanupHandler) return;
  process.removeListener("SIGINT", cleanupHandler);
  process.removeListener("SIGTERM", cleanupHandler);
  cleanupInstalled = false;
  cleanupHandler = null;
}

export async function setupIntegrationEnv(): Promise<IntegrationEnv> {
  if (sharedEnv) {
    sharedRefCount += 1;
    return sharedEnv;
  }

  sinon.restore();
  installCleanup();
  startContainer();
  await waitForMongo();

  sharedClient = new MongoClient(MONGO_URI);
  await sharedClient.connect();
  sharedDb = sharedClient.db(DB_NAME);
  const cols = getCollections(sharedDb);

  const tenureHome = join(tmpdir(), `tenure-int-${randomUUID()}`);
  mkdirSync(tenureHome, { recursive: true });
  const masterKeyPath = join(tenureHome, "master.key");
  writeFileSync(masterKeyPath, randomBytes(32));
  const vault = new CredentialVault(masterKeyPath);
  const runtimeStore = new RuntimeConfigStore(cols, vault);

  await cols.config.deleteMany({});

  await ensureIndexes(cols);
  if (!searchIndexesReady) {
    await retryUntilReady(
      async () => {
        await ensureSearchIndexes(sharedDb!);
      },
      "ensureSearchIndexes",
      READY_TIMEOUT_MS
    );
    searchIndexesReady = true;
  }

  await seedBaseConfig(runtimeStore);
  const runtimeConfig = await runtimeStore.load();
  const hmacKey = Buffer.from(runtimeConfig.token_hmac_key as string, "base64");
  const tokenService = new TokenService(cols.tokens, hmacKey);

  async function seedToken(input: {
    token: string;
    kind: TokenKind;
    name: string;
    user_id?: string;
    capabilities: TokenCapability[];
    project_scopes?: string[] | null;
  }): Promise<void> {
    const hash = tokenHash(input.token, hmacKey);
    await cols.tokens.updateOne(
      { token_hash: hash },
      {
        $set: {
          kind: input.kind,
          token_hash: hash,
          token_prefix: tokenPrefix(input.kind),
          name: input.name,
          user_id: input.user_id ?? USER_ID,
          capabilities: input.capabilities,
          project_scopes: input.project_scopes ?? null,
          encrypted_value: null,
          created_at: new Date(),
          last_used_at: null,
          revoked_at: null,
          expires_at: null
        },
        $setOnInsert: {
          _id: randomUUID()
        }
      },
      { upsert: true }
    );
  }

  await seedToken({
    token: ROOT_TOKEN,
    kind: "root",
    name: "Integration Root",
    user_id: USER_ID,
    capabilities: ["admin"]
  });
  await seedToken({
    token: CLIENT_TOKEN,
    kind: "client",
    name: "Integration Client",
    user_id: USER_ID,
    capabilities: [
      "chat",
      "beliefs:read",
      "beliefs:write",
      "extraction",
      "injection"
    ]
  });
  await seedToken({
    token: AGENT_TOKEN,
    kind: "agent",
    name: "Integration Agent",
    user_id: USER_ID,
    capabilities: ["chat", "extraction", "injection"]
  });

  function createLLMSpy(responses: object[]): LLMSpy {
    let idx = 0;
    const callStub = sinon.stub().callsFake(async () => {
      const resp = responses[idx] ?? responses[responses.length - 1];
      idx += 1;
      return {
        content: JSON.stringify(resp),
        model: DEFAULT_MODEL,
        finish_reason: "stop",
        usage: { input_tokens: 10, output_tokens: 20 }
      };
    });
    return { call: callStub } as LLMSpy;
  }

  const defaultLLMSpy = createLLMSpy([
    { merges: [], contradictions: [], no_action_ids: [] }
  ]);
  const personaCache = new PersonaCache(cols.persona_cache);
  const personaSummary = new PersonaSummaryService({
    beliefs: cols.beliefs,
    cache: personaCache,
    adapter: () => defaultLLMSpy,
    modelId: DEFAULT_MODEL
  });

  async function buildChatServer(options?: {
    providerId?: string;
    providerResponses?: ProviderResponse[];
  }): Promise<{ app: FastifyInstance; adapter: TestProviderAdapter }> {
    const responses = options?.providerResponses ?? [
      { content: "Visible response" }
    ];
    let idx = 0;

    const callStub = sinon.stub() as sinon.SinonStub<
      [string, SystemPrompt, Message[], Record<string, unknown>, AbortSignal?],
      Promise<{
        content: string;
        model: string;
        finish_reason: string;
        usage: { input_tokens: number; output_tokens: number };
        toolCalls?: unknown[];
      }>
    >;

    callStub.callsFake(
      async (
        _model: string,
        _systemPrompt: SystemPrompt,
        _messages: Message[],
        _body: Record<string, unknown>,
        _abortSignal?: AbortSignal
      ) => {
        const current = responses[idx] ??
          responses[responses.length - 1] ?? { content: "Visible response" };
        idx += 1;
        return {
          content: String(current.content ?? ""),
          model: String(current.model ?? DEFAULT_MODEL),
          finish_reason: String(current.finish_reason ?? "stop"),
          usage: current.usage ?? { input_tokens: 10, output_tokens: 20 },
          ...(current.toolCalls?.length ? { toolCalls: current.toolCalls } : {})
        };
      }
    );

    const callStreamStub = sinon.stub() as sinon.SinonStub<
      [string, SystemPrompt, Message[], Record<string, unknown>, AbortSignal?],
      AsyncIterable<StreamEvent>
    >;

    callStreamStub.callsFake(
      (
        _model: string,
        _systemPrompt: SystemPrompt,
        _messages: Message[],
        _body: Record<string, unknown>,
        _abortSignal?: AbortSignal
      ) =>
        (async function* () {
          yield {
            type: "content_delta",
            delta: String(
              (responses[0] ?? { content: "Visible response" }).content ??
                "Visible response"
            )
          } as StreamEvent;
          yield {
            type: "stream_end",
            model: String(
              (responses[0] ?? { model: DEFAULT_MODEL }).model ?? DEFAULT_MODEL
            ),
            finish_reason: String(
              (responses[0] ?? { finish_reason: "stop" }).finish_reason ??
                "stop"
            ),
            usage: (
              responses[0] ?? {
                usage: { input_tokens: 10, output_tokens: 20 }
              }
            ).usage ?? { input_tokens: 10, output_tokens: 20 }
          } as StreamEvent;
        })()
    );

    const listModelsStub = sinon.stub() as sinon.SinonStub<
      [],
      Promise<ModelInfo[]>
    >;

    listModelsStub.resolves([
      {
        id: DEFAULT_MODEL,
        object: "model",
        created: 0,
        owned_by: DEFAULT_PROVIDER
      }
    ]);

    const adapter: TestProviderAdapter = {
      id: options?.providerId ?? DEFAULT_PROVIDER,
      call: callStub,
      callStream: callStreamStub,
      listModels: listModelsStub
    };

    const sessions = new SessionManager(sharedDb!);
    const beliefs = new BeliefsReader(cols.beliefs);
    const persona = new PersonaCache(cols.persona_cache);
    const context = new ContextBuilder(beliefs, persona);
    const jobs = new ExtractionJobQueue(sharedDb!);
    const providers = new ProviderRegistry().register(adapter);
    const errorLogger = new ErrorLogger(cols);
    const workspaceState = new WorkspaceStateCache(sharedDb!);
    const projectResume = new ProjectResumeService({
      injectionAudit: cols.injection_audit,
      beliefs: cols.beliefs,
      fileMeta: cols.file_meta,
      workspaceState,
      adapter: () => ({ call: adapter.call }),
      modelId: DEFAULT_MODEL
    });

    const app = await buildServer({
      db: sharedDb!,
      cols,
      sessions,
      context,
      providers,
      jobs,
      runtimeStore,
      errorLogger,
      persona,
      userId: USER_ID,
      extractionWorker: new ExtractionWorker({
        db: sharedDb!,
        beliefs: cols.beliefs,
        personaSummary
      }),
      personaSummary,
      projectResume,
      workspaceState,
      tokenService,
      vault
    });

    return { app, adapter };
  }

  sharedEnv = {
    client: sharedClient,
    db: sharedDb,
    cols,
    vault,
    runtimeStore,
    tokenService,
    userId: USER_ID,
    tokens: {
      root: ROOT_TOKEN,
      client: CLIENT_TOKEN,
      agent: AGENT_TOKEN
    },
    makeWorker() {
      return new ExtractionWorker({
        db: sharedDb!,
        beliefs: cols.beliefs,
        personaSummary
      });
    },
    makeWriter() {
      return new BeliefWriter(cols.beliefs);
    },
    makeReader() {
      return new BeliefsReader(cols.beliefs);
    },
    makeMerger() {
      return new BeliefMerger(
        new BeliefWriter(cols.beliefs),
        new BeliefsReader(cols.beliefs)
      );
    },
    createLLMSpy,
    seedToken,
    async seedRuntimeConfig(overrides: Partial<Record<string, unknown>>) {
      for (const [key, value] of Object.entries(overrides)) {
        await runtimeStore.set(key as any, value as any);
      }
    },
    buildChatServer,
    async resetChatState() {
      await clearChatState(cols);
      sinon.restore();
    },
    async resetAll() {
      await Promise.all([
        clearChatState(cols),
        cols.tokens.deleteMany({}),
        cols.config.deleteMany({}),
        cols.onboarding_drafts.deleteMany({})
      ]);
      await seedBaseConfig(runtimeStore);
      await seedToken({
        token: ROOT_TOKEN,
        kind: "root",
        name: "Integration Root",
        user_id: USER_ID,
        capabilities: ["admin"]
      });
      await seedToken({
        token: CLIENT_TOKEN,
        kind: "client",
        name: "Integration Client",
        user_id: USER_ID,
        capabilities: [
          "chat",
          "beliefs:read",
          "beliefs:write",
          "extraction",
          "injection"
        ]
      });
      await seedToken({
        token: AGENT_TOKEN,
        kind: "agent",
        name: "Integration Agent",
        user_id: USER_ID,
        capabilities: ["chat", "extraction", "injection"]
      });
      sinon.restore();
    },
    async release() {
      sharedRefCount = Math.max(0, sharedRefCount - 1);
    },
    async teardown() {
      sharedRefCount = 0;
      sinon.restore();
      if (sharedClient) {
        await sharedClient.close();
      }
      sharedClient = null;
      sharedDb = null;
      sharedEnv = null;
      searchIndexesReady = false;
      uninstallCleanup();
      stopContainer();
    }
  };

  sharedRefCount = 1;
  return sharedEnv;
}
