import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  readTenureConfig,
  generateDefaultTenureConfig
} from "../../tenureConfig.js";

suite("tenureConfig", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenure-config-test-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  suite(".tenure (legacy plain text)", () => {
    test("reads .tenure file", async () => {
      fs.writeFileSync(path.join(tmpDir, ".tenure"), "my-project");
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result?.projectId, "my-project");
    });

    test("returns null when no .tenure file exists", async () => {
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result, null);
    });

    test("returns null for empty string", async () => {
      fs.writeFileSync(path.join(tmpDir, ".tenure"), "");
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result, null);
    });

    test("returns null when file contains only whitespace", async () => {
      fs.writeFileSync(path.join(tmpDir, ".tenure"), "   \n  ");
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result, null);
    });

    test("trims whitespace from project ID", async () => {
      fs.writeFileSync(path.join(tmpDir, ".tenure"), "  my-project  \n");
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result?.projectId, "my-project");
    });
  });

  suite(".tenure.json (new JSON config)", () => {
    test("reads .tenure.json with projectId, ignore, and noiseIgnores", async () => {
      const config = {
        projectId: "my-app",
        ignore: ["customers/**", "contracts/**"],
        noiseIgnores: ["*.sql", "infra/prod/**"]
      };
      fs.writeFileSync(
        path.join(tmpDir, ".tenure.json"),
        JSON.stringify(config)
      );
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result?.projectId, "my-app");
      assert.deepStrictEqual(result?.ignore, ["customers/**", "contracts/**"]);
      assert.deepStrictEqual(result?.noiseIgnores, ["*.sql", "infra/prod/**"]);
    });

    test("reads .tenure.json with projectId only", async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".tenure.json"),
        JSON.stringify({ projectId: "simple" })
      );
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result?.projectId, "simple");
      assert.strictEqual(result?.ignore, undefined);
      assert.strictEqual(result?.noiseIgnores, undefined);
    });

    test("reads .tenure.json with empty ignore arrays", async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".tenure.json"),
        JSON.stringify({ projectId: "app", ignore: [], noiseIgnores: [] })
      );
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result?.projectId, "app");
      assert.deepStrictEqual(result?.ignore, []);
      assert.deepStrictEqual(result?.noiseIgnores, []);
    });

    test("filters non-string entries from ignore and noiseIgnores", async () => {
      const config = {
        projectId: "p",
        ignore: ["valid", null, 123, true],
        noiseIgnores: ["keep", false, 0]
      };
      fs.writeFileSync(
        path.join(tmpDir, ".tenure.json"),
        JSON.stringify(config)
      );
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.deepStrictEqual(result?.ignore, ["valid"]);
      assert.deepStrictEqual(result?.noiseIgnores, ["keep"]);
    });

    test("returns null for .tenure.json without projectId", async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".tenure.json"),
        JSON.stringify({ ignore: ["x"] })
      );
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result, null);
    });

    test("returns null for .tenure.json with empty projectId string", async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".tenure.json"),
        JSON.stringify({ projectId: "" })
      );
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result, null);
    });

    test("returns null for .tenure.json with empty file", async () => {
      fs.writeFileSync(path.join(tmpDir, ".tenure.json"), "");
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result, null);
    });

    test("returns null for .tenure.json with malformed JSON", async () => {
      fs.writeFileSync(path.join(tmpDir, ".tenure.json"), "{ broken");
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result, null);
    });

    test("returns null for .tenure.json that is a JSON array", async () => {
      fs.writeFileSync(path.join(tmpDir, ".tenure.json"), "[1, 2, 3]");
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result, null);
    });

    test("returns null for .tenure.json with projectId that is not a string", async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".tenure.json"),
        JSON.stringify({ projectId: 123 })
      );
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result, null);
    });
  });

  suite("read priority: .tenure.json over .tenure", () => {
    test("prefers .tenure.json when both files exist", async () => {
      fs.writeFileSync(path.join(tmpDir, ".tenure"), "legacy-project");
      fs.writeFileSync(
        path.join(tmpDir, ".tenure.json"),
        JSON.stringify({ projectId: "json-project", ignore: ["secrets/**"] })
      );
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result?.projectId, "json-project");
      assert.deepStrictEqual(result?.ignore, ["secrets/**"]);
    });

    test("falls back to .tenure when .tenure.json missing", async () => {
      fs.writeFileSync(path.join(tmpDir, ".tenure"), "legacy-project");
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result?.projectId, "legacy-project");
      assert.strictEqual(result?.ignore, undefined);
    });

    test("falls back to .tenure when .tenure.json exists but has no projectId", async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".tenure.json"),
        JSON.stringify({ ignore: ["x"] })
      );
      fs.writeFileSync(path.join(tmpDir, ".tenure"), "fallback-project");
      const result = await readTenureConfig(vscode.Uri.file(tmpDir));
      assert.strictEqual(result?.projectId, "fallback-project");
    });
  });
});

suite("generateDefaultTenureConfig", () => {
  test("produces valid JSON with projectId", () => {
    const output = generateDefaultTenureConfig("my-app");
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.projectId, "my-app");
    assert.deepStrictEqual(parsed.ignore, []);
    assert.deepStrictEqual(parsed.noiseIgnores, []);
  });

  test("produces pretty-printed output with 2-space indent", () => {
    const output = generateDefaultTenureConfig("app");
    assert.ok(output.includes('  "projectId"'));
    assert.ok(output.includes('  "ignore"'));
  });

  test("ends with a newline", () => {
    const output = generateDefaultTenureConfig("app");
    assert.ok(output.endsWith("\n"));
  });

  test("only contains expected keys", () => {
    const output = generateDefaultTenureConfig("app");
    const parsed = JSON.parse(output);
    const keys = Object.keys(parsed);
    assert.deepStrictEqual(keys, ["projectId", "ignore", "noiseIgnores"]);
  });
});
