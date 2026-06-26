import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  getTenureFilePolicyForPath,
  redactSensitiveText
} from "../../filePolicy.js";

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function globToRegex(glob: string): RegExp {
  let out = "";
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i];
    const next = glob[i + 1];
    const afterNext = glob[i + 2];

    if (ch === "*" && next === "*") {
      if (afterNext === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }

    if (ch === "*") {
      out += "[^/]*";
      i++;
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }

    if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return new RegExp(`^${out}$`, "i");
}

function uniquePatterns(patterns: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = normalizePath(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseTenureConfig(text: string): {
  security: string[];
  noise: string[];
} {
  const trimmed = text.trim();
  if (!trimmed) return { security: [], noise: [] };

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { security: [], noise: [] };
    }

    const asStrings = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is string => typeof item === "string");
    };

    return {
      security: uniquePatterns(asStrings(parsed.ignore)),
      noise: uniquePatterns(asStrings(parsed.noiseIgnores))
    };
  } catch {
    return { security: [], noise: [] };
  }
}

suite("globToRegex", () => {
  test("matches root .env", () => {
    const re = globToRegex("**/.env");
    assert.ok(re.test(".env"));
  });

  test("matches nested .env", () => {
    const re = globToRegex("**/.env");
    assert.ok(re.test("apps/api/.env"));
  });

  test("matches .env.* variants", () => {
    const re = globToRegex("**/.env.*");
    assert.ok(re.test(".env.production"));
    assert.ok(re.test(".env.local"));
    assert.ok(re.test("packages/foo/.env.test"));
  });

  test("does not false-match .env in middle of path", () => {
    const re = globToRegex("**/.env");
    assert.ok(!re.test("src/env.ts"));
  });

  test("matches secret folder contents with **", () => {
    const re = globToRegex("**/secrets/**");
    assert.ok(re.test("secrets/stripe.key"));
    assert.ok(re.test("infra/secrets/prod.json"));
    assert.ok(!re.test("src/secrets.ts"));
  });

  test("matches private.key anywhere", () => {
    const re = globToRegex("**/private.key");
    assert.ok(re.test("private.key"));
    assert.ok(re.test("config/private.key"));
  });

  test("matches *.pem anywhere", () => {
    const re = globToRegex("**/*.pem");
    assert.ok(re.test("cert.pem"));
    assert.ok(re.test("certs/client.pem"));
  });

  test("matches node_modules deep paths", () => {
    const re = globToRegex("**/node_modules/**");
    assert.ok(re.test("node_modules/react/index.js"));
    assert.ok(re.test("packages/a/node_modules/lodash/index.js"));
  });

  test("does not false-match node_modules as filename", () => {
    const re = globToRegex("**/node_modules/**");
    assert.ok(!re.test("src/node_modules.ts"));
  });

  test("matches terraform state files", () => {
    const re = globToRegex("**/*.tfstate");
    assert.ok(re.test("terraform.tfstate"));
    assert.ok(re.test("prod.terraform.tfstate"));
  });

  test("matches .git/**", () => {
    const re = globToRegex("**/.git/**");
    assert.ok(re.test(".git/config"));
    assert.ok(re.test(".git/objects/ab/cd123"));
    assert.ok(!re.test("src/git.ts"));
  });

  test("matches .aws credentials", () => {
    const re = globToRegex("**/.aws/**");
    assert.ok(re.test(".aws/credentials"));
    assert.ok(re.test("home/.aws/config"));
  });

  test("matches kubeconfig bare file", () => {
    const re = globToRegex("**/kubeconfig");
    assert.ok(re.test("kubeconfig"));
    assert.ok(re.test("clusters/kubeconfig"));
  });

  test("matches lock files", () => {
    const re = globToRegex("**/package-lock.json");
    assert.ok(re.test("package-lock.json"));
    assert.ok(re.test("sub/package-lock.json"));
  });

  test("matches id_rsa and id_ed25519", () => {
    const reRsa = globToRegex("**/id_rsa");
    const reEd = globToRegex("**/id_ed25519");
    assert.ok(reRsa.test(".ssh/id_rsa"));
    assert.ok(reEd.test(".ssh/id_ed25519"));
    assert.ok(!reRsa.test("src/id_rsa.ts"));
  });

  test("case insensitive matching", () => {
    const re = globToRegex("**/.env");
    assert.ok(re.test(".ENV"));
    assert.ok(re.test("Apps/Api/.Env"));
  });

  test("matches exact basename patterns (no ** needed)", () => {
    const re = globToRegex("id_rsa");
    assert.ok(re.test("id_rsa"));
    assert.ok(!re.test("foo/id_rsa"));
  });

  test("? matches single non-slash character", () => {
    const re = globToRegex("???.env");
    assert.ok(re.test("foo.env"));
    assert.ok(!re.test("fo.env"));
    assert.ok(!re.test("foo/bar.env"));
  });

  test("handles regex special characters in pattern", () => {
    const re = globToRegex("**/google-services.json");
    assert.ok(re.test("google-services.json"));
    assert.ok(re.test("app/google-services.json"));
  });
});

suite("uniquePatterns", () => {
  test("deduplicates identical patterns", () => {
    const result = uniquePatterns(["**/.env", "**/.env", "**/secrets/**"]);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result, ["**/.env", "**/secrets/**"]);
  });

  test("filters empty and comment lines", () => {
    const result = uniquePatterns(["", "  ", "# comment", "**/.env"]);
    assert.deepStrictEqual(result, ["**/.env"]);
  });

  test("normalizes backslashes to forward slashes", () => {
    const result = uniquePatterns(["apps\\api\\.env", "apps/api/.env"]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], "apps/api/.env");
  });

  test("collapses double slashes", () => {
    const result = uniquePatterns(["foo//bar"]);
    assert.strictEqual(result[0], "foo/bar");
  });
});

suite("parseTenureConfig", () => {
  test("parses ignore and noiseIgnores from JSON", () => {
    const json = JSON.stringify({
      projectId: "my-project",
      ignore: ["customers/**", "contracts/**"],
      noiseIgnores: ["*.sql", "infra/prod/**"]
    });
    const result = parseTenureConfig(json);
    assert.deepStrictEqual(result.security, ["customers/**", "contracts/**"]);
    assert.deepStrictEqual(result.noise, ["*.sql", "infra/prod/**"]);
  });

  test("handles empty ignore arrays", () => {
    const json = JSON.stringify({
      projectId: "my-project",
      ignore: [],
      noiseIgnores: []
    });
    const result = parseTenureConfig(json);
    assert.deepStrictEqual(result.security, []);
    assert.deepStrictEqual(result.noise, []);
  });

  test("returns empty for plain text (legacy .tenure)", () => {
    const result = parseTenureConfig("my-project");
    assert.deepStrictEqual(result.security, []);
    assert.deepStrictEqual(result.noise, []);
  });

  test("returns empty for empty string", () => {
    const result = parseTenureConfig("");
    assert.deepStrictEqual(result.security, []);
    assert.deepStrictEqual(result.noise, []);
  });

  test("filters non-string items from arrays", () => {
    const json = JSON.stringify({
      projectId: "p",
      ignore: ["valid", null, 123, true, "also-valid"]
    });
    const result = parseTenureConfig(json);
    assert.deepStrictEqual(result.security, ["valid", "also-valid"]);
  });

  test("returns empty for malformed JSON", () => {
    const result = parseTenureConfig("{ broken");
    assert.deepStrictEqual(result.security, []);
    assert.deepStrictEqual(result.noise, []);
  });
});

suite("redactSensitiveText", () => {
  test("redacts AWS access key", () => {
    const result = redactSensitiveText("key=AKIAIOSFODNN7EXAMPLE here");
    assert.ok(!result.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(result.includes("[REDACTED_AWS_ACCESS_KEY]"));
  });

  test("redacts AWS temp access key", () => {
    const result = redactSensitiveText("ASIA1234567890ABCDEF");
    assert.ok(result.includes("[REDACTED_AWS_TEMP_ACCESS_KEY]"));
  });

  test("redacts GitHub token", () => {
    const result = redactSensitiveText("token: ghp_abcdefghijklmnopqrstuvwx");
    assert.ok(result.includes("[REDACTED_GITHUB_TOKEN]"));
  });

  test("redacts OpenAI-style API key", () => {
    const result = redactSensitiveText(
      "Authorization: sk-proj-abcdefghijklmnopqrstuvwxyz"
    );
    assert.ok(result.includes("[REDACTED_API_KEY]"));
  });

  test("redacts Anthropic API key (matched by generic sk- pattern first)", () => {
    const result = redactSensitiveText(
      "x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
    );
    assert.ok(result.includes("[REDACTED_API_KEY]"));
  });

  test("redacts Slack token", () => {
    const result = redactSensitiveText("xoxb-1234567890-abcdefghijklmnop");
    assert.ok(result.includes("[REDACTED_SLACK_TOKEN]"));
  });

  test("redacts Stripe live key", () => {
    const result = redactSensitiveText("sk_live_abcdefghijklmnopqrstuvwx");
    assert.ok(result.includes("[REDACTED_STRIPE_KEY]"));
  });

  test("redacts Stripe test key", () => {
    const result = redactSensitiveText("pk_test_abcdefghijklmnopqrstuvwx");
    assert.ok(result.includes("[REDACTED_STRIPE_KEY]"));
  });

  test("redacts PostgreSQL connection URL", () => {
    const result = redactSensitiveText(
      "DATABASE_URL=postgres://user:password123@localhost:5432/db"
    );
    assert.ok(result.includes("[REDACTED_CREDENTIALS]"));
    assert.ok(result.includes("[REDACTED_HOST]"));
  });

  test("redacts MySQL connection URL", () => {
    const result = redactSensitiveText(
      "mysql://admin:secret@db.internal:3306/app"
    );
    assert.ok(result.includes("[REDACTED_CREDENTIALS]"));
    assert.ok(result.includes("[REDACTED_HOST]"));
  });

  test("redacts MongoDB connection URL", () => {
    const result = redactSensitiveText(
      "mongodb+srv://root:hunter2@cluster0.example.com/db"
    );
    assert.ok(result.includes("[REDACTED_CREDENTIALS]"));
    assert.ok(result.includes("[REDACTED_HOST]"));
  });

  test("redacts Bearer token", () => {
    const result = redactSensitiveText(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOnRydWV9.abcdefghijklmnopqrstu"
    );
    assert.ok(result.includes("[REDACTED_TOKEN]"));
  });

  test("redacts JWT", () => {
    const result = redactSensitiveText(
      "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    );
    assert.ok(result.includes("[REDACTED_JWT]"));
  });

  test("redacts PEM private key block", () => {
    const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS0Z3VS0Z3VS0Z3VS0Z3V
S0Z3VS0Z3VS0Z3VS0Z3VS0Z3VS0Z3VS0Z3VS0Z3V
-----END RSA PRIVATE KEY-----`;
    const result = redactSensitiveText(input);
    assert.ok(result.includes("[REDACTED_PRIVATE_KEY]"));
    assert.ok(!result.includes("BEGIN RSA PRIVATE KEY"));
  });

  test("does not redact benign text", () => {
    const input = "This is a normal comment about AWS and GitHub integration.";
    const result = redactSensitiveText(input);
    assert.strictEqual(result, input);
  });

  test("handles empty string", () => {
    const result = redactSensitiveText("");
    assert.strictEqual(result, "");
  });

  test("redacts multiple patterns in same text", () => {
    const input =
      "AKIAIOSFODNN7EXAMPLE and token: ghp_example1234567890abcdefgh";
    const result = redactSensitiveText(input);
    assert.ok(result.includes("[REDACTED_AWS_ACCESS_KEY]"));
    assert.ok(result.includes("[REDACTED_GITHUB_TOKEN]"));
  });
});

suite("getTenureFilePolicyForPath (pure path decisions)", () => {
  test("security deny: .env file", () => {
    const result = getTenureFilePolicyForPath(".env");
    assert.strictEqual(result.decision, "suppress_all");
    assert.strictEqual(result.category, "security");
    assert.strictEqual(result.suppressContent, true);
    assert.strictEqual(result.suppressMetadata, true);
    assert.strictEqual(result.ignored, true);
  });

  test("security deny: nested .env.production", () => {
    const result = getTenureFilePolicyForPath("apps/api/.env.production");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("security deny: .ssh/id_rsa", () => {
    const result = getTenureFilePolicyForPath(".ssh/id_rsa");
    assert.strictEqual(result.decision, "suppress_all");
    assert.strictEqual(result.category, "security");
  });

  test("security deny: .aws/credentials", () => {
    const result = getTenureFilePolicyForPath(".aws/credentials");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("security deny: terraform.tfstate", () => {
    const result = getTenureFilePolicyForPath("infra/terraform.tfstate");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("security deny: kubeconfig", () => {
    const result = getTenureFilePolicyForPath("kubeconfig");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("security deny: private.key", () => {
    const result = getTenureFilePolicyForPath("certs/private.key");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("security deny: .npmrc", () => {
    const result = getTenureFilePolicyForPath(".npmrc");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("security deny: .netrc", () => {
    const result = getTenureFilePolicyForPath(".netrc");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("security deny: service-account.json", () => {
    const result = getTenureFilePolicyForPath("gcp/service-account.json");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("security deny: .pypirc anywhere", () => {
    const result = getTenureFilePolicyForPath("home/.pypirc");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("security deny: docker-compose.override.yml", () => {
    const result = getTenureFilePolicyForPath("docker-compose.override.yml");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("noise deny: node_modules deep path", () => {
    const result = getTenureFilePolicyForPath("node_modules/react/index.js");
    assert.strictEqual(result.decision, "suppress_content");
    assert.strictEqual(result.category, "noise");
    assert.strictEqual(result.suppressContent, true);
    assert.strictEqual(result.suppressMetadata, false);
    assert.strictEqual(result.ignored, true);
  });

  test("noise deny: dist bundle", () => {
    const result = getTenureFilePolicyForPath("dist/bundle.js");
    assert.strictEqual(result.decision, "suppress_content");
  });

  test("noise deny: yarn.lock", () => {
    const result = getTenureFilePolicyForPath("yarn.lock");
    assert.strictEqual(result.decision, "suppress_content");
  });

  test("noise deny: package-lock.json", () => {
    const result = getTenureFilePolicyForPath("package-lock.json");
    assert.strictEqual(result.decision, "suppress_content");
  });

  test("noise deny: .git/config", () => {
    const result = getTenureFilePolicyForPath(".git/config");
    assert.strictEqual(result.decision, "suppress_content");
  });

  test("noise deny: build output", () => {
    const result = getTenureFilePolicyForPath("build/static/js/main.js");
    assert.strictEqual(result.decision, "suppress_content");
  });

  test("noise deny: coverage report", () => {
    const result = getTenureFilePolicyForPath(
      "coverage/lcov-report/index.html"
    );
    assert.strictEqual(result.decision, "suppress_content");
  });

  test("noise deny: __pycache__", () => {
    const result = getTenureFilePolicyForPath(
      "src/__pycache__/module.cpython-39.pyc"
    );
    assert.strictEqual(result.decision, "suppress_content");
  });

  test("noise deny: .vscode/settings.json", () => {
    const result = getTenureFilePolicyForPath(".vscode/settings.json");
    assert.strictEqual(result.decision, "suppress_content");
  });

  test("allow: normal source file", () => {
    const result = getTenureFilePolicyForPath("src/config.ts");
    assert.strictEqual(result.decision, "allow");
    assert.strictEqual(result.category, "allowed");
    assert.strictEqual(result.suppressContent, false);
    assert.strictEqual(result.suppressMetadata, false);
    assert.strictEqual(result.ignored, false);
  });

  test("allow: README", () => {
    const result = getTenureFilePolicyForPath("README.md");
    assert.strictEqual(result.decision, "allow");
  });

  test("allow: docker-compose.yml (non-override)", () => {
    const result = getTenureFilePolicyForPath("docker-compose.yml");
    assert.strictEqual(result.decision, "allow");
  });

  test("allow: package.json (not lock)", () => {
    const result = getTenureFilePolicyForPath("package.json");
    assert.strictEqual(result.decision, "allow");
  });

  test("empty path returns allow", () => {
    const result = getTenureFilePolicyForPath("");
    assert.strictEqual(result.decision, "allow");
  });

  test("segment guard: node_modules in middle catches regardless of pattern", () => {
    const result = getTenureFilePolicyForPath(
      "weird/node_modules/pkg/index.js"
    );
    assert.strictEqual(result.decision, "suppress_content");
  });

  test("segment guard: .ssh in path triggers security", () => {
    const result = getTenureFilePolicyForPath("home/user/.ssh/authorized_keys");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("segment guard: .aws triggers security", () => {
    const result = getTenureFilePolicyForPath("home/user/.aws/credentials");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("segment guard: .kube triggers security", () => {
    const result = getTenureFilePolicyForPath("home/user/.kube/config");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("basename security: .env even without path segments", () => {
    const result = getTenureFilePolicyForPath(".env");
    assert.strictEqual(result.decision, "suppress_all");
  });

  test("basename security: id_ed25519 matches", () => {
    const result = getTenureFilePolicyForPath("id_ed25519");
    assert.strictEqual(result.decision, "suppress_all");
  });
});
