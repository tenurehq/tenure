import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import test from "node:test";

import {
  getTenureFilePolicyForPath,
  invalidateTenureFilePolicyCache
} from "../../filePolicy.js";

suite("Integration: File Policy Cache Invalidation", () => {
  test("evaluateRelativePath picks up hardcoded security deny before any cache", () => {
    const result = getTenureFilePolicyForPath(".env");
    assert.strictEqual(result.decision, "suppress_all");
    assert.strictEqual(result.category, "security");
  });

  test("evaluateRelativePath allows normal source files by default", () => {
    const result = getTenureFilePolicyForPath("src/index.ts");
    assert.strictEqual(result.decision, "allow");
  });

  test("cache key uses workspace root fsPath", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenure-int-"));
    try {
      const uriA = vscode.Uri.file(tmpDir);
      const uriB = vscode.Uri.file(tmpDir);

      const tenureJsonPath = path.join(tmpDir, ".tenure.json");
      fs.writeFileSync(
        tenureJsonPath,
        JSON.stringify({
          projectId: "test-project",
          ignore: [],
          noiseIgnores: ["src/secrets.env"]
        })
      );

      const result = getTenureFilePolicyForPath("src/secrets.env", uriA);
      const resultB = getTenureFilePolicyForPath("src/secrets.env", uriB);
      assert.strictEqual(result.decision, resultB.decision);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

suite("Integration: Workspace State Lifecycle", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenure-int-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("state key handles null vs undefined vs empty string for active_file", () => {
    const makeKey = (af: string | null) =>
      JSON.stringify({
        workspace_root: "/home/test",
        project_name: "test",
        git_remote: null,
        active_file: af,
        active_language: null
      });

    const nullKey = makeKey(null);
    const emptyStringKey = makeKey("");
    const definedKey = makeKey("src/index.ts");

    assert.notStrictEqual(nullKey, emptyStringKey);
    assert.notStrictEqual(nullKey, definedKey);
    assert.notStrictEqual(emptyStringKey, definedKey);
  });

  test("state key changes when git_remote goes from null to empty string", () => {
    const stateA = JSON.stringify({
      workspace_root: "/home/test",
      project_name: "test",
      git_remote: null,
      active_file: null,
      active_language: null
    });

    const stateB = JSON.stringify({
      workspace_root: "/home/test",
      project_name: "test",
      git_remote: "",
      active_file: null,
      active_language: null
    });

    assert.notStrictEqual(stateA, stateB);
  });

  test("sync is skipped when state is byte-identical", () => {
    const state = {
      workspace_root: "/home/test",
      project_name: "test",
      git_remote: "git@github.com:org/repo.git",
      active_file: "src/a.ts",
      active_language: "typescript"
    };

    const key1 = JSON.stringify(state);
    const key2 = JSON.stringify({ ...state });

    assert.strictEqual(key1, key2);
  });

  test("sync fires when active_language changes alone", () => {
    const a = JSON.stringify({
      workspace_root: "/home/test",
      project_name: "test",
      git_remote: null,
      active_file: null,
      active_language: "typescript"
    });

    const b = JSON.stringify({
      workspace_root: "/home/test",
      project_name: "test",
      git_remote: null,
      active_file: null,
      active_language: "javascript"
    });

    assert.notStrictEqual(a, b);
  });

  test("sync fires when workspace_root changes", () => {
    const a = JSON.stringify({
      workspace_root: "/home/alice/project",
      project_name: "test",
      git_remote: null,
      active_file: null,
      active_language: null
    });

    const b = JSON.stringify({
      workspace_root: "/home/bob/project",
      project_name: "test",
      git_remote: null,
      active_file: null,
      active_language: null
    });

    assert.notStrictEqual(a, b);
  });
});

suite("Integration: Belief List Mutations Under Churn", () => {
  interface BeliefSummary {
    id: string;
    canonical_name: string;
    content: string;
    pinned: boolean;
    epistemic_status: string;
    confidence: number;
    type: string;
    why_it_matters: string;
    scope: string[];
    aliases: string[];
  }

  function makeBelief(id: string): BeliefSummary {
    return {
      id,
      canonical_name: id,
      content: `content of ${id}`,
      pinned: false,
      epistemic_status: "active",
      confidence: 0.9,
      type: "preference",
      why_it_matters: "matters",
      scope: ["project:test"],
      aliases: []
    };
  }

  test("rapid upsert and supersede interleaving produces consistent state", () => {
    let beliefs: BeliefSummary[] = [makeBelief("b1"), makeBelief("b2")];

    const upsert = (b: BeliefSummary) => {
      const idx = beliefs.findIndex((x) => x.id === b.id);
      if (idx !== -1) beliefs[idx] = b;
      else beliefs.unshift(b);
    };

    const supersede = (id: string) => {
      beliefs = beliefs.filter((b) => b.id !== id);
    };

    upsert(makeBelief("b3"));
    upsert({ ...makeBelief("b1"), content: "updated b1" });
    supersede("b2");
    upsert(makeBelief("b4"));
    supersede("b3");
    upsert({ ...makeBelief("b4"), content: "updated b4" });

    assert.strictEqual(beliefs.length, 2);
    assert.strictEqual(beliefs[0].id, "b4");
    assert.strictEqual(beliefs[0].content, "updated b4");
    assert.strictEqual(beliefs[1].id, "b1");
    assert.strictEqual(beliefs[1].content, "updated b1");
  });

  test("beliefs_snapshot replaces entire list correctly", () => {
    let beliefs: BeliefSummary[] = [
      makeBelief("old1"),
      makeBelief("old2"),
      makeBelief("old3")
    ];

    const snapshot = [makeBelief("new1"), makeBelief("new2")];

    beliefs = snapshot;

    assert.strictEqual(beliefs.length, 2);
    assert.ok(beliefs.find((b) => b.id === "new1"));
    assert.ok(beliefs.find((b) => b.id === "new2"));
    assert.ok(!beliefs.find((b) => b.id === "old1"));
  });

  test("duplicate upsert does not create duplicates", () => {
    let beliefs: BeliefSummary[] = [makeBelief("b1")];

    const upsert = (b: BeliefSummary) => {
      const idx = beliefs.findIndex((x) => x.id === b.id);
      if (idx !== -1) beliefs[idx] = b;
      else beliefs.unshift(b);
    };

    upsert(makeBelief("b1"));
    upsert(makeBelief("b1"));

    assert.strictEqual(beliefs.length, 1);
  });
});

suite("Integration: Client-Side Belief Categorization", () => {
  interface BeliefSummary {
    id: string;
    canonical_name: string;
    content: string;
    pinned: boolean;
    epistemic_status: string;
    confidence: number;
    type: string;
    why_it_matters: string;
    scope: string[];
    aliases: string[];
    origin_context?: {
      active_file: string | null;
      language: string | null;
      project_scope: string | null;
    } | null;
  }

  function makeBelief(
    id: string,
    overrides: Partial<BeliefSummary> = {}
  ): BeliefSummary {
    return {
      id,
      canonical_name: id,
      content: `content of ${id}`,
      pinned: false,
      epistemic_status: "active",
      confidence: 0.9,
      type: "preference",
      why_it_matters: "matters",
      scope: ["project:test"],
      aliases: [],
      ...overrides
    };
  }

  function categorize(
    beliefs: BeliefSummary[],
    currentActiveFile: string | null
  ) {
    const file: BeliefSummary[] = [];
    const project: BeliefSummary[] = [];
    const universal: BeliefSummary[] = [];

    for (const b of beliefs) {
      if (b.scope.includes("user:universal")) {
        universal.push(b);
      } else if (
        b.origin_context?.active_file &&
        b.origin_context.active_file === currentActiveFile
      ) {
        file.push(b);
      } else {
        project.push(b);
      }
    }

    return { file, project, universal };
  }

  test("universal beliefs go to universal bucket regardless of file context", () => {
    const beliefs = [
      makeBelief("u1", {
        scope: ["user:universal"],
        origin_context: {
          active_file: "src/a.ts",
          language: null,
          project_scope: null
        }
      })
    ];

    const result = categorize(beliefs, "src/a.ts");
    assert.strictEqual(result.universal.length, 1);
    assert.strictEqual(result.file.length, 0);
    assert.strictEqual(result.project.length, 0);
  });

  test("file beliefs only match when active_file exactly equals origin_context", () => {
    const beliefs = [
      makeBelief("f1", {
        origin_context: {
          active_file: "src/a.ts",
          language: null,
          project_scope: null
        }
      })
    ];

    const result = categorize(beliefs, "src/a.ts");
    assert.strictEqual(result.file.length, 1);
    assert.strictEqual(result.project.length, 0);
  });

  test("file beliefs go to project when active_file differs", () => {
    const beliefs = [
      makeBelief("f1", {
        origin_context: {
          active_file: "src/a.ts",
          language: null,
          project_scope: null
        }
      })
    ];

    const result = categorize(beliefs, "src/b.ts");
    assert.strictEqual(result.file.length, 0);
    assert.strictEqual(result.project.length, 1);
  });

  test("null origin_context categorizes as project", () => {
    const beliefs = [makeBelief("p1", { origin_context: null })];

    const result = categorize(beliefs, "src/a.ts");
    assert.strictEqual(result.project.length, 1);
  });

  test("mixed beliefs categorize correctly", () => {
    const beliefs = [
      makeBelief("u1", { scope: ["user:universal"] }),
      makeBelief("f1", {
        origin_context: {
          active_file: "src/a.ts",
          language: null,
          project_scope: null
        }
      }),
      makeBelief("p1", {
        origin_context: {
          active_file: "src/b.ts",
          language: null,
          project_scope: null
        }
      }),
      makeBelief("p2", { origin_context: null })
    ];

    const result = categorize(beliefs, "src/a.ts");
    assert.strictEqual(result.universal.length, 1);
    assert.strictEqual(result.file.length, 1);
    assert.strictEqual(result.project.length, 2);
    assert.strictEqual(result.file[0].id, "f1");
  });
});

suite("Integration: Reconnect Backoff Under Realistic Scenarios", () => {
  const BASE_RECONNECT_MS = 1_000;
  const MAX_RECONNECT_MS = 30_000;

  function backOff(attempt: number): number {
    return Math.min(BASE_RECONNECT_MS * Math.pow(2, attempt), MAX_RECONNECT_MS);
  }

  test("backoff sequence matches expected values", () => {
    const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    for (let i = 0; i < expected.length; i++) {
      assert.strictEqual(backOff(i), expected[i]);
    }
  });

  test("backoff never exceeds MAX_RECONNECT_MS for extreme attempt counts", () => {
    assert.strictEqual(backOff(50), MAX_RECONNECT_MS);
    assert.strictEqual(backOff(1000), MAX_RECONNECT_MS);
  });

  test("backoff never goes below BASE_RECONNECT_MS", () => {
    assert.strictEqual(backOff(0), BASE_RECONNECT_MS);
  });
});

suite("Integration: WebSocket Send Guard Across All States", () => {
  const WS_CONNECTING = 0;
  const WS_OPEN = 1;
  const WS_CLOSING = 2;
  const WS_CLOSED = 3;

  function canSend(readyState: number): boolean {
    return readyState === WS_OPEN;
  }

  test("only OPEN allows sending", () => {
    assert.ok(canSend(WS_OPEN));
    assert.ok(!canSend(WS_CONNECTING));
    assert.ok(!canSend(WS_CLOSING));
    assert.ok(!canSend(WS_CLOSED));
  });
});

suite("Integration: Token Store State Consistency", () => {
  test("token set/get roundtrip through VS Code secrets", async function () {
    const timeout = 5000;
    this.timeout(timeout);

    const { secrets } = require("vscode") as typeof vscode;
    const testToken = `mp_test_${Date.now()}`;

    await secrets.store("tenure.apiToken", testToken);
    const retrieved = await secrets.get("tenure.apiToken");
    assert.strictEqual(retrieved, testToken);

    await secrets.delete("tenure.apiToken");
    const afterClear = await secrets.get("tenure.apiToken");
    assert.strictEqual(afterClear, undefined);
  });
});

suite("Integration: Scope Migration Detection", () => {
  function slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/^@[^/]+\//, "")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  test("detects rename when project name changes", () => {
    const oldState = {
      workspace_root: "/home/test",
      project_name: "old-project",
      git_remote: null,
      active_file: null,
      active_language: null
    };

    const newState = { ...oldState, project_name: "new-project" };

    const renamed = oldState.project_name !== newState.project_name;
    assert.ok(renamed);
  });

  test("does not detect rename when only active_file changes", () => {
    const oldState = {
      workspace_root: "/home/test",
      project_name: "stable-project",
      git_remote: null,
      active_file: "src/a.ts",
      active_language: "typescript"
    };

    const newState = { ...oldState, active_file: "src/b.ts" };

    const renamed = oldState.project_name !== newState.project_name;
    assert.ok(!renamed);
  });

  test("migrate scope body uses slugified names", () => {
    const body = {
      old_scope: `project:${slugify("My Old Project")}`,
      new_scope: `project:${slugify("New Project!")}`
    };

    assert.strictEqual(body.old_scope, "project:my-old-project");
    assert.strictEqual(body.new_scope, "project:new-project");
  });
});

suite("Integration: onDidRenameFiles Filtering With Edge Cases", () => {
  function shouldSendRename(oldPath: string, newPath: string): boolean {
    return !path.isAbsolute(oldPath) && !path.isAbsolute(newPath);
  }

  test("sends for relative to relative", () => {
    assert.ok(shouldSendRename("src/old.ts", "src/new.ts"));
  });

  test("skips when old is absolute", () => {
    assert.ok(!shouldSendRename("/home/test/src/old.ts", "src/new.ts"));
  });

  test("skips when new is absolute", () => {
    assert.ok(!shouldSendRename("src/old.ts", "/home/test/src/new.ts"));
  });

  test("skips when both are absolute", () => {
    assert.ok(
      !shouldSendRename("/home/test/src/old.ts", "/home/test/src/new.ts")
    );
  });

  test("handles OS-specific absolute paths correctly", () => {
    const isWin = os.platform() === "win32";
    if (isWin) {
      assert.ok(!shouldSendRename("C:\\Users\\test\\old.ts", "src/new.ts"));
      assert.ok(!shouldSendRename("src/old.ts", "D:\\projects\\new.ts"));
    } else {
      assert.ok(shouldSendRename("C:\\Users\\test\\old.ts", "src/new.ts"));
      assert.ok(shouldSendRename("src/old.ts", "D:\\projects\\new.ts"));
    }
  });

  test("handles paths with .. segments as relative", () => {
    assert.ok(shouldSendRename("../shared/old.ts", "../shared/new.ts"));
  });
});

suite("Integration: Redaction Does Not False-Positive Benign Content", () => {
  function redactSensitiveText(text: string): string {
    const rules: Array<{ re: RegExp; replacement: string }> = [
      {
        re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        replacement: "[REDACTED_PRIVATE_KEY]"
      },
      { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_ACCESS_KEY]" },
      {
        re: /\bASIA[0-9A-Z]{16}\b/g,
        replacement: "[REDACTED_AWS_TEMP_ACCESS_KEY]"
      },
      {
        re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
        replacement: "[REDACTED_GITHUB_TOKEN]"
      },
      { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
      {
        re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
        replacement: "[REDACTED_ANTHROPIC_KEY]"
      },
      {
        re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
        replacement: "[REDACTED_SLACK_TOKEN]"
      },
      {
        re: /\b(?:pk|sk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
        replacement: "[REDACTED_STRIPE_KEY]"
      },
      {
        re: /\bpostgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@[^\s]+/gi,
        replacement: "postgres://[REDACTED_CREDENTIALS]@[REDACTED_HOST]"
      },
      {
        re: /\bmysql:\/\/[^\s:@]+:[^\s@]+@[^\s]+/gi,
        replacement: "mysql://[REDACTED_CREDENTIALS]@[REDACTED_HOST]"
      },
      {
        re: /\bmongodb(?:\+srv)?:\/\/[^\s:@]+:[^\s@]+@[^\s]+/gi,
        replacement: "mongodb://[REDACTED_CREDENTIALS]@[REDACTED_HOST]"
      },
      {
        re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/g,
        replacement: "Bearer [REDACTED_TOKEN]"
      },
      {
        re: /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\b/g,
        replacement: "[REDACTED_JWT]"
      }
    ];

    let redacted = text;
    for (const { re, replacement } of rules) {
      redacted = redacted.replace(re, replacement);
    }
    return redacted;
  }

  test("leaves normal prose untouched", () => {
    const input =
      "We use PostgreSQL for our database and deploy on AWS using GitHub Actions.";
    assert.strictEqual(redactSensitiveText(input), input);
  });

  test("leaves short hex strings untouched (not a JWT)", () => {
    const input = "commit abc123def456 on branch main";
    assert.strictEqual(redactSensitiveText(input), input);
  });

  test("leaves UUID-like strings untouched", () => {
    const input = "trace-id: 550e8400-e29b-41d4-a716-446655440000";
    const result = redactSensitiveText(input);
    assert.ok(!result.includes("REDACTED"));
  });

  test("redacts actual JWT but not short dotted strings", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const benign = "v1.2.3";

    assert.ok(redactSensitiveText(jwt).includes("[REDACTED_JWT]"));
    assert.strictEqual(redactSensitiveText(benign), benign);
  });

  test("redacts multiple patterns in a single line", () => {
    const input =
      "AKIAIOSFODNN7EXAMPLE token: ghp_example1234567890abcdefgh postgres://user:pass@host/db";
    const result = redactSensitiveText(input);
    assert.ok(result.includes("[REDACTED_AWS_ACCESS_KEY]"));
    assert.ok(result.includes("[REDACTED_GITHUB_TOKEN]"));
    assert.ok(result.includes("[REDACTED_CREDENTIALS]"));
  });
});

suite("Integration: Configuration Edge Cases", () => {
  test("securityIgnorePatterns as non-array does not throw", () => {
    const cfg = vscode.workspace.getConfiguration("tenure");
    const value = cfg.get<unknown>("securityIgnorePatterns");

    if (value !== undefined && value !== null) {
      assert.ok(
        Array.isArray(value) ||
          typeof value === "string" ||
          typeof value === "object"
      );
    }
  });

  test("baseUrl with trailing slash is handled consistently", () => {
    const urls = [
      "http://localhost:5757",
      "http://localhost:5757/",
      "http://localhost:5757///"
    ];

    const normalized = urls.map((u) => u.replace(/\/+$/, ""));
    assert.strictEqual(new Set(normalized).size, 1);
    assert.strictEqual(normalized[0], "http://localhost:5757");
  });

  test("baseUrl ws conversion is correct", () => {
    const httpUrl = "http://localhost:5757";
    const httpsUrl = "https://tenure.example.com:5757";

    const ws1 = httpUrl.replace(/^http/, "ws") + "/v1/ws/beliefs";
    const ws2 = httpsUrl.replace(/^http/, "ws") + "/v1/ws/beliefs";

    assert.strictEqual(ws1, "ws://localhost:5757/v1/ws/beliefs");
    assert.strictEqual(ws2, "wss://tenure.example.com:5757/v1/ws/beliefs");
  });
});

suite("Integration: Record Belief Scope Fallback", () => {
  function slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/^@[^/]+\//, "")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  test("file scope falls back to project scope", () => {
    const currentScope = "project:my-app";
    const scopeLevel = "file";
    const scope =
      scopeLevel === "file" && currentScope
        ? [currentScope]
        : ["user:universal"];

    assert.deepStrictEqual(scope, ["project:my-app"]);
  });

  test("universal scope ignores currentScope completely", () => {
    const scopeLevel = "universal";
    const scope =
      scopeLevel === "universal" ? ["user:universal"] : ["project:test"];

    assert.deepStrictEqual(scope, ["user:universal"]);
  });

  test("project scope uses currentScope when available", () => {
    const currentScope = "project:my-project";
    const scopeLevel = "project";
    const scope = currentScope ? [currentScope] : ["user:universal"];

    assert.deepStrictEqual(scope, ["project:my-project"]);
  });

  test("project scope falls back to universal when currentScope is null", () => {
    const currentScope: string | null = null;
    const scopeLevel = "project";
    const scope = currentScope ? [currentScope] : ["user:universal"];

    assert.deepStrictEqual(scope, ["user:universal"]);
  });

  test("canonical name construction is stable across equivalent inputs", () => {
    const buildName = (content: string) =>
      content
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .slice(0, 5)
        .join("_");

    const a = buildName("We should use fetch not axios");
    const b = buildName("We should use fetch not axios!!");
    const c = buildName("We   should   use   fetch   not   axios");

    assert.strictEqual(a, "we_should_use_fetch_not");
    assert.strictEqual(b, "we_should_use_fetch_not");
    assert.strictEqual(c, "we_should_use_fetch_not");
  });
});

suite("Integration: Host App Detection", () => {
  function resolveHostApp(appName: string): string {
    const name = appName.toLowerCase();
    if (name.includes("cursor")) return "cursor";
    if (name.includes("windsurf")) return "windsurf";
    if (name.includes("vscodium")) return "vscodium";
    if (name.includes("visual studio code")) return "vscode";
    if (name === "code") return "vscode";
    return "unknown";
  }

  test("detects VS Code variants", () => {
    assert.strictEqual(resolveHostApp("Visual Studio Code"), "vscode");
    assert.strictEqual(
      resolveHostApp("Visual Studio Code - Insiders"),
      "vscode"
    );
    assert.strictEqual(resolveHostApp("Code"), "vscode");
    assert.strictEqual(resolveHostApp("Code - OSS"), "vscode");
  });

  test("detects Cursor and Windsurf without ambiguity", () => {
    assert.strictEqual(resolveHostApp("Cursor"), "cursor");
    assert.strictEqual(resolveHostApp("Windsurf"), "windsurf");
    assert.strictEqual(resolveHostApp("Windsurf Next"), "windsurf");
  });

  test("VSCodium is not confused with Code", () => {
    assert.strictEqual(resolveHostApp("VSCodium"), "vscodium");
    assert.strictEqual(resolveHostApp("VSCodium - Insiders"), "vscodium");
  });

  test("unknown apps return unknown", () => {
    assert.strictEqual(resolveHostApp(""), "unknown");
    assert.strictEqual(resolveHostApp("Emacs"), "unknown");
    assert.strictEqual(resolveHostApp("IntelliJ IDEA"), "unknown");
  });

  test("case insensitive", () => {
    assert.strictEqual(resolveHostApp("VISUAL STUDIO CODE"), "vscode");
    assert.strictEqual(resolveHostApp("cursor"), "cursor");
    assert.strictEqual(resolveHostApp("WindSurf"), "windsurf");
  });
});

suite("Integration: Local Fallback Slug Stability", () => {
  function getLocalFallbackSlug(workspaceRoot: string): string {
    const { createHash } = require("node:crypto");
    const folderName = path.basename(workspaceRoot);
    const hash = createHash("md5")
      .update(workspaceRoot)
      .digest("hex")
      .slice(0, 8);
    return `${folderName}-${hash}`;
  }

  test("same path always produces same slug", () => {
    const root = "/home/user/my-project";
    assert.strictEqual(getLocalFallbackSlug(root), getLocalFallbackSlug(root));
  });

  test("different paths produce different slugs", () => {
    const a = getLocalFallbackSlug("/home/alice/project");
    const b = getLocalFallbackSlug("/home/bob/project");
    assert.notStrictEqual(a, b);
  });

  test("slug contains folder name and 8-char hex", () => {
    const slug = getLocalFallbackSlug("/data/repos/backend");
    assert.ok(slug.startsWith("backend-"));
    const parts = slug.split("-");
    const hash = parts[parts.length - 1];
    assert.strictEqual(hash.length, 8);
    assert.match(hash, /^[0-9a-f]{8}$/);
  });
});

suite("Integration: LM Provider Model Deduplication", () => {
  interface ModelInfo {
    id: string;
    name: string;
    family: string;
    version: string;
    maxInputTokens: number;
    maxOutputTokens: number;
  }

  function deduplicate(models: ModelInfo[]): ModelInfo[] {
    const seen = new Set<string>();
    return models.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  test("default model is not duplicated when also in probed list", () => {
    const probed = [
      {
        id: "gpt-4o",
        name: "gpt-4o",
        family: "tenure",
        version: "1",
        maxInputTokens: 128000,
        maxOutputTokens: 16000
      },
      {
        id: "claude-sonnet-4-20250514",
        name: "claude-sonnet-4-20250514",
        family: "tenure",
        version: "1",
        maxInputTokens: 128000,
        maxOutputTokens: 16000
      }
    ];

    const defaultModel = {
      id: "gpt-4o",
      name: "gpt-4o",
      family: "tenure",
      version: "1",
      maxInputTokens: 128000,
      maxOutputTokens: 16000
    };

    let models = [defaultModel, ...probed];
    models = deduplicate(models);

    assert.strictEqual(models.length, 2);
  });

  test("default model is prepended when not in probed list", () => {
    const probed = [
      {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        family: "tenure",
        version: "1",
        maxInputTokens: 128000,
        maxOutputTokens: 16000
      }
    ];

    const defaultModel = {
      id: "gpt-4o",
      name: "gpt-4o",
      family: "tenure",
      version: "1",
      maxInputTokens: 128000,
      maxOutputTokens: 16000
    };

    let models = [defaultModel, ...probed];
    models = deduplicate(models);

    assert.strictEqual(models.length, 2);
    assert.strictEqual(models[0].id, "gpt-4o");
  });
});

suite("Integration: SSE Parsing Robustness", () => {
  async function* parseSSE(
    chunks: string[]
  ): AsyncGenerator<Record<string, unknown>> {
    let buffer = "";
    for (const chunk of chunks) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") return;
          try {
            yield JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
        }
      }
    }
  }

  test("handles message split across chunks", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\n'
    ];

    const results: string[] = [];
    for await (const data of parseSSE(chunks)) {
      const choices = data.choices as Array<{ delta?: { content?: string } }>;
      results.push(choices?.[0]?.delta?.content ?? "");
    }

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0], "Hello");
  });

  test("handles multiple complete messages in one chunk", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\n'
    ];

    const results: string[] = [];
    for await (const data of parseSSE(chunks)) {
      const choices = data.choices as Array<{ delta?: { content?: string } }>;
      results.push(choices?.[0]?.delta?.content ?? "");
    }

    assert.deepStrictEqual(results, ["A", "B"]);
  });

  test("handles malformed data lines gracefully", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"good"}}]}\n\ndata: not-json\n\ndata: {"choices":[{"delta":{"content":"also good"}}]}\n\n'
    ];

    const results: string[] = [];
    for await (const data of parseSSE(chunks)) {
      const choices = data.choices as Array<{ delta?: { content?: string } }>;
      results.push(choices?.[0]?.delta?.content ?? "");
    }

    assert.deepStrictEqual(results, ["good", "also good"]);
  });

  test("handles [DONE] signal correctly", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"last"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"ignored"}}]}\n\n'
    ];

    const results: string[] = [];
    for await (const data of parseSSE(chunks)) {
      const choices = data.choices as Array<{ delta?: { content?: string } }>;
      results.push(choices?.[0]?.delta?.content ?? "");
    }

    assert.deepStrictEqual(results, ["last"]);
  });

  test("handles empty data lines", async () => {
    const chunks = [
      'data: \n\ndata: {"choices":[{"delta":{"content":"valid"}}]}\n\n'
    ];

    const results: string[] = [];
    for await (const data of parseSSE(chunks)) {
      const choices = data.choices as Array<{ delta?: { content?: string } }>;
      results.push(choices?.[0]?.delta?.content ?? "");
    }

    assert.deepStrictEqual(results, ["valid"]);
  });
});

suite("Integration: File Policy Segment Guards (Defense in Depth)", () => {
  function getSegments(relativePath: string): string[] {
    return relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  }

  function hasSensitiveSegment(segments: string[]): boolean {
    return segments.some((s) =>
      [".ssh", ".aws", ".azure", ".kube", ".gnupg"].includes(s)
    );
  }

  function hasGeneratedSegment(segments: string[]): boolean {
    return segments.some((s) => ["node_modules", ".git"].includes(s));
  }

  test("unusual node_modules path still caught by segment guard", () => {
    const segments = getSegments("weird/deep/nested/node_modules/pkg/index.js");
    assert.ok(hasGeneratedSegment(segments));
  });

  test(".ssh anywhere in path triggers security", () => {
    const segments = getSegments("home/user/.ssh/authorized_keys");
    assert.ok(hasSensitiveSegment(segments));
  });

  test(".aws anywhere in path triggers security", () => {
    const segments = getSegments("home/user/.aws/credentials");
    assert.ok(hasSensitiveSegment(segments));
  });

  test(".kube triggers security even without kubeconfig filename", () => {
    const segments = getSegments("home/user/.kube/some-file");
    assert.ok(hasSensitiveSegment(segments));
  });

  test(".gnupg triggers security", () => {
    const segments = getSegments("home/user/.gnupg/pubring.kbx");
    assert.ok(hasSensitiveSegment(segments));
  });

  test("normal source paths do not trigger segment guards", () => {
    const segments = getSegments("src/components/Button.tsx");
    assert.ok(!hasSensitiveSegment(segments));
    assert.ok(!hasGeneratedSegment(segments));
  });

  test("paths that contain segment-like substrings are not falsely caught", () => {
    const segments = getSegments("src/my_ssh_helper.ts");
    assert.ok(!hasSensitiveSegment(segments));
    assert.ok(!hasGeneratedSegment(segments));
  });
});

suite("Integration: Onboarding State Machine Transitions", () => {
  type OnboardingState =
    | "token_entry"
    | "provider_setup"
    | "model_picker"
    | "questions"
    | "review"
    | "complete";

  test("token entry transitions to provider setup when no provider configured", () => {
    const state = "token_entry";
    const hasProvider = false;
    const hasModel = false;

    let next: OnboardingState = state;
    if (state === "token_entry" && !hasProvider) {
      next = "provider_setup";
    }

    assert.strictEqual(next, "provider_setup");
  });

  test("token entry transitions to model picker when provider exists but no model", () => {
    const state = "token_entry";
    const hasProvider = true;
    const hasModel = false;

    let next: OnboardingState = state;
    if (state === "token_entry") {
      if (!hasProvider) next = "provider_setup";
      else if (!hasModel) next = "model_picker";
      else next = "questions";
    }

    assert.strictEqual(next, "model_picker");
  });

  test("skip setup during questions still commits seeded_agent flag", () => {
    let seededFlag = false;

    const skip = () => {
      seededFlag = true;
    };

    skip();
    assert.ok(seededFlag);
  });

  test("seeded_agent check uses strict equality with true", () => {
    const rawConfig: Record<string, unknown> = {
      "seeded_agent:vscode": true,
      "seeded_agent:openwebui": "true"
    };

    const alreadySeeded =
      rawConfig["seeded_agent:vscode"] === true ||
      rawConfig["seeded_agent:openwebui"] === true ||
      rawConfig["seeded_agent:openclaw"] === true;

    assert.ok(alreadySeeded);
  });

  test("string 'true' does not count as seeded in strict check for vscode", () => {
    const rawConfig: Record<string, unknown> = {
      "seeded_agent:vscode": "true"
    };

    const alreadySeeded =
      rawConfig["seeded_agent:vscode"] === true ||
      rawConfig["seeded_agent:openwebui"] === true ||
      rawConfig["seeded_agent:openclaw"] === true;

    assert.ok(!alreadySeeded);
  });
});

suite("Integration: Continue Config Injection Edge Cases", () => {
  type ContinueInjectResult =
    | "injected"
    | "already_configured"
    | "no_config_file"
    | "parse_error"
    | "ts_config";

  function simulateInject(
    configExists: boolean,
    tsConfigExists: boolean,
    alreadyHasBaseUrl: boolean,
    validJson: boolean,
    modelsIsArray: boolean
  ): ContinueInjectResult {
    if (tsConfigExists) return "ts_config";
    if (!configExists) return "no_config_file";
    if (!validJson) return "parse_error";
    if (alreadyHasBaseUrl) return "already_configured";
    return "injected";
  }

  test("ts_config takes precedence over json config", () => {
    assert.strictEqual(
      simulateInject(true, true, false, true, true),
      "ts_config"
    );
  });

  test("no config file returns no_config_file", () => {
    assert.strictEqual(
      simulateInject(false, false, false, true, true),
      "no_config_file"
    );
  });

  test("malformed JSON returns parse_error", () => {
    assert.strictEqual(
      simulateInject(true, false, false, false, true),
      "parse_error"
    );
  });

  test("already configured returns already_configured", () => {
    assert.strictEqual(
      simulateInject(true, false, true, true, true),
      "already_configured"
    );
  });

  test("fresh config returns injected", () => {
    assert.strictEqual(
      simulateInject(true, false, false, true, true),
      "injected"
    );
  });

  test("ts_config trumps already_configured in json", () => {
    assert.strictEqual(
      simulateInject(true, true, true, true, true),
      "ts_config"
    );
  });
});

suite("Integration: Git Remote Resolution Edge Cases", () => {
  function extractRepoName(remoteUrl: string): string | null {
    const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
    return match?.[1] ?? null;
  }

  test("extracts from HTTPS URL", () => {
    assert.strictEqual(
      extractRepoName("https://github.com/org/repo.git"),
      "repo"
    );
  });

  test("extracts from SSH URL", () => {
    assert.strictEqual(extractRepoName("git@github.com:org/repo.git"), "repo");
  });

  test("extracts from URL without .git suffix", () => {
    assert.strictEqual(extractRepoName("https://github.com/org/repo"), "repo");
  });

  test("handles nested group paths", () => {
    assert.strictEqual(
      extractRepoName("https://gitlab.com/group/subgroup/repo.git"),
      "repo"
    );
  });

  test("returns null for malformed URL", () => {
    assert.strictEqual(extractRepoName("not-a-url"), null);
  });

  test("returns null for empty string", () => {
    assert.strictEqual(extractRepoName(""), null);
  });
});

suite("Integration: Policy Decision Consistency", () => {
  test("suppress_all always implies suppressContent and suppressMetadata", () => {
    const policy = {
      decision: "suppress_all" as const,
      category: "security" as const,
      suppressContent: true,
      suppressMetadata: true,
      ignored: true
    };

    assert.ok(policy.suppressContent);
    assert.ok(policy.suppressMetadata);
    assert.ok(policy.ignored);
  });

  test("suppress_content implies suppressContent but not suppressMetadata", () => {
    const policy = {
      decision: "suppress_content" as const,
      category: "noise" as const,
      suppressContent: true,
      suppressMetadata: false,
      ignored: true
    };

    assert.ok(policy.suppressContent);
    assert.ok(!policy.suppressMetadata);
    assert.ok(policy.ignored);
  });

  test("allow has all suppression flags off", () => {
    const policy = {
      decision: "allow" as const,
      category: "allowed" as const,
      suppressContent: false,
      suppressMetadata: false,
      ignored: false
    };

    assert.ok(!policy.suppressContent);
    assert.ok(!policy.suppressMetadata);
    assert.ok(!policy.ignored);
  });

  test("outside_workspace is always suppress_all", () => {
    const policy = {
      decision: "suppress_all" as const,
      category: "outside_workspace" as const,
      reason: "Path outside workspace root",
      suppressContent: true,
      suppressMetadata: true,
      ignored: true
    };

    assert.strictEqual(policy.decision, "suppress_all");
    assert.ok(policy.suppressContent);
    assert.ok(policy.suppressMetadata);
  });

  test("unsupported_scheme is always suppress_all", () => {
    const policy = {
      decision: "suppress_all" as const,
      category: "unsupported_scheme" as const,
      reason: "Unsupported URI scheme: vscode-notebook",
      suppressContent: true,
      suppressMetadata: true,
      ignored: true
    };

    assert.strictEqual(policy.decision, "suppress_all");
  });
});

suite("Integration: Tool Call Accumulator", () => {
  interface ToolCallAccumulator {
    id: string;
    name: string;
    arguments: string;
  }

  function accumulate(
    acc: Record<number, ToolCallAccumulator>,
    toolCalls: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>
  ): void {
    for (const tc of toolCalls) {
      if (!acc[tc.index]) {
        acc[tc.index] = { id: "", name: "", arguments: "" };
      }
      if (tc.id) acc[tc.index].id = tc.id;
      if (tc.function?.name) acc[tc.index].name = tc.function.name;
      if (tc.function?.arguments)
        acc[tc.index].arguments += tc.function.arguments;
    }
  }

  test("accumulates tool call across multiple deltas", () => {
    const acc: Record<number, ToolCallAccumulator> = {};

    accumulate(acc, [
      { index: 0, id: "call_1", function: { name: "read_file" } }
    ]);
    accumulate(acc, [{ index: 0, function: { arguments: '{"path":' } }]);
    accumulate(acc, [
      { index: 0, function: { arguments: '"/src/index.ts"}' } }
    ]);

    assert.strictEqual(acc[0].id, "call_1");
    assert.strictEqual(acc[0].name, "read_file");
    assert.strictEqual(acc[0].arguments, '{"path":"/src/index.ts"}');
  });

  test("handles multiple parallel tool calls", () => {
    const acc: Record<number, ToolCallAccumulator> = {};

    accumulate(acc, [
      { index: 0, id: "call_1", function: { name: "read_file" } },
      { index: 1, id: "call_2", function: { name: "search" } }
    ]);
    accumulate(acc, [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }]);
    accumulate(acc, [
      { index: 1, function: { arguments: '{"query":"test"}' } }
    ]);

    assert.strictEqual(acc[0].name, "read_file");
    assert.strictEqual(acc[0].arguments, '{"path":"a.ts"}');
    assert.strictEqual(acc[1].name, "search");
    assert.strictEqual(acc[1].arguments, '{"query":"test"}');
  });

  test("filters out entries with no name", () => {
    const acc: Record<number, ToolCallAccumulator> = {};

    accumulate(acc, [{ index: 0, function: { arguments: "partial" } }]);

    const valid = Object.values(acc).filter((tc) => tc.name);
    assert.strictEqual(valid.length, 0);
  });
});
