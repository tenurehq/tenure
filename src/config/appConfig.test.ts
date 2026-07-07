import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sinon from "sinon";
import {
  loadAppConfig,
  rotateApiToken,
  writeTokenAndPrintBanner
} from "./appConfig.js";
import { DEFAULTS } from "./runtime.js";

const test = anyTest.serial as TestFn;

class FakeVault {
  encryptCalls: string[] = [];
  decryptCalls: string[] = [];
  encryptToFileCalls: Array<{ token: string; path: string }> = [];

  encrypt(value: string): string {
    this.encryptCalls.push(value);
    return `enc:${value}`;
  }

  decrypt(value: string): string {
    this.decryptCalls.push(value);
    if (!value.startsWith("enc:")) {
      throw new Error("invalid encrypted payload");
    }
    return value.slice(4);
  }

  encryptToFile(token: string, path: string): void {
    this.encryptToFileCalls.push({ token, path });
  }
}

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

async function getConfigDocs() {
  return db.collection("config").find({}).toArray();
}

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

test.beforeEach(async () => {
  await db.collection("config").deleteMany({});
  delete process.env.TENURE_API_TOKEN;
  delete process.env.TENURE_HOME;
});

test("returns decrypted token from new encrypted format", async (t) => {
  const vault = new FakeVault();

  await db.collection("config").insertOne({
    key: "api_token",
    value: "enc:tok-abc-123",
    encrypted: true,
    updatedAt: new Date()
  });

  const cfg = await loadAppConfig(db, { vault });

  t.is(cfg.api_token, "tok-abc-123");
  t.deepEqual(vault.decryptCalls, ["enc:tok-abc-123"]);
  t.deepEqual(vault.encryptCalls, []);
  t.deepEqual(vault.encryptToFileCalls, []);
});

test("ignores new format entry when encrypted value is not a string and provisions a new token", async (t) => {
  const vault = new FakeVault();
  const onFirstRunCalls: Array<{ token: string; path: string }> = [];
  const tempHome = mkdtempSync(join(tmpdir(), "tenure-test-"));
  process.env.TENURE_HOME = tempHome;

  await db.collection("config").insertOne({
    key: "api_token",
    value: 12345,
    encrypted: true,
    updatedAt: new Date()
  });

  const cfg = await loadAppConfig(db, {
    vault,
    onFirstRun: (token, path) => onFirstRunCalls.push({ token, path })
  });

  t.regex(cfg.api_token, /^mp_[A-Za-z0-9_-]+$/);
  t.is(vault.decryptCalls.length, 0);
  t.deepEqual(vault.encryptCalls, [cfg.api_token]);
  t.is(vault.encryptToFileCalls.length, 1);
  t.deepEqual(onFirstRunCalls, [
    { token: cfg.api_token, path: join(tempHome, "token") }
  ]);

  const apiTokenDoc = await db
    .collection("config")
    .findOne({ key: "api_token" });
  t.truthy(apiTokenDoc);
  t.is(apiTokenDoc?.value, `enc:${cfg.api_token}`);
  t.is(apiTokenDoc?.encrypted, true);
});

test("migrates legacy plaintext api_token to encrypted format", async (t) => {
  const vault = new FakeVault();

  await db.collection("config").insertOne({
    api_token: "tok-legacy-123"
  });

  const cfg = await loadAppConfig(db, { vault });

  t.is(cfg.api_token, "tok-legacy-123");
  t.deepEqual(vault.encryptCalls, ["tok-legacy-123"]);
  t.deepEqual(vault.decryptCalls, []);
  t.deepEqual(vault.encryptToFileCalls, []);

  const docs = await getConfigDocs();
  t.is(docs.length, 1);
  t.is(docs[0].key, "api_token");
  t.is(docs[0].value, "enc:tok-legacy-123");
  t.is(docs[0].encrypted, true);
  t.truthy(docs[0].updatedAt);
});

test("legacy plaintext document is found via api_token exists query even with foreign shape", async (t) => {
  const vault = new FakeVault();

  await db.collection("config").insertOne({
    key: "some_other_key",
    api_token: "tok-legacy-query-match",
    value: "ignored"
  });

  const cfg = await loadAppConfig(db, { vault });

  t.is(cfg.api_token, "tok-legacy-query-match");

  const encryptedDoc = await db
    .collection("config")
    .findOne({ key: "api_token" });
  t.truthy(encryptedDoc);
  t.is(encryptedDoc?.value, "enc:tok-legacy-query-match");
  t.is(encryptedDoc?.encrypted, true);
});

test("does not treat empty string legacy api_token as valid and provisions a new token", async (t) => {
  const vault = new FakeVault();
  const tempHome = mkdtempSync(join(tmpdir(), "tenure-test-"));
  process.env.TENURE_HOME = tempHome;

  await db.collection("config").insertOne({
    api_token: ""
  });

  const cfg = await loadAppConfig(db, { vault });

  t.regex(cfg.api_token, /^mp_[A-Za-z0-9_-]+$/);
  t.not(cfg.api_token, "");
  t.deepEqual(vault.encryptCalls, [cfg.api_token]);
  t.is(vault.encryptToFileCalls.length, 1);

  const docs = await getConfigDocs();
  t.true(
    docs.some(
      (doc) => doc.key === "api_token" && doc.value === `enc:${cfg.api_token}`
    )
  );
  t.true(docs.some((doc) => doc.api_token === ""));
});

test("provisions token from TENURE_API_TOKEN when provided", async (t) => {
  const vault = new FakeVault();
  const tempHome = mkdtempSync(join(tmpdir(), "tenure-test-"));
  process.env.TENURE_HOME = tempHome;
  process.env.TENURE_API_TOKEN = "tok-from-env";

  const onFirstRunCalls: Array<{ token: string; path: string }> = [];
  const cfg = await loadAppConfig(db, {
    vault,
    onFirstRun: (token, path) => onFirstRunCalls.push({ token, path })
  });

  t.is(cfg.api_token, "tok-from-env");
  t.deepEqual(vault.encryptCalls, ["tok-from-env"]);
  t.deepEqual(vault.encryptToFileCalls, [
    { token: "tok-from-env", path: join(tempHome, "token") }
  ]);
  t.deepEqual(onFirstRunCalls, [
    { token: "tok-from-env", path: join(tempHome, "token") }
  ]);
});

test("auto-provisions encrypted token and inserts defaults on first run", async (t) => {
  const vault = new FakeVault();
  const tempHome = mkdtempSync(join(tmpdir(), "tenure-test-"));
  process.env.TENURE_HOME = tempHome;

  const onFirstRunCalls: Array<{ token: string; path: string }> = [];
  const cfg = await loadAppConfig(db, {
    vault,
    onFirstRun: (token, path) => onFirstRunCalls.push({ token, path })
  });

  t.regex(cfg.api_token, /^mp_[A-Za-z0-9_-]+$/);
  t.deepEqual(vault.encryptCalls, [cfg.api_token]);
  t.deepEqual(vault.encryptToFileCalls, [
    { token: cfg.api_token, path: join(tempHome, "token") }
  ]);
  t.deepEqual(onFirstRunCalls, [
    { token: cfg.api_token, path: join(tempHome, "token") }
  ]);

  const docs = await getConfigDocs();
  const apiTokenDoc = docs.find((doc) => doc.key === "api_token");
  t.truthy(apiTokenDoc);
  t.is(apiTokenDoc?.value, `enc:${cfg.api_token}`);
  t.is(apiTokenDoc?.encrypted, true);

  const excludedDefaultKeys = [
    "openai_api_key",
    "anthropic_api_key",
    "default_model",
    "openai_base_url",
    "anthropic_base_url",
    "openai_endpoint_flavor",
    "token_hmac_key",
    "scim_token"
  ];

  for (const key of excludedDefaultKeys) {
    t.false(
      docs.some((doc) => doc.key === key),
      `did not expect default doc for ${key}`
    );
  }

  const expectedDefaultKeys = Object.keys(DEFAULTS).filter(
    (key) => key !== "api_token" && !excludedDefaultKeys.includes(key)
  );

  for (const key of expectedDefaultKeys) {
    const doc = docs.find((entry) => entry.key === key);
    t.truthy(doc, `expected default doc for ${key}`);
    t.is(doc?.encrypted, false);
    t.truthy(doc?.updatedAt);
    if (key === "scope_auto_detect") {
      t.is(doc?.value, true);
    } else {
      t.deepEqual(doc?.value, (DEFAULTS as Record<string, unknown>)[key]);
    }
  }
});

test("returns the same decrypted token on subsequent calls after first-run provisioning", async (t) => {
  const vault = new FakeVault();
  const tempHome = mkdtempSync(join(tmpdir(), "tenure-test-"));
  process.env.TENURE_HOME = tempHome;

  const first = await loadAppConfig(db, { vault });
  const second = await loadAppConfig(db, { vault });

  t.is(first.api_token, second.api_token);
  t.true(vault.encryptCalls.includes(first.api_token));
  t.true(vault.decryptCalls.includes(`enc:${first.api_token}`));
  t.is(vault.encryptToFileCalls.length, 1);
});

test("rotateApiToken replaces stored token and writes token file", async (t) => {
  const vault = new FakeVault();
  const tempHome = mkdtempSync(join(tmpdir(), "tenure-test-"));
  process.env.TENURE_HOME = tempHome;

  const rotated = await rotateApiToken(db, vault);

  t.regex(rotated, /^mp_[A-Za-z0-9_-]+$/);
  t.deepEqual(vault.encryptCalls, [rotated]);
  t.deepEqual(vault.encryptToFileCalls, [
    { token: rotated, path: join(tempHome, "token") }
  ]);

  const apiTokenDoc = await db
    .collection("config")
    .findOne({ key: "api_token" });
  t.truthy(apiTokenDoc);
  t.is(apiTokenDoc?.value, `enc:${rotated}`);
  t.is(apiTokenDoc?.encrypted, true);
  t.truthy(apiTokenDoc?.updatedAt);
});

test("rotateApiToken overwrites an existing stored encrypted token", async (t) => {
  const vault = new FakeVault();
  const tempHome = mkdtempSync(join(tmpdir(), "tenure-test-"));
  process.env.TENURE_HOME = tempHome;

  await db.collection("config").insertOne({
    key: "api_token",
    value: "enc:old-token",
    encrypted: true,
    updatedAt: new Date(0)
  });

  const rotated = await rotateApiToken(db, vault);

  t.regex(rotated, /^mp_[A-Za-z0-9_-]+$/);
  t.not(rotated, "old-token");

  const docs = await getConfigDocs();
  const apiTokenDocs = docs.filter((doc) => doc.key === "api_token");
  t.is(apiTokenDocs.length, 1);
  t.is(apiTokenDocs[0].value, `enc:${rotated}`);
});

test("writeTokenAndPrintBanner prints expected onboarding banner", (t) => {
  const log = sinon.stub(console, "log");

  try {
    writeTokenAndPrintBanner("tok-banner", "/tmp/tenure/token", 4310);

    const lines = log.getCalls().map((call) => call.args[0]);
    t.true(lines.includes("  First-run setup complete."));
    t.true(lines.includes("  API token: tok-banner"));
    t.true(lines.includes("  Saved to:  /tmp/tenure/token"));
    t.true(lines.includes("  │  Base URL:  http://localhost:4310/v1"));
    t.true(lines.includes("  │  API Key:   tok-banner"));
    t.true(
      lines.includes(
        "  Setup UI: http://localhost:4310/onboarding?token=tok-banner"
      )
    );
  } finally {
    log.restore();
  }
});
