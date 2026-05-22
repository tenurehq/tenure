import * as vscode from "vscode";

export type HostApp = "vscode" | "cursor" | "windsurf" | "unknown";

export function detectHostApp(): HostApp {
  return resolveHostApp(vscode.env.appName);
}

export function resolveHostApp(appName: string): HostApp {
  const name = appName.toLowerCase();
  if (name.includes("cursor")) return "cursor";
  if (name.includes("windsurf")) return "windsurf";
  if (name.includes("visual studio code") || name === "code") return "vscode";
  return "unknown";
}
