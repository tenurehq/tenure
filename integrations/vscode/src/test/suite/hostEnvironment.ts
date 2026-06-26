import * as assert from "assert";
import { resolveHostApp } from "../../hostEnvironment.js";

suite("resolveHostApp", () => {
  test("detects VS Code", () => {
    assert.strictEqual(resolveHostApp("Visual Studio Code"), "vscode");
    assert.strictEqual(
      resolveHostApp("Visual Studio Code - Insiders"),
      "vscode"
    );
    assert.strictEqual(resolveHostApp("Code"), "vscode");
  });

  test("detects Cursor", () => {
    assert.strictEqual(resolveHostApp("Cursor"), "cursor");
    assert.strictEqual(resolveHostApp("Cursor Nightly"), "cursor");
  });

  test("detects Windsurf", () => {
    assert.strictEqual(resolveHostApp("Windsurf"), "windsurf");
    assert.strictEqual(resolveHostApp("Windsurf Next"), "windsurf");
  });

  test("detects VSCodium", () => {
    assert.strictEqual(resolveHostApp("VSCodium"), "vscodium");
  });

  test("returns unknown for unrecognized", () => {
    assert.strictEqual(resolveHostApp("Emacs"), "unknown");
    assert.strictEqual(resolveHostApp(""), "unknown");
  });

  test("case insensitive", () => {
    assert.strictEqual(resolveHostApp("visual studio code"), "vscode");
    assert.strictEqual(resolveHostApp("CURSOR"), "cursor");
    assert.strictEqual(resolveHostApp("Windsurf"), "windsurf");
  });
});
