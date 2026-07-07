import test from "ava";
import sinon from "sinon";
import type { Db, Collection } from "mongodb";
import type { RuntimeConfig } from "../config/runtime.js";
import {
  matchScopeCommand,
  tryInterceptScopeCommand,
  fetchExistingUserScopes,
  matchExtractCommand,
  tryInterceptExtractCommand,
  matchInjectCommand,
  tryInterceptInjectCommand,
  matchSessionCommand,
  tryInterceptSessionCommand,
  validateCommandInput
} from "./scopeDetector.js";

type SessionPatch = {
  activeScope?: string[];
  extractionPaused?: boolean;
  injectionPaused?: boolean;
};

const NOOP_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => NOOP_LOGGER
} as any;

test("validateCommandInput scope rejects empty parts", (t) => {
  const result = validateCommandInput("scope", []);
  t.false(result.valid);
  if (!result.valid) {
    t.true(result.message.includes("No scope provided"));
  }
});

test("validateCommandInput scope rejects invalid scope format", (t) => {
  const result = validateCommandInput("scope", ["domain:code"]);
  t.false(result.valid);
  if (!result.valid) {
    t.true(result.message.includes("Invalid scope format"));
  }
});

test("validateCommandInput scope accepts project scope", (t) => {
  const result = validateCommandInput("scope", ["project:my-project"]);
  t.true(result.valid);
  if (result.valid) {
    t.deepEqual(result.parts, ["project:my-project"]);
  }
});

test("validateCommandInput extract accepts valid actions", (t) => {
  t.true(validateCommandInput("extract", "off").valid);
  t.true(validateCommandInput("extract", "on").valid);
  t.true(validateCommandInput("extract", "global-off").valid);
  t.true(validateCommandInput("extract", "global-on").valid);
});

test("matchScopeCommand returns null for a regular message", (t) => {
  t.is(matchScopeCommand("what is Redis?"), null);
});

test("matchScopeCommand returns null for empty string", (t) => {
  t.is(matchScopeCommand(""), null);
});

test("matchScopeCommand matches !scope prefix", (t) => {
  t.is(matchScopeCommand("!scope project:api"), "project:api");
});

test("matchScopeCommand matches !scope prefix case-insensitively", (t) => {
  t.is(matchScopeCommand("!SCOPE project:api"), "project:api");
});

test("matchScopeCommand matches 'set scope' prefix", (t) => {
  t.is(matchScopeCommand("set scope project:docs"), "project:docs");
});

test("matchScopeCommand matches 'set scope' prefix case-insensitively", (t) => {
  t.is(matchScopeCommand("SET SCOPE project:docs"), "project:docs");
});

test("matchScopeCommand returns empty string for !scope with no argument", (t) => {
  t.is(matchScopeCommand("!scope"), "");
});

test("matchScopeCommand returns empty string for !scope with only whitespace", (t) => {
  t.is(matchScopeCommand("!scope   "), "");
});

test("matchScopeCommand trims the extracted value", (t) => {
  t.is(matchScopeCommand("!scope   project:api   "), "project:api");
});

test("matchScopeCommand returns multiple scopes as raw string", (t) => {
  t.is(
    matchScopeCommand("!scope project:api project:docs"),
    "project:api project:docs"
  );
});

test("matchScopeCommand returns null when prefix appears mid-message", (t) => {
  t.is(matchScopeCommand("please !scope project:api for me"), null);
});

function makeSessionsDep(updateFn?: sinon.SinonStub) {
  return {
    sessions: {
      update: updateFn ?? sinon.stub().resolves({ activeScope: [] })
    }
  };
}

test("tryInterceptScopeCommand returns null for non-command message", async (t) => {
  const result = await tryInterceptScopeCommand(
    "what is Redis?",
    "session-1",
    "user-1",
    makeSessionsDep(),
    NOOP_LOGGER
  );
  t.is(result, null);
});

test("tryInterceptScopeCommand returns usage message for !scope with no argument", async (t) => {
  const result = await tryInterceptScopeCommand(
    "!scope",
    "session-1",
    "user-1",
    makeSessionsDep(),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.includes("No scope provided"));
  t.deepEqual(result!.newScope, []);
});

test("tryInterceptScopeCommand rejects non-project scopes", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope domain:code",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.includes("Invalid scope format"));
  t.deepEqual(result!.newScope, []);
  t.false(update.called);
});

test("tryInterceptScopeCommand updates session and returns acknowledgment", async (t) => {
  const update = sinon.stub().resolves({ activeScope: ["project:api"] });
  const result = await tryInterceptScopeCommand(
    "!scope project:api",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.deepEqual(result!.newScope, ["project:api"]);
  t.true(result!.message.includes("project:api"));
  t.true(
    update.calledOnceWith("session-1", "user-1", {
      activeScope: ["project:api"]
    })
  );
});

test("tryInterceptScopeCommand parses multiple space-separated scopes", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope project:api project:docs",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.deepEqual(result!.newScope, ["project:api", "project:docs"]);
  t.true(
    update.calledOnceWith("session-1", "user-1", {
      activeScope: ["project:api", "project:docs"]
    })
  );
});

test("tryInterceptScopeCommand parses comma-separated scopes", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope project:api,project:docs",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.deepEqual(result!.newScope, ["project:api", "project:docs"]);
});

test("tryInterceptScopeCommand works with set scope prefix", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "set scope project:docs",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.deepEqual(result!.newScope, ["project:docs"]);
});

test("tryInterceptScopeCommand returns error message when session update fails", async (t) => {
  const update = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptScopeCommand(
    "!scope project:api",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.includes("Failed to update scope"));
  t.deepEqual(result!.newScope, []);
});

test("tryInterceptScopeCommand does not call update for empty command", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  await tryInterceptScopeCommand(
    "!scope",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER
  );
  t.false(update.called);
});

test("tryInterceptScopeCommand acknowledgment message lists all scopes", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope project:api project:docs",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.includes("project:api"));
  t.true(result!.message.includes("project:docs"));
});

function makeDb(distinctResult: string[]): Db {
  const col = {
    distinct: sinon.stub().resolves(distinctResult)
  } as unknown as Collection<unknown>;
  return {
    collection: sinon.stub().returns(col)
  } as unknown as Db;
}

test("fetchExistingUserScopes returns scopes from beliefs collection", async (t) => {
  const db = makeDb(["project:api", "project:docs"]);
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, ["project:api", "project:docs"]);
});

test("fetchExistingUserScopes filters out user:universal", async (t) => {
  const db = makeDb(["project:api", "user:universal", "project:docs"]);
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, ["project:api", "project:docs"]);
});

test("fetchExistingUserScopes filters out plain universal", async (t) => {
  const db = makeDb(["project:api", "universal"]);
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, ["project:api"]);
});

test("fetchExistingUserScopes returns empty array when user has no beliefs", async (t) => {
  const db = makeDb([]);
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, []);
});

test("fetchExistingUserScopes returns empty array when distinct throws", async (t) => {
  const col = {
    distinct: sinon.stub().rejects(new Error("mongo down"))
  } as unknown as Collection<unknown>;
  const db = {
    collection: sinon.stub().returns(col)
  } as unknown as Db;
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, []);
});

test("fetchExistingUserScopes queries correct field and user_id", async (t) => {
  const distinct = sinon.stub().resolves(["project:api"]);
  const col = { distinct } as unknown as Collection<unknown>;
  const db = {
    collection: sinon.stub().returns(col)
  } as unknown as Db;
  await fetchExistingUserScopes("user-42", db);
  t.true(distinct.calledOnceWith("scope", { user_id: "user-42" }));
});

test("matchExtractCommand returns null for a regular message", (t) => {
  t.is(matchExtractCommand("what is Redis?"), null);
});

test("matchExtractCommand returns null for empty string", (t) => {
  t.is(matchExtractCommand(""), null);
});

test("matchExtractCommand returns null for partial prefix", (t) => {
  t.is(matchExtractCommand("!extract"), null);
});

test("matchExtractCommand returns null when prefix appears mid-message", (t) => {
  t.is(matchExtractCommand("please !extract off for me"), null);
});

test("matchExtractCommand matches !extract off", (t) => {
  t.is(matchExtractCommand("!extract off"), "off");
});

test("matchExtractCommand matches !extract on", (t) => {
  t.is(matchExtractCommand("!extract on"), "on");
});

test("matchExtractCommand matches !extract global off", (t) => {
  t.is(matchExtractCommand("!extract global off"), "global-off");
});

test("matchExtractCommand matches !extract global on", (t) => {
  t.is(matchExtractCommand("!extract global on"), "global-on");
});

test("matchExtractCommand is case-insensitive", (t) => {
  t.is(matchExtractCommand("!EXTRACT OFF"), "off");
  t.is(matchExtractCommand("!Extract On"), "on");
  t.is(matchExtractCommand("!EXTRACT GLOBAL OFF"), "global-off");
});

test("matchExtractCommand ignores surrounding whitespace", (t) => {
  t.is(matchExtractCommand("  !extract off  "), "off");
  t.is(matchExtractCommand("  !extract global on  "), "global-on");
});

test("matchExtractCommand returns null for unknown subcommand", (t) => {
  t.is(matchExtractCommand("!extract pause"), null);
  t.is(matchExtractCommand("!extract disable"), null);
});

function makeExtractDeps(
  overrides: {
    sessionUpdate?: sinon.SinonStub;
    runtimeSet?: sinon.SinonStub;
  } = {}
) {
  return {
    sessions: {
      update: overrides.sessionUpdate ?? sinon.stub().resolves({})
    },
    runtimeStore: {
      set:
        overrides.runtimeSet ??
        sinon
          .stub()
          .callsFake(
            async <K extends keyof RuntimeConfig>(
              _key: K,
              _value: RuntimeConfig[K]
            ) => {}
          )
    }
  };
}

test("tryInterceptExtractCommand returns null for non-command message", async (t) => {
  const result = await tryInterceptExtractCommand(
    "what is Redis?",
    "session-1",
    "user-1",
    makeExtractDeps(),
    NOOP_LOGGER
  );
  t.is(result, null);
});

test("tryInterceptExtractCommand returns null for bare !extract", async (t) => {
  const result = await tryInterceptExtractCommand(
    "!extract",
    "session-1",
    "user-1",
    makeExtractDeps(),
    NOOP_LOGGER
  );
  t.is(result, null);
});

test("tryInterceptExtractCommand off updates session with extractionPaused true", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  const result = await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(
    sessionUpdate.calledOnceWith("session-1", "user-1", {
      extractionPaused: true
    } satisfies SessionPatch)
  );
});

test("tryInterceptExtractCommand off confirmation mentions extract on", async (t) => {
  const result = await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps(),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.includes("!extract on"));
});

test("tryInterceptExtractCommand off confirmation mentions injection still active", async (t) => {
  const result = await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps(),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(
    result!.message.toLowerCase().includes("inject") ||
      result!.message.toLowerCase().includes("existing beliefs")
  );
});

test("tryInterceptExtractCommand off does not touch runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.false(runtimeSet.called);
});

test("tryInterceptExtractCommand on updates session with extractionPaused false", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  const result = await tryInterceptExtractCommand(
    "!extract on",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(
    sessionUpdate.calledOnceWith("session-1", "user-1", {
      extractionPaused: false
    } satisfies SessionPatch)
  );
});

test("tryInterceptExtractCommand on does not touch runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  await tryInterceptExtractCommand(
    "!extract on",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.false(runtimeSet.called);
});

test("tryInterceptExtractCommand global-off sets extraction_enabled false in runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptExtractCommand(
    "!extract global off",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(runtimeSet.calledOnceWith("extraction_enabled", false));
});

test("tryInterceptExtractCommand global-off does not touch session", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  await tryInterceptExtractCommand(
    "!extract global off",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.false(sessionUpdate.called);
});

test("tryInterceptExtractCommand global-on sets extraction_enabled true in runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptExtractCommand(
    "!extract global on",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(runtimeSet.calledOnceWith("extraction_enabled", true));
});

test("tryInterceptExtractCommand global-on does not touch session", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  await tryInterceptExtractCommand(
    "!extract global on",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.false(sessionUpdate.called);
});

test("tryInterceptExtractCommand off returns error message when session update fails", async (t) => {
  const sessionUpdate = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptExtractCommand on returns error message when session update fails", async (t) => {
  const sessionUpdate = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptExtractCommand(
    "!extract on",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptExtractCommand global-off returns error message when runtimeStore set fails", async (t) => {
  const runtimeSet = sinon.stub().rejects(new Error("config db down"));
  const result = await tryInterceptExtractCommand(
    "!extract global off",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptExtractCommand global-on returns error message when runtimeStore set fails", async (t) => {
  const runtimeSet = sinon.stub().rejects(new Error("config db down"));
  const result = await tryInterceptExtractCommand(
    "!extract global on",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("matchInjectCommand returns null for a regular message", (t) => {
  t.is(matchInjectCommand("what is Redis?"), null);
});

test("matchInjectCommand returns null for empty string", (t) => {
  t.is(matchInjectCommand(""), null);
});

test("matchInjectCommand returns null for bare !inject", (t) => {
  t.is(matchInjectCommand("!inject"), null);
});

test("matchInjectCommand returns null when prefix appears mid-message", (t) => {
  t.is(matchInjectCommand("please !inject off for me"), null);
});

test("matchInjectCommand matches !inject off", (t) => {
  t.is(matchInjectCommand("!inject off"), "off");
});

test("matchInjectCommand matches !inject on", (t) => {
  t.is(matchInjectCommand("!inject on"), "on");
});

test("matchInjectCommand matches !inject global off", (t) => {
  t.is(matchInjectCommand("!inject global off"), "global-off");
});

test("matchInjectCommand matches !inject global on", (t) => {
  t.is(matchInjectCommand("!inject global on"), "global-on");
});

test("matchInjectCommand is case-insensitive", (t) => {
  t.is(matchInjectCommand("!INJECT OFF"), "off");
  t.is(matchInjectCommand("!Inject On"), "on");
  t.is(matchInjectCommand("!INJECT GLOBAL OFF"), "global-off");
});

test("matchInjectCommand ignores surrounding whitespace", (t) => {
  t.is(matchInjectCommand("  !inject off  "), "off");
  t.is(matchInjectCommand("  !inject global on  "), "global-on");
});

test("matchInjectCommand returns null for unknown subcommand", (t) => {
  t.is(matchInjectCommand("!inject pause"), null);
  t.is(matchInjectCommand("!inject disable"), null);
});

function makeInjectDeps(
  overrides: {
    sessionUpdate?: sinon.SinonStub;
    runtimeSet?: sinon.SinonStub;
  } = {}
) {
  return {
    sessions: {
      update: overrides.sessionUpdate ?? sinon.stub().resolves({})
    },
    runtimeStore: {
      set:
        overrides.runtimeSet ??
        sinon
          .stub()
          .callsFake(
            async <K extends keyof RuntimeConfig>(
              _key: K,
              _value: RuntimeConfig[K]
            ) => {}
          )
    }
  };
}

test("tryInterceptInjectCommand returns null for non-command message", async (t) => {
  const result = await tryInterceptInjectCommand(
    "what is Redis?",
    "session-1",
    "user-1",
    makeInjectDeps(),
    NOOP_LOGGER
  );
  t.is(result, null);
});

test("tryInterceptInjectCommand off updates session with injectionPaused true", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  const result = await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(
    sessionUpdate.calledOnceWith("session-1", "user-1", {
      injectionPaused: true
    } satisfies SessionPatch)
  );
});

test("tryInterceptInjectCommand off confirmation message mentions extraction still running", async (t) => {
  const result = await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps(),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("extract"));
});

test("tryInterceptInjectCommand off confirmation message mentions !inject on to resume", async (t) => {
  const result = await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps(),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.includes("!inject on"));
});

test("tryInterceptInjectCommand off does not touch runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.false(runtimeSet.called);
});

test("tryInterceptInjectCommand on updates session with injectionPaused false", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  const result = await tryInterceptInjectCommand(
    "!inject on",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(
    sessionUpdate.calledOnceWith("session-1", "user-1", {
      injectionPaused: false
    } satisfies SessionPatch)
  );
});

test("tryInterceptInjectCommand on does not touch runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  await tryInterceptInjectCommand(
    "!inject on",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.false(runtimeSet.called);
});

test("tryInterceptInjectCommand global-off sets injection_enabled false in runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptInjectCommand(
    "!inject global off",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(runtimeSet.calledOnceWith("injection_enabled", false));
});

test("tryInterceptInjectCommand global-off does not touch session", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  await tryInterceptInjectCommand(
    "!inject global off",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.false(sessionUpdate.called);
});

test("tryInterceptInjectCommand global-on sets injection_enabled true in runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptInjectCommand(
    "!inject global on",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(runtimeSet.calledOnceWith("injection_enabled", true));
});

test("tryInterceptInjectCommand global-on does not touch session", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  await tryInterceptInjectCommand(
    "!inject global on",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.false(sessionUpdate.called);
});

test("tryInterceptInjectCommand off returns error message when session update fails", async (t) => {
  const sessionUpdate = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptInjectCommand on returns error message when session update fails", async (t) => {
  const sessionUpdate = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptInjectCommand(
    "!inject on",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptInjectCommand global-off returns error message when runtimeStore set fails", async (t) => {
  const runtimeSet = sinon.stub().rejects(new Error("config db down"));
  const result = await tryInterceptInjectCommand(
    "!inject global off",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptInjectCommand global-on returns error message when runtimeStore set fails", async (t) => {
  const runtimeSet = sinon.stub().rejects(new Error("config db down"));
  const result = await tryInterceptInjectCommand(
    "!inject global on",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("!extract off does not match inject command parser", (t) => {
  t.is(matchInjectCommand("!extract off"), null);
});

test("!inject off does not match extract command parser", (t) => {
  t.is(matchExtractCommand("!inject off"), null);
});

test("!extract global off does not match inject command parser", (t) => {
  t.is(matchInjectCommand("!extract global off"), null);
});

test("!inject global off does not match extract command parser", (t) => {
  t.is(matchExtractCommand("!inject global off"), null);
});

test("matchSessionCommand returns null for a regular message", (t) => {
  t.is(matchSessionCommand("what is Redis?"), null);
});

test("matchSessionCommand returns null for empty string", (t) => {
  t.is(matchSessionCommand(""), null);
});

test("matchSessionCommand returns null for bare !session", (t) => {
  t.is(matchSessionCommand("!session"), null);
});

test("matchSessionCommand returns null for !session with only one argument", (t) => {
  t.is(matchSessionCommand("!session agent:work:abc123"), null);
});

test("matchSessionCommand returns null when prefix appears mid-message", (t) => {
  t.is(
    matchSessionCommand("please !session agent:work:abc123 work for me"),
    null
  );
});

test("matchSessionCommand parses sessionKey and agentId", (t) => {
  const result = matchSessionCommand("!session agent:work:abc123 work");
  t.deepEqual(result, { sessionKey: "agent:work:abc123", agentId: "work" });
});

test("matchSessionCommand parses main agent", (t) => {
  const result = matchSessionCommand("!session agent:main:xyz main");
  t.deepEqual(result, { sessionKey: "agent:main:xyz", agentId: "main" });
});

test("matchSessionCommand is case-insensitive on the prefix", (t) => {
  const result = matchSessionCommand("!SESSION agent:work:abc123 work");
  t.deepEqual(result, { sessionKey: "agent:work:abc123", agentId: "work" });
});

test("matchSessionCommand handles complex session keys", (t) => {
  const result = matchSessionCommand(
    "!session agent:coding:derived_a1b2c3d4e5f6 coding"
  );
  t.deepEqual(result, {
    sessionKey: "agent:coding:derived_a1b2c3d4e5f6",
    agentId: "coding"
  });
});

function makeSessionCommandDeps(getOrCreateFn?: sinon.SinonStub) {
  return {
    sessions: {
      getOrCreate: getOrCreateFn ?? sinon.stub().resolves({ activeScope: [] })
    }
  };
}

test("tryInterceptSessionCommand returns null for non-command message", async (t) => {
  const result = await tryInterceptSessionCommand(
    "what is Redis?",
    "user-1",
    makeSessionCommandDeps(),
    NOOP_LOGGER
  );
  t.is(result, null);
});

test("tryInterceptSessionCommand returns null for bare !session", async (t) => {
  const result = await tryInterceptSessionCommand(
    "!session",
    "user-1",
    makeSessionCommandDeps(),
    NOOP_LOGGER
  );
  t.is(result, null);
});

test("tryInterceptSessionCommand returns sessionId and agentId on valid command", async (t) => {
  const result = await tryInterceptSessionCommand(
    "!session agent:work:abc123 work",
    "user-1",
    makeSessionCommandDeps(),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.is(result!.sessionId, "agent:work:abc123");
  t.is(result!.agentId, "work");
});

test("tryInterceptSessionCommand calls getOrCreate with the extracted sessionKey", async (t) => {
  const getOrCreate = sinon.stub().resolves({ activeScope: [] });
  await tryInterceptSessionCommand(
    "!session agent:work:abc123 work",
    "user-1",
    makeSessionCommandDeps(getOrCreate),
    NOOP_LOGGER
  );
  t.true(getOrCreate.calledOnceWith("agent:work:abc123", "user-1"));
});

test("tryInterceptSessionCommand still returns result when getOrCreate fails", async (t) => {
  const getOrCreate = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptSessionCommand(
    "!session agent:work:abc123 work",
    "user-1",
    makeSessionCommandDeps(getOrCreate),
    NOOP_LOGGER
  );
  t.truthy(result);
  t.is(result!.sessionId, "agent:work:abc123");
  t.is(result!.agentId, "work");
});

test("tryInterceptSessionCommand does not call getOrCreate for non-command", async (t) => {
  const getOrCreate = sinon.stub().resolves({});
  await tryInterceptSessionCommand(
    "normal message",
    "user-1",
    makeSessionCommandDeps(getOrCreate),
    NOOP_LOGGER
  );
  t.false(getOrCreate.called);
});
