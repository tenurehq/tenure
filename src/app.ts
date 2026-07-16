import { Db, MongoClient, type MongoClientOptions } from "mongodb";
import { existsSync, readFileSync } from "node:fs";
import { getCollections } from "./db/collections.js";
import { ensureIndexes, ensureSearchIndexes } from "./db/indexes.js";
import { BeliefsReader } from "./context/beliefsReader.js";
import { ContextBuilder } from "./context/contextBuilder.js";
import { ExtractionJobQueue } from "./jobs/queue.js";
import { ProviderRegistry } from "./providers/registry.js";
import { buildServer } from "./server.js";
import type { BootstrapConfig } from "./config/bootstrap.js";
import { loadAppConfig, writeTokenAndPrintBanner } from "./config/appConfig.js";
import { CredentialVault } from "./config/encryption.js";
import { RuntimeConfigStore } from "./config/runtime.js";
import { OpenAIAdapter } from "./providers/openai.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { ErrorLogger } from "./errors/logger.js";
import { PersonaCache } from "./context/personaCache.js";
import { ExtractionWorker } from "./extraction/worker.js";
import { PersonaSummaryService } from "./context/personaSummary.js";
import { buildAutoEncryptionOptions } from "./config/beliefEncryption.js";
import { getBeliefMasterKeyPath } from "./config/beliefEncryptionMasterKey.js";
import { initBeliefEncryption } from "./config/beliefEncryption.js";
import { randomBytes } from "node:crypto";
import { WorkspaceStateCache } from "./workspace/stateCache.js";
import type { InternalLLMCaller } from "./providers/types.js";
import { ProjectResumeService } from "./context/projectResume.js";
import { TokenService } from "./auth/tokenService.js";

const mongoTlsOptions: MongoClientOptions = {};
if (process.env.MONGODB_TLS_CA_FILE) {
  mongoTlsOptions.tlsCAFile = process.env.MONGODB_TLS_CA_FILE;
}

async function verifyEncryptionActive(
  db: Db,
  mongoUri: string,
  mongoDbName: string,
  tlsOptions: MongoClientOptions = {}
): Promise<void> {
  const testCol = db.collection("beliefs");
  const testId = randomBytes(8).toString("hex");
  const testContent = `encryption-verify-${randomBytes(8).toString("hex")}`;

  try {
    await testCol.insertOne({
      _id: testId as unknown as any,
      content: testContent,
      user_id: "__encryption_verify__",
      canonical_name: `__verify__${testId}`,
      created_at: new Date()
    });

    const decrypted = await testCol.findOne({ _id: testId as unknown as any });
    if (decrypted?.content != testContent) {
      throw new Error("Encrypted read did not return expected plaintext");
    }

    const rawClient = new MongoClient(mongoUri, tlsOptions);
    await rawClient.connect();
    try {
      const rawDoc = await rawClient
        .db(mongoDbName)
        .collection("beliefs")
        .findOne({ _id: testId as unknown as any });

      if (rawDoc?.content === testContent) {
        throw new Error("CSFLE MISCONFIGURED: content stored as plaintext...");
      }
      if (typeof rawDoc?.content === "string") {
        throw new Error(
          "CSFLE MISCONFIGURED: content is a string, not Binary..."
        );
      }
    } finally {
      await rawClient.close();
    }
  } finally {
    await testCol.deleteOne({ _id: testId as unknown as any }).catch(() => {});
  }
}

export async function buildApp(config: BootstrapConfig) {
  const vault = new CredentialVault(config.master_key_path);

  const beliefKeyPath = getBeliefMasterKeyPath(process.env.TENURE_HOME);
  let beliefMasterKey: Buffer;
  if (existsSync(beliefKeyPath)) {
    console.log("Using existing belief.key (legacy file)");
    beliefMasterKey = readFileSync(beliefKeyPath);
  } else {
    console.log("Deriving belief encryption key from master.key...");
    beliefMasterKey = vault.hkdfExpand("tenure:belief:csfle", 96);
  }

  console.log("Initializing belief encryption key...");
  const bootstrapClient = new MongoClient(config.mongodb_uri);
  await bootstrapClient.connect();

  const { dataKeyId } = await initBeliefEncryption({
    masterKey: beliefMasterKey,
    mongoClient: bootstrapClient,
    db: bootstrapClient.db(config.mongodb_db)
  });

  await bootstrapClient.close();

  console.log("Connecting to MongoDB...");
  const autoEncryption = buildAutoEncryptionOptions(beliefMasterKey, dataKeyId);

  const client = new MongoClient(config.mongodb_uri, {
    autoEncryption,
    ...mongoTlsOptions
  });
  await client.connect();
  console.log("MongoDB connected (CSFLE enabled)");

  const plainClient = new MongoClient(config.mongodb_uri, {
    ...mongoTlsOptions
  });
  await plainClient.connect();

  const db = client.db(config.mongodb_db);
  const plainDb = plainClient.db(config.mongodb_db);

  console.log("Verifying CSFLE is active...");
  await verifyEncryptionActive(
    db,
    config.mongodb_uri,
    config.mongodb_db,
    mongoTlsOptions
  );
  console.log("CSFLE verified - belief content is encrypted at rest");

  const cols = getCollections(db, plainDb);
  await ensureIndexes(cols);
  await ensureSearchIndexes(db);

  console.log("Loading app config...");
  const appConfig = await loadAppConfig(db, {
    vault,
    onFirstRun: (token, path) => {
      writeTokenAndPrintBanner(token, path, config.port);
    }
  });
  console.log("App config loaded");

  const beliefs = new BeliefsReader(cols.beliefs);
  const persona = new PersonaCache(cols.persona_cache);
  const context = new ContextBuilder(beliefs, persona);
  const jobs = new ExtractionJobQueue(db);
  const runtimeStore = new RuntimeConfigStore(cols, vault);
  const runtimeConfig = await runtimeStore.load();
  const errorLogger = new ErrorLogger(cols);
  const workspaceState = new WorkspaceStateCache(db);

  let hmacKey: Buffer;
  if (runtimeConfig.token_hmac_key) {
    hmacKey = Buffer.from(runtimeConfig.token_hmac_key, "base64");
  } else {
    hmacKey = randomBytes(32);
    await runtimeStore.set(
      "token_hmac_key" as any,
      hmacKey.toString("base64") as any
    );
  }

  const tokenService = new TokenService(cols.tokens, hmacKey);
  await tokenService.ensureRootToken(config.user_id, appConfig.api_token);

  const providers = new ProviderRegistry();
  if (runtimeConfig.openai_api_key) {
    providers.register(
      new OpenAIAdapter(
        runtimeConfig.openai_api_key,
        runtimeConfig.openai_base_url ?? undefined,
        runtimeConfig.openai_endpoint_flavor
      )
    );
  }
  if (runtimeConfig.anthropic_api_key) {
    providers.register(new AnthropicAdapter(runtimeConfig.anthropic_api_key));
  }

  const resolveAdapter = (): InternalLLMCaller => {
    if (providers.listRegistered().includes("anthropic")) {
      const a = providers.resolve(
        "anthropic"
      ) as unknown as import("./providers/anthropic.js").AnthropicAdapter;
      return { call: a.callPositional.bind(a) };
    }
    if (providers.listRegistered().includes("openai"))
      return providers.resolve("openai") as unknown as InternalLLMCaller;
    throw new Error("No provider configured, add credentials in the UI");
  };

  const personaSummary = new PersonaSummaryService({
    beliefs: cols.beliefs,
    cache: persona,
    adapter: resolveAdapter,
    modelId: runtimeConfig.default_model ?? ""
  });

  const extractionWorker = new ExtractionWorker({
    db,
    beliefs: cols.beliefs,
    personaSummary
  });

  const projectResume = new ProjectResumeService({
    injectionAudit: cols.injection_audit,
    beliefs: cols.beliefs,
    fileMeta: cols.file_meta,
    workspaceState,
    adapter: resolveAdapter,
    modelId: runtimeConfig.default_model ?? ""
  });

  const server = await buildServer({
    db,
    cols,
    context,
    providers,
    jobs,
    runtimeStore,
    errorLogger,
    persona,
    userId: config.user_id,
    extractionWorker,
    personaSummary,
    projectResume,
    workspaceState,
    tokenService,
    vault
  });

  return {
    server,
    async close() {
      await server.close();
      await client.close();
      await plainClient.close();
    }
  };
}
