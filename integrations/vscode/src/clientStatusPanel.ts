import * as vscode from "vscode";
import type { DetectedClients } from "./clientIntegrations.js";
import { isContinueConfigured } from "./clientIntegrations.js";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface ClientRow {
  id: string;
  label: string;
  detected: boolean;

  connectionType: "lm_provider" | "config_file" | "manual";

  connected: boolean;

  action: "auto_config" | "copy_url" | "copy_token" | "docs" | null;
}

export function buildClientRows(
  clients: DetectedClients,
  token: string,
  baseUrl: string,
): ClientRow[] {
  const rows: ClientRow[] = [];

  if (clients.cursorNative) {
    rows.push({
      id: "cursor",
      label: "Cursor (this editor)",
      detected: true,
      connectionType: "manual",

      connected: false,
      action: "copy_url",
    });
  }

  if (clients.windsurfNative) {
    rows.push({
      id: "windsurf",
      label: "Windsurf (this editor)",
      detected: true,
      connectionType: "manual",
      connected: false,
      action: "copy_url",
    });
  }

  if (clients.copilot) {
    rows.push({
      id: "copilot",
      label: "Copilot Chat",
      detected: true,
      connectionType: "lm_provider",
      connected: true,
      action: null,
    });
  }

  if (clients.continue) {
    const isWin = platform() === "win32";
    const configPath = isWin
      ? join(process.env.USERPROFILE ?? homedir(), ".continue", "config.json")
      : join(homedir(), ".continue", "config.json");
    const configExists = existsSync(configPath);
    const configured = configExists && isContinueConfigured(token);

    rows.push({
      id: "continue",
      label: "Continue",
      detected: true,
      connectionType: "config_file",
      connected: configured,
      action: configured ? null : configExists ? "auto_config" : "docs",
    });
  }

  if (clients.cline) {
    rows.push({
      id: "cline",
      label: "Cline",
      detected: true,
      connectionType: "manual",
      connected: false,
      action: "copy_url",
    });
  }

  if (clients.rooCode) {
    rows.push({
      id: "rooCode",
      label: "Roo Code",
      detected: true,
      connectionType: "manual",
      connected: false,
      action: "copy_url",
    });
  }

  return rows;
}
