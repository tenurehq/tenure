import { execSync, spawnSync } from "node:child_process";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import sinon from "sinon";

import { getCollections } from "../db/collections.js";
import { ensureIndexes, ensureSearchIndexes } from "../db/indexes.js";
import { ExtractionWorker } from "../extraction/worker.js";
import { BeliefCompactionRunner } from "../jobs/compactionRunner.js";
import { BeliefWriter } from "../extraction/beliefWriter.js";
import { BeliefsReader } from "../context/beliefsReader.js";
import { BeliefMerger } from "../extraction/merger.js";
import { PersonaCache } from "../context/personaCache.js";
import { PersonaSummaryService } from "../context/personaSummary.js";
import type { InternalLLMCaller } from "../providers/types.js";
import { DEFAULTS } from "../config/runtime.js";
import { randomUUID } from "node:crypto";

const ATLAS_IMAGE = "mongodb/mongodb-atlas-local:8";
const CONTAINER_NAME = "tenure-integration-atlas";
const HOST_PORT = 27019;
const MONGO_URI = `mongodb://localhost:${HOST_PORT}/?directConnection=true`;
const DB_NAME = "tenure_integration_test";

const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 200;

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
    `${label} did not succeed within ${timeoutMs}ms: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

export interface LLMSpy extends InternalLLMCaller {
  call: sinon.SinonStub;
}

export interface IntegrationEnv {
  client: MongoClient;
  db: Db;
  cols: ReturnType<typeof getCollections>;

  makeWorker(): ExtractionWorker;
  makeWriter(): BeliefWriter;
  makeReader(): BeliefsReader;
  makeMerger(): BeliefMerger;
  makeCompactionRunner(llmSpy: LLMSpy): BeliefCompactionRunner;
  createLLMSpy(responses: object[]): LLMSpy;

  reset(): Promise<void>;
  teardown(): Promise<void>;
}

async function seedDefaults(
  cols: ReturnType<typeof getCollections>
): Promise<void> {
  const bulkOps = Object.entries(DEFAULTS)
    .filter(
      ([key]) =>
        ![
          "openai_api_key",
          "anthropic_api_key",
          "default_model",
          "openai_base_url",
          "anthropic_base_url",
          "openai_endpoint_flavor"
        ].includes(key)
    )
    .map(([key, value]) => ({
      updateOne: {
        filter: { key },
        update: {
          $setOnInsert: {
            _id: randomUUID(),
            encrypted: false
          },
          $set: {
            key,
            value,
            updatedAt: new Date()
          }
        },
        upsert: true
      }
    }));

  if (bulkOps.length > 0) {
    await cols.config.bulkWrite(bulkOps, { ordered: false });
  }
}

export async function setupIntegrationEnv(): Promise<IntegrationEnv> {
  sinon.restore();

  const forceCleanup = () => {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "pipe" });
    try {
      execSync(`docker volume rm ${CONTAINER_NAME}-data`, { stdio: "pipe" });
    } catch {}
    process.exit();
  };

  process.on("SIGINT", forceCleanup);
  process.on("SIGTERM", forceCleanup);

  startContainer();
  await waitForMongo();

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const cols = getCollections(db);

  await ensureIndexes(cols);
  await retryUntilReady(
    async () => {
      await ensureSearchIndexes(db);
    },
    "ensureSearchIndexes",
    READY_TIMEOUT_MS
  );
  await seedDefaults(cols);

  function createLLMSpy(responses: object[]): LLMSpy {
    let idx = 0;
    const callStub = sinon
      .stub()
      .callsFake(
        async (
          _model: string,
          _system: string,
          _messages: unknown[],
          _opts?: unknown
        ) => {
          const resp = responses[idx] ?? responses[responses.length - 1];
          idx++;
          return {
            content: JSON.stringify(resp),
            model: "test-model",
            finish_reason: "stop",
            usage: { input_tokens: 10, output_tokens: 20 }
          };
        }
      );
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
    modelId: "test-model"
  });

  const env: IntegrationEnv = {
    client,
    db,
    cols,

    makeWorker() {
      return new ExtractionWorker({
        db,
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

    makeCompactionRunner(llmSpy: LLMSpy) {
      return new BeliefCompactionRunner(
        cols.beliefs,
        cols.compaction_log,
        cols.contradictions,
        () => llmSpy,
        "test-model",
        personaCache,
        personaSummary,
        {}
      );
    },

    createLLMSpy,

    async reset() {
      await Promise.all([
        cols.jobs.deleteMany({}),
        cols.beliefs.deleteMany({}),
        cols.config.deleteMany({}),
        cols.db.collection("style_signals").deleteMany({}),
        cols.compaction_log.deleteMany({}),
        cols.contradictions.deleteMany({}),
        cols.belief_suggestions.deleteMany({}),
        cols.injection_audit.deleteMany({}),
        cols.db.collection("orientation_tax_events").deleteMany({}),
        cols.persona_cache.deleteMany({})
      ]);

      await seedDefaults(cols);
      sinon.restore();
    },

    async teardown() {
      process.removeListener("SIGINT", forceCleanup);
      process.removeListener("SIGTERM", forceCleanup);
      sinon.restore();
      await client.close();
      stopContainer();
    }
  };

  return env;
}
