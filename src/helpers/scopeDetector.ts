import type { FastifyBaseLogger } from "fastify";
import type { RuntimeConfig } from "../config/runtime.js";
import type { Db } from "mongodb";

export interface InterceptResult {
  message: string;
  newScope: string[];
}

export interface ExtractInterceptResult {
  message: string;
}

export type CommandAction = "off" | "on" | "global-off" | "global-on";

export interface TokenScopeStore {
  getActiveScope(userId: string, tokenId: string): Promise<string[] | null>;
  setActiveScope(
    userId: string,
    tokenId: string,
    scope: string[]
  ): Promise<void>;
}

const SCOPE_PATTERN = /^(?:project:[a-z0-9_-]+|user:universal|domain:[a-z0-9_/-]+)$/;

const VALID_ACTIONS: CommandAction[] = ["on", "off", "global-on", "global-off"];

export function validateCommandInput(
  type: "scope",
  parts: string[]
): { valid: true; parts: string[] } | { valid: false; message: string };

export function validateCommandInput(
  type: "extract" | "inject",
  action: CommandAction
): { valid: true } | { valid: false; message: string };

export function validateCommandInput(
  type: "scope" | "extract" | "inject",
  input: string[] | CommandAction
): { valid: true; parts?: string[] } | { valid: false; message: string } {
  if (type === "scope") {
    const parts = input as string[];

    if (parts.length === 0) {
      return {
        valid: false,
        message: "No scope provided. Usage: `!scope project:my-project`"
      };
    }

    const invalid = parts.filter((scope) => !SCOPE_PATTERN.test(scope));
    if (invalid.length > 0) {
      return {
        valid: false,
        message: `Invalid scope format: ${invalid
          .map((scope) => `\`${scope}\``)
          .join(", ")}.`
      };
    }

    return { valid: true, parts: [...new Set(parts)] };
  }

  const action = input as CommandAction;
  if (!VALID_ACTIONS.includes(action)) {
    return {
      valid: false,
      message:
        `Unknown ${type} command. Valid commands: ` +
        `\`!${type} global on\`, \`!${type} global off\`.`
    };
  }

  return { valid: true };
}

export function matchScopeCommand(content: string): string | null {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  const prefixes = ["!scope", "set scope"] as const;

  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    const after = trimmed.slice(prefix.length);
    if (after.length === 0 || /^[\s,]/.test(after)) {
      return after.trim();
    }
  }

  return null;
}

export async function tryInterceptScopeCommand(
  content: string,
  userId: string,
  tokenId: string,
  tokenProjectScopes: string[] | null | undefined,
  tokenScopes: TokenScopeStore,
  logger: FastifyBaseLogger
): Promise<InterceptResult | null> {
  const raw = matchScopeCommand(content);
  if (raw === null) return null;

  const parts = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean);

  const validation = validateCommandInput("scope", parts);
  if (!validation.valid) {
    return { message: validation.message, newScope: [] };
  }

  const newScope = validation.parts;
  if (!allowsProjectScopes(tokenProjectScopes, newScope)) {
    return {
      message: "Token is not authorized for one or more requested project scopes.",
      newScope: []
    };
  }

  try {
    await tokenScopes.setActiveScope(userId, tokenId, newScope);
  } catch (err) {
    logger.warn({ err, tokenId }, "scope command: token update failed");
    return {
      message: "Failed to update scope. Try again.",
      newScope: []
    };
  }

  return {
    message: `Scope set to: ${newScope.map((scope) => `\`${scope}\``).join(", ")}`,
    newScope
  };
}

export async function fetchExistingUserScopes(
  userId: string,
  db: Db
): Promise<string[]> {
  try {
    const scopes = await db
      .collection("beliefs")
      .distinct("scope", { user_id: userId });

    return (scopes as string[]).filter(
      (scope) => scope !== "user:universal" && scope !== "universal"
    );
  } catch {
    return [];
  }
}

export function matchExtractCommand(content: string): CommandAction | null {
  return matchToggleCommand(content, "extract");
}

export async function tryInterceptExtractCommand(
  content: string,
  runtimeStore: RuntimeConfigStore,
  logger: FastifyBaseLogger
): Promise<ExtractInterceptResult | null> {
  const action = matchExtractCommand(content);
  if (action === null) return null;
  return applyGlobalToggle("extract", action, runtimeStore, logger);
}

export function matchInjectCommand(content: string): CommandAction | null {
  return matchToggleCommand(content, "inject");
}

export async function tryInterceptInjectCommand(
  content: string,
  runtimeStore: RuntimeConfigStore,
  logger: FastifyBaseLogger
): Promise<ExtractInterceptResult | null> {
  const action = matchInjectCommand(content);
  if (action === null) return null;
  return applyGlobalToggle("inject", action, runtimeStore, logger);
}

interface RuntimeConfigStore {
  set<K extends keyof RuntimeConfig>(
    key: K,
    value: RuntimeConfig[K]
  ): Promise<void>;
}

function matchToggleCommand(
  content: string,
  type: "extract" | "inject"
): CommandAction | null {
  const value = content.trim().toLowerCase();
  const commands: Record<string, CommandAction> = {
    [`!${type} off`]: "off",
    [`!${type} on`]: "on",
    [`!${type} global off`]: "global-off",
    [`!${type} global on`]: "global-on"
  };
  return commands[value] ?? null;
}

async function applyGlobalToggle(
  type: "extract" | "inject",
  action: CommandAction,
  runtimeStore: RuntimeConfigStore,
  logger: FastifyBaseLogger
): Promise<ExtractInterceptResult> {
  if (action === "off" || action === "on") {
    return {
      message: `Per-conversation ${type} controls are unavailable. Use \`!${type} global ${action}\`.`
    };
  }

  const enabled = action === "global-on";
  const key = type === "extract" ? "extraction_enabled" : "injection_enabled";

  try {
    await runtimeStore.set(key, enabled);
  } catch (err) {
    logger.warn({ err }, `${type} command: global update failed`);
    return { message: `Failed to update ${type} globally. Try again.` };
  }

  return {
    message: `${type === "extract" ? "Extraction" : "Belief injection"} ${
      enabled ? "enabled" : "disabled"
    } globally.`
  };
}

function allowsProjectScopes(
  allowed: string[] | null | undefined,
  requested: string[]
): boolean {
  if (allowed == null) return true;
  return requested.every(
    (scope) => !scope.startsWith("project:") || allowed.includes(scope)
  );
}
