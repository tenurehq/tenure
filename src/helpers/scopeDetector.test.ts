import test from "ava";
import sinon from "sinon";
import type { Collection, Db } from "mongodb";
import type { RuntimeConfig } from "../config/runtime.js";
import type { TokenScopeStore } from "./scopeDetector.js";
import {
  fetchExistingUserScopes,
  matchExtractCommand,
  matchInjectCommand,
  matchScopeCommand,
  tryInterceptExtractCommand,
  tryInterceptInjectCommand,
  tryInterceptScopeCommand,
  validateCommandInput
} from "./scopeDetector.js";

const NOOP_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => NOOP_LOGGER
} as any;

function makeTokenScopes(
  setActiveScope: sinon.SinonStub = sinon.stub().resolves()
): TokenScopeStore {
  return {
    getActiveScope: sinon.stub().resolves(null),
    setActiveScope
  };
}

function makeRuntimeStore(
  set: sinon.SinonStub = sinon.stub().resolves()
): {
  set<K extends keyof RuntimeConfig>(
    key: K,
    value: RuntimeConfig[K]
  ): Promise<void>;
} {
  return { set } as {
    set<K extends keyof RuntimeConfig>(
      key: K,
      value: RuntimeConfig[K]
    ): Promise<void>;
  };
}

function makeDb(distinctResult: string[]): Db {
  const col = {
    distinct: sinon.stub().resolves(distinctResult)
  } as unknown as Collection<unknown>;
  return {
    collection: sinon.stub().returns(col)
  } as unknown as Db;
}

test("validateCommandInput rejects an empty scope", (t) => {
  const result = validateCommandInput("scope", []);
  t.false(result.valid);
  if (!result.valid) t.true(result.message.includes("No scope provided"));
});

test("validateCommandInput rejects an invalid scope", (t) => {
  const result = validateCommandInput("scope", ["invalid:scope"]);
  t.false(result.valid);
  if (!result.valid) t.true(result.message.includes("Invalid scope format"));
});

test("validateCommandInput accepts and deduplicates supported scopes", (t) => {
  const result = validateCommandInput("scope", [
    "project:api",
    "domain:code/typescript",
    "user:universal",
    "project:api"
  ]);
  t.true(result.valid);
  if (result.valid) {
    t.deepEqual(result.parts, [
      "project:api",
      "domain:code/typescript",
      "user:universal"
    ]);
  }
});

test("validateCommandInput accepts toggle actions", (t) => {
  for (const action of ["off", "on", "global-off", "global-on"] as const) {
    t.true(validateCommandInput("extract", action).valid);
    t.true(validateCommandInput("inject", action).valid);
  }
});

test("matchScopeCommand recognizes supported prefixes", (t) => {
  t.is(matchScopeCommand("!scope project:api"), "project:api");
  t.is(matchScopeCommand("!SCOPE project:api"), "project:api");
  t.is(matchScopeCommand("set scope project:docs"), "project:docs");
  t.is(matchScopeCommand("SET SCOPE project:docs"), "project:docs");
  t.is(matchScopeCommand("!scope"), "");
});

test("matchScopeCommand ignores noncommands", (t) => {
  t.is(matchScopeCommand(""), null);
  t.is(matchScopeCommand("what is Redis?"), null);
  t.is(matchScopeCommand("please !scope project:api"), null);
  t.is(matchScopeCommand("!scoped project:api"), null);
});

test("tryInterceptScopeCommand ignores normal messages", async (t) => {
  const tokenScopes = makeTokenScopes();
  const result = await tryInterceptScopeCommand(
    "what is Redis?",
    "user-1",
    "token-1",
    null,
    tokenScopes,
    NOOP_LOGGER
  );
  t.is(result, null);
  t.false((tokenScopes.setActiveScope as sinon.SinonStub).called);
});

test("tryInterceptScopeCommand reports missing scope", async (t) => {
  const setActiveScope = sinon.stub().resolves();
  const result = await tryInterceptScopeCommand(
    "!scope",
    "user-1",
    "token-1",
    null,
    makeTokenScopes(setActiveScope),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.deepEqual(result!.newScope, []);
  t.true(result!.message.includes("No scope provided"));
  t.false(setActiveScope.called);
});

test("tryInterceptScopeCommand persists a normalized token scope", async (t) => {
  const setActiveScope = sinon.stub().resolves();
  const result = await tryInterceptScopeCommand(
    "!SCOPE PROJECT:API, DOMAIN:CODE/TYPESCRIPT",
    "user-1",
    "token-1",
    ["project:api"],
    makeTokenScopes(setActiveScope),
    NOOP_LOGGER
  );
  t.deepEqual(result, {
    message: "Scope set to: `project:api`, `domain:code/typescript`",
    newScope: ["project:api", "domain:code/typescript"]
  });
  t.true(
    setActiveScope.calledOnceWith("user-1", "token-1", [
      "project:api",
      "domain:code/typescript"
    ])
  );
});

test("tryInterceptScopeCommand supports set scope", async (t) => {
  const setActiveScope = sinon.stub().resolves();
  const result = await tryInterceptScopeCommand(
    "set scope project:docs",
    "user-1",
    "token-1",
    ["project:docs"],
    makeTokenScopes(setActiveScope),
    NOOP_LOGGER
  );
  t.deepEqual(result!.newScope, ["project:docs"]);
  t.true(setActiveScope.calledOnceWith("user-1", "token-1", ["project:docs"]));
});

test("tryInterceptScopeCommand rejects unauthorized project scope", async (t) => {
  const setActiveScope = sinon.stub().resolves();
  const result = await tryInterceptScopeCommand(
    "!scope project:docs",
    "user-1",
    "token-1",
    ["project:api"],
    makeTokenScopes(setActiveScope),
    NOOP_LOGGER
  );
  t.deepEqual(result!.newScope, []);
  t.true(result!.message.includes("not authorized"));
  t.false(setActiveScope.called);
});

test("tryInterceptScopeCommand allows any project for unrestricted token", async (t) => {
  const setActiveScope = sinon.stub().resolves();
  const result = await tryInterceptScopeCommand(
    "!scope project:docs",
    "user-1",
    "token-1",
    null,
    makeTokenScopes(setActiveScope),
    NOOP_LOGGER
  );
  t.deepEqual(result!.newScope, ["project:docs"]);
  t.true(setActiveScope.calledOnceWith("user-1", "token-1", ["project:docs"]));
});

test("tryInterceptScopeCommand returns an error when token update fails", async (t) => {
  const result = await tryInterceptScopeCommand(
    "!scope project:api",
    "user-1",
    "token-1",
    ["project:api"],
    makeTokenScopes(sinon.stub().rejects(new Error("mongo down"))),
    NOOP_LOGGER
  );
  t.deepEqual(result!.newScope, []);
  t.true(result!.message.includes("Failed to update scope"));
});

test("fetchExistingUserScopes returns non-universal belief scopes", async (t) => {
  const result = await fetchExistingUserScopes(
    "user-1",
    makeDb(["project:api", "user:universal", "universal", "project:docs"])
  );
  t.deepEqual(result, ["project:api", "project:docs"]);
});

test("fetchExistingUserScopes queries by user", async (t) => {
  const distinct = sinon.stub().resolves(["project:api"]);
  const col = { distinct } as unknown as Collection<unknown>;
  const db = {
    collection: sinon.stub().returns(col)
  } as unknown as Db;
  await fetchExistingUserScopes("user-42", db);
  t.true(distinct.calledOnceWith("scope", { user_id: "user-42" }));
});

test("fetchExistingUserScopes returns empty array on database failure", async (t) => {
  const col = {
    distinct: sinon.stub().rejects(new Error("mongo down"))
  } as unknown as Collection<unknown>;
  const db = {
    collection: sinon.stub().returns(col)
  } as unknown as Db;
  t.deepEqual(await fetchExistingUserScopes("user-1", db), []);
});

test("matchExtractCommand recognizes exact commands", (t) => {
  t.is(matchExtractCommand("!extract off"), "off");
  t.is(matchExtractCommand("!extract on"), "on");
  t.is(matchExtractCommand("!extract global off"), "global-off");
  t.is(matchExtractCommand("!EXTRACT GLOBAL ON"), "global-on");
  t.is(matchExtractCommand("!extract"), null);
  t.is(matchExtractCommand("please !extract off"), null);
});

test("tryInterceptExtractCommand ignores normal messages", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptExtractCommand(
    "what is Redis?",
    makeRuntimeStore(runtimeSet),
    NOOP_LOGGER
  );
  t.is(result, null);
  t.false(runtimeSet.called);
});

test("tryInterceptExtractCommand rejects per-conversation toggles", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptExtractCommand(
    "!extract off",
    makeRuntimeStore(runtimeSet),
    NOOP_LOGGER
  );
  t.true(result!.message.includes("Per-conversation"));
  t.true(result!.message.includes("!extract global off"));
  t.false(runtimeSet.called);
});

test("tryInterceptExtractCommand updates global extraction config", async (t) => {
  const off = sinon.stub().resolves();
  const on = sinon.stub().resolves();
  await tryInterceptExtractCommand(
    "!extract global off",
    makeRuntimeStore(off),
    NOOP_LOGGER
  );
  await tryInterceptExtractCommand(
    "!extract global on",
    makeRuntimeStore(on),
    NOOP_LOGGER
  );
  t.true(off.calledOnceWith("extraction_enabled", false));
  t.true(on.calledOnceWith("extraction_enabled", true));
});

test("tryInterceptExtractCommand reports global config failure", async (t) => {
  const result = await tryInterceptExtractCommand(
    "!extract global off",
    makeRuntimeStore(sinon.stub().rejects(new Error("config down"))),
    NOOP_LOGGER
  );
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("matchInjectCommand recognizes exact commands", (t) => {
  t.is(matchInjectCommand("!inject off"), "off");
  t.is(matchInjectCommand("!inject on"), "on");
  t.is(matchInjectCommand("!inject global off"), "global-off");
  t.is(matchInjectCommand("!INJECT GLOBAL ON"), "global-on");
  t.is(matchInjectCommand("!inject"), null);
  t.is(matchInjectCommand("please !inject off"), null);
});

test("tryInterceptInjectCommand ignores normal messages", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptInjectCommand(
    "what is Redis?",
    makeRuntimeStore(runtimeSet),
    NOOP_LOGGER
  );
  t.is(result, null);
  t.false(runtimeSet.called);
});

test("tryInterceptInjectCommand rejects per-conversation toggles", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptInjectCommand(
    "!inject on",
    makeRuntimeStore(runtimeSet),
    NOOP_LOGGER
  );
  t.true(result!.message.includes("Per-conversation"));
  t.true(result!.message.includes("!inject global on"));
  t.false(runtimeSet.called);
});

test("tryInterceptInjectCommand updates global injection config", async (t) => {
  const off = sinon.stub().resolves();
  const on = sinon.stub().resolves();
  await tryInterceptInjectCommand(
    "!inject global off",
    makeRuntimeStore(off),
    NOOP_LOGGER
  );
  await tryInterceptInjectCommand(
    "!inject global on",
    makeRuntimeStore(on),
    NOOP_LOGGER
  );
  t.true(off.calledOnceWith("injection_enabled", false));
  t.true(on.calledOnceWith("injection_enabled", true));
});

test("tryInterceptInjectCommand reports global config failure", async (t) => {
  const result = await tryInterceptInjectCommand(
    "!inject global on",
    makeRuntimeStore(sinon.stub().rejects(new Error("config down"))),
    NOOP_LOGGER
  );
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("extract and inject parsers do not cross-match", (t) => {
  t.is(matchInjectCommand("!extract off"), null);
  t.is(matchExtractCommand("!inject off"), null);
  t.is(matchInjectCommand("!extract global off"), null);
  t.is(matchExtractCommand("!inject global off"), null);
});
