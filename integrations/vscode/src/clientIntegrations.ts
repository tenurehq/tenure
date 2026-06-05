import * as vscode from "vscode";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export interface DetectedClients {
  cline: boolean;
  rooCode: boolean;
  continue: boolean;
  copilot: boolean;
  cursorNative: boolean;
  windsurfNative: boolean;
  vsCodium: boolean;
}

export interface ClientStatus {
  detected: DetectedClients;
  continueConfigured: boolean;
}

export function detectInstalledClients(): DetectedClients {
  const appName = vscode.env.appName.toLowerCase();
  return {
    cline: !!vscode.extensions.getExtension("saoudrizwan.claude-dev"),
    rooCode: !!vscode.extensions.getExtension("RooCodeInc.roo-cline"),
    continue: !!vscode.extensions.getExtension("continue.continue"),
    copilot: !!vscode.extensions.getExtension("GitHub.copilot-chat"),
    cursorNative: appName.includes("cursor"),
    windsurfNative: appName.includes("windsurf"),
    vsCodium: appName.includes("vscodium"),
  };
}

function getContinueConfigPath(): string {
  const isWin = platform() === "win32";
  return isWin
    ? join(process.env.USERPROFILE ?? homedir(), ".continue", "config.json")
    : join(homedir(), ".continue", "config.json");
}

export function isContinueConfigured(token: string): boolean {
  const configPath = getContinueConfigPath();
  if (!existsSync(configPath)) return false;
  try {
    const raw = readFileSync(configPath, "utf8");

    return raw.includes("localhost:5757");
  } catch {
    return false;
  }
}

export type ContinueInjectResult =
  | "injected"
  | "already_configured"
  | "no_config_file"
  | "parse_error"
  | "ts_config";

export async function injectContinueConfig(
  token: string,
  baseUrl: string,
): Promise<ContinueInjectResult> {
  const isWin = platform() === "win32";
  const continueDir = isWin
    ? join(process.env.USERPROFILE ?? homedir(), ".continue")
    : join(homedir(), ".continue");

  if (existsSync(join(continueDir, "config.ts"))) {
    return "ts_config";
  }

  const configPath = getContinueConfigPath();

  if (!existsSync(configPath)) {
    return "no_config_file";
  }

  let config: Record<string, unknown>;
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "parse_error";
  }

  if (raw.includes("localhost:5757")) {
    return "already_configured";
  }

  const tenureModel = {
    title: "Tenure",
    provider: "openai",
    model: "auto",
    apiKey: token,
    apiBase: `${baseUrl}/v1`,
  };

  if (!Array.isArray(config.models)) {
    config.models = [];
  }
  (config.models as unknown[]).push(tenureModel);

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    return "injected";
  } catch {
    return "parse_error";
  }
}

const CONTINUE_OFFERED_KEY = "tenure.integrationOffered.continue";
const CLINE_NOTIFIED_KEY = "tenure.integrationOffered.cline";
const ROO_NOTIFIED_KEY = "tenure.integrationOffered.rooCode";

export async function offerClientIntegrations(
  context: vscode.ExtensionContext,
  clients: DetectedClients,
  token: string,
  baseUrl: string,
): Promise<void> {
  if (
    clients.continue &&
    !context.globalState.get<boolean>(CONTINUE_OFFERED_KEY)
  ) {
    await context.globalState.update(CONTINUE_OFFERED_KEY, true);
    await offerContinueIntegration(token, baseUrl);
  }

  if (clients.cline && !context.globalState.get<boolean>(CLINE_NOTIFIED_KEY)) {
    await context.globalState.update(CLINE_NOTIFIED_KEY, true);
    const action = await vscode.window.showInformationMessage(
      "Cline detected. Point it at Tenure to add memory to every session.",
      "Copy Base URL",
      "Copy Token",
      "View Docs",
    );
    await handleCopyAction(action, token, baseUrl);
  }

  if (clients.rooCode && !context.globalState.get<boolean>(ROO_NOTIFIED_KEY)) {
    await context.globalState.update(ROO_NOTIFIED_KEY, true);
    const action = await vscode.window.showInformationMessage(
      "Roo Code detected. Point it at Tenure to add memory to every session.",
      "Copy Base URL",
      "Copy Token",
      "View Docs",
    );
    await handleCopyAction(action, token, baseUrl);
  }
}

async function offerContinueIntegration(
  token: string,
  baseUrl: string,
): Promise<void> {
  const configPath = getContinueConfigPath();
  const configExists = existsSync(configPath);

  if (!configExists) {
    const action = await vscode.window.showInformationMessage(
      "Continue detected. Set Tenure as your base URL to add memory to every session.",
      "Copy Base URL",
      "Copy Token",
      "View Docs",
    );
    await handleCopyAction(action, token, baseUrl);
    return;
  }

  if (isContinueConfigured(token)) {
    return;
  }

  const action = await vscode.window.showInformationMessage(
    "Continue detected. Add Tenure as a model provider automatically?",
    "Yes, set it up",
    "I'll do it manually",
  );

  if (action !== "Yes, set it up") return;

  const result = await injectContinueConfig(token, baseUrl);

  switch (result) {
    case "injected":
      vscode.window.showInformationMessage(
        "Done. Tenure is now available in Continue's model picker.",
      );
      break;
    case "already_configured":
      vscode.window.showInformationMessage(
        "Tenure is already configured in Continue.",
      );
      break;
    case "ts_config":
      await showManualContinueCard(token, baseUrl, "ts");
      break;
    case "parse_error":
      await showManualContinueCard(token, baseUrl, "parse");
      break;
    case "no_config_file":
      await showManualContinueCard(token, baseUrl, "missing");
      break;
  }
}

async function showManualContinueCard(
  token: string,
  baseUrl: string,
  reason: "ts" | "parse" | "missing",
): Promise<void> {
  const messages: Record<string, string> = {
    ts: "Continue uses a TypeScript config — add Tenure manually.",
    parse: "Continue config could not be parsed — add Tenure manually.",
    missing:
      "Continue config not found — add Tenure manually once you've opened Continue.",
  };

  const action = await vscode.window.showWarningMessage(
    messages[reason],
    "Copy Base URL",
    "View Docs",
  );
  await handleCopyAction(action, token, baseUrl);
}

async function handleCopyAction(
  action: string | undefined,
  token: string,
  baseUrl: string,
): Promise<void> {
  if (action === "Copy Base URL") {
    await vscode.env.clipboard.writeText(`${baseUrl}/v1`);
    vscode.window.showInformationMessage("Base URL copied to clipboard.");
  } else if (action === "Copy Token") {
    await vscode.env.clipboard.writeText(token);
    vscode.window.showInformationMessage("Token copied to clipboard.");
  } else if (action === "View Docs") {
    vscode.env.openExternal(
      vscode.Uri.parse(
        "https://docs.continue.dev/reference/model-providers/openai",
      ),
    );
  }
}
