import * as vscode from "vscode";
import * as fs from "node:fs";
import path from "node:path";

/**
 * Security deny patterns suppress both content and metadata.
 * These are intentionally hard defaults: user/project config can add to this
 * list, but should not casually remove these protections.
 */
const SECURITY_DENY_PATTERNS = [
  // Environment and generic secret files
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/.secrets",
  "**/.secrets.*",
  "**/credentials",
  "**/credentials.*",
  "**/secrets/**",
  "**/secret/**",

  // Private keys, certificates, keystores
  "**/private.key",
  "**/*.key",
  "**/*.p8",
  "**/*.p12",
  "**/*.pfx",
  "**/*.pem",
  "**/*.crt",
  "**/*.cer",
  "**/*.der",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
  "**/*_rsa",
  "**/*_dsa",
  "**/*_ecdsa",
  "**/*_ed25519",

  // Cloud, package, registry, deploy, and local auth config
  "**/*-key.json",
  "**/service-account.json",
  "**/serviceAccountKey.json",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.docker/config.json",
  "**/.git-credentials",
  "**/.gitconfig",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.aws/**",
  "**/.azure/**",
  "**/.config/gcloud/**",
  "**/.kube/**",
  "**/kubeconfig",
  "**/.sentryclirc",
  "**/.sentryclirc.*",
  "**/.vercel/**",
  "**/.netlify/**",
  "**/.railway/**",
  "**/.supabase/**",
  "**/google-services.json",
  "**/GoogleService-Info.plist",

  // Infrastructure state and variable files
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.tfvars",
  "**/*.tfvars.json",
  "**/.terraform.lock.hcl",

  // Local docker overrides frequently contain credentials
  "**/docker-compose.override.yml",
  "**/docker-compose.*.yml"
];

/**
 * Noise deny patterns suppress content but allow coarse metadata by default.
 * These reduce payload size and prevent generated/dependency artifacts from
 * being treated as authored project context.
 */
const NOISE_DENY_PATTERNS = [
  // Dependency and generated folders
  "**/node_modules/**",
  "**/vendor/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/out/**",
  "**/target/**",
  "**/coverage/**",
  "**/.turbo/**",
  "**/.parcel-cache/**",
  "**/.cache/**",

  // Python and general language caches
  "**/__pycache__/**",
  "**/*.pyc",
  "**/.venv/**",
  "**/venv/**",
  "**/env/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/.ruff_cache/**",

  // JVM, mobile, and platform caches
  "**/.gradle/**",
  "**/.m2/**",
  "**/Pods/**",
  "**/DerivedData/**",

  // Terraform plugin/cache directory
  "**/.terraform/**",

  // Logs and local data artifacts
  "**/*.log",
  "**/logs/**",
  "**/*.sqlite",
  "**/*.sqlite3",
  "**/*.db",
  "**/*.dump",
  "**/*.dump.sql",
  "**/dump/**/*.sql",
  "**/dumps/**/*.sql",
  "**/backup/**/*.sql",
  "**/backups/**/*.sql",
  "**/*.bak",
  "**/*.backup",

  // Lock files and local IDE/system files
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/Gemfile.lock",
  "**/Cargo.lock",
  "**/.vscode/settings.json",
  "**/.idea/**",
  "**/.DS_Store",
  "**/Thumbs.db"
];

const SECURITY_BASENAME_DENY_PATTERNS = [
  ".env",
  ".env.*",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".sentryclirc",
  "credentials",
  "credentials.*",
  "private.key",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "service-account.json",
  "serviceAccountKey.json",
  "kubeconfig"
];

const SUPPORTED_URI_SCHEMES = new Set(["file", "vscode-remote"]);

type PolicyDecision = "allow" | "suppress_content" | "suppress_all";
type PolicyCategory =
  | "allowed"
  | "security"
  | "noise"
  | "unsupported_scheme"
  | "outside_workspace"
  | "no_workspace";

export interface TenureFilePolicy {
  decision: PolicyDecision;
  category: PolicyCategory;
  reason?: string;
  suppressContent: boolean;
  suppressMetadata: boolean;

  /**
   * Backwards-compatible field for existing callers. Prefer decision/category
   * in new code because noise files may suppress content while still allowing
   * metadata.
   */
  ignored: boolean;
}

export type IgnoreDecision = TenureFilePolicy;

interface TenureFileConfig {
  projectId?: string;
  ignore?: unknown;
  noiseIgnores?: unknown;
}

interface WorkspacePatternSet {
  security: string[];
  noise: string[];
}

interface CompiledPatternSet {
  key: string;
  regexes: RegExp[];
}

const workspacePatternCache = new Map<string, WorkspacePatternSet>();
const compiledPatternCache = new Map<string, CompiledPatternSet>();

function allow(reason?: string): TenureFilePolicy {
  return {
    decision: "allow",
    category: "allowed",
    reason,
    suppressContent: false,
    suppressMetadata: false,
    ignored: false
  };
}

function suppressAll(
  category: Exclude<PolicyCategory, "allowed" | "noise">,
  reason: string
): TenureFilePolicy {
  return {
    decision: "suppress_all",
    category,
    reason,
    suppressContent: true,
    suppressMetadata: true,
    ignored: true
  };
}

function suppressContent(reason: string): TenureFilePolicy {
  return {
    decision: "suppress_content",
    category: "noise",
    reason,
    suppressContent: true,
    suppressMetadata: false,
    ignored: true
  };
}

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function normalizePattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  return normalizePath(trimmed);
}

function uniquePatterns(patterns: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    const normalized = normalizePattern(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
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

function getCompiledPatterns(cacheKey: string, patterns: string[]): RegExp[] {
  const patternKey = patterns.join("\n");
  const cached = compiledPatternCache.get(cacheKey);
  if (cached?.key === patternKey) return cached.regexes;

  const regexes = patterns.map(globToRegex);
  compiledPatternCache.set(cacheKey, { key: patternKey, regexes });
  return regexes;
}

function matchesCompiled(value: string, regexes: RegExp[]): boolean {
  for (const re of regexes) {
    if (re.test(value)) return true;
  }
  return false;
}

function getConfigPatterns(name: string): string[] {
  const value = vscode.workspace.getConfiguration("tenure").get<unknown>(name);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function getEffectiveSecurityPatterns(): string[] {
  return uniquePatterns([
    ...SECURITY_DENY_PATTERNS,
    ...SECURITY_BASENAME_DENY_PATTERNS,
    ...getConfigPatterns("securityIgnorePatterns"),
    ...getConfigPatterns("ignorePatterns")
  ]);
}

function getEffectiveNoisePatterns(): string[] {
  return uniquePatterns([
    ...NOISE_DENY_PATTERNS,
    ...getConfigPatterns("noiseIgnorePatterns")
  ]);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseTenureConfig(text: string): WorkspacePatternSet {
  const trimmed = text.trim();
  if (!trimmed) return { security: [], noise: [] };

  try {
    const parsed = JSON.parse(trimmed) as TenureFileConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { security: [], noise: [] };
    }

    return {
      security: uniquePatterns(asStringArray(parsed.ignore)),
      noise: uniquePatterns(asStringArray(parsed.noiseIgnores))
    };
  } catch {
    return { security: [], noise: [] };
  }
}

function readTextFileSync(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function loadWorkspacePatternsSync(
  workspaceRootUri: vscode.Uri
): WorkspacePatternSet {
  const rootPath = workspaceRootUri.fsPath;
  const cached = workspacePatternCache.get(rootPath);
  if (cached) return cached;

  const tenureJsonText = readTextFileSync(path.join(rootPath, ".tenure.json"));
  const tenurePatterns = tenureJsonText
    ? parseTenureConfig(tenureJsonText)
    : { security: [], noise: [] };

  const loaded = {
    security: uniquePatterns([...tenurePatterns.security]),
    noise: uniquePatterns([...tenurePatterns.noise])
  };

  workspacePatternCache.set(rootPath, loaded);
  return loaded;
}

export function invalidateTenureFilePolicyCache(
  workspaceRootUri?: vscode.Uri
): void {
  if (workspaceRootUri) {
    workspacePatternCache.delete(workspaceRootUri.fsPath);
  } else {
    workspacePatternCache.clear();
  }
  compiledPatternCache.clear();
}

function resolveWorkspaceFolder(
  uri: vscode.Uri
): vscode.WorkspaceFolder | null {
  return vscode.workspace.getWorkspaceFolder(uri) ?? null;
}

function resolveWorkspaceRoot(
  uri?: vscode.Uri,
  workspaceRootUri?: vscode.Uri
): vscode.Uri | null {
  if (workspaceRootUri) return workspaceRootUri;
  if (uri) {
    const folder = resolveWorkspaceFolder(uri);
    if (folder) return folder.uri;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
}

function relativePathForUri(
  uri: vscode.Uri,
  workspaceRootUri?: vscode.Uri
): string | null {
  const root = resolveWorkspaceRoot(uri, workspaceRootUri);
  if (!root) return null;

  if (uri.fsPath && root.fsPath) {
    const relative = path.relative(root.fsPath, uri.fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return normalizePath(relative);
  }

  const relative = vscode.workspace.asRelativePath(uri, false);
  if (!relative || path.isAbsolute(relative)) return null;
  return normalizePath(relative);
}

function buildPatternSets(workspaceRootUri?: vscode.Uri): {
  security: RegExp[];
  securityBasename: RegExp[];
  noise: RegExp[];
} {
  const workspacePatterns = workspaceRootUri
    ? loadWorkspacePatternsSync(workspaceRootUri)
    : { security: [], noise: [] };

  const securityPatterns = uniquePatterns([
    ...getEffectiveSecurityPatterns(),
    ...workspacePatterns.security
  ]);
  const noisePatterns = uniquePatterns([
    ...getEffectiveNoisePatterns(),
    ...workspacePatterns.noise
  ]);

  return {
    security: getCompiledPatterns("security", securityPatterns),
    securityBasename: getCompiledPatterns(
      "security:basename",
      uniquePatterns(SECURITY_BASENAME_DENY_PATTERNS)
    ),
    noise: getCompiledPatterns("noise", noisePatterns)
  };
}

function evaluateRelativePath(
  relativePath: string,
  workspaceRootUri?: vscode.Uri
): TenureFilePolicy {
  const normalized = normalizePath(relativePath);
  if (!normalized) return allow("No path provided");

  const basename = normalizePath(path.basename(normalized));
  const segments = normalized.split("/").filter(Boolean);
  const patternSets = buildPatternSets(workspaceRootUri);

  if (matchesCompiled(normalized, patternSets.security)) {
    return suppressAll("security", "Matched security deny pattern");
  }

  if (matchesCompiled(basename, patternSets.securityBasename)) {
    return suppressAll("security", "Matched security basename deny pattern");
  }

  if (matchesCompiled(normalized, patternSets.noise)) {
    return suppressContent("Matched noise deny pattern");
  }

  // Segment guards are cheap defense-in-depth in case a glob is accidentally
  // removed or changed later.
  if (segments.includes("node_modules") || segments.includes(".git")) {
    return suppressContent("Matched generated/dependency path segment");
  }

  if (
    segments.includes(".ssh") ||
    segments.includes(".aws") ||
    segments.includes(".azure") ||
    segments.includes(".kube") ||
    segments.includes(".gnupg")
  ) {
    return suppressAll("security", "Matched sensitive config path segment");
  }

  return allow();
}

export function getTenureFilePolicy(
  uri: vscode.Uri,
  workspaceRootUri?: vscode.Uri
): TenureFilePolicy {
  if (!SUPPORTED_URI_SCHEMES.has(uri.scheme)) {
    return suppressAll(
      "unsupported_scheme",
      `Unsupported URI scheme: ${uri.scheme}`
    );
  }

  const root = resolveWorkspaceRoot(uri, workspaceRootUri);
  if (!root) {
    return suppressAll("no_workspace", "No workspace folder");
  }

  const relativePath = relativePathForUri(uri, root);
  if (!relativePath) {
    return suppressAll("outside_workspace", "Outside workspace");
  }

  return evaluateRelativePath(relativePath, root);
}

export function getTenureFilePolicyForPath(
  relativePath: string,
  workspaceRootUri?: vscode.Uri
): TenureFilePolicy {
  return evaluateRelativePath(relativePath, workspaceRootUri);
}

const SECRET_REDACTIONS: Array<{ re: RegExp; replacement: string }> = [
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

export function redactSensitiveText(text: string): string {
  let redacted = text;
  for (const { re, replacement } of SECRET_REDACTIONS) {
    redacted = redacted.replace(re, replacement);
  }
  return redacted;
}
