import * as vscode from "vscode";

export interface TenureFileConfig {
  projectId: string;
  ignore?: string[];
  noiseIgnores?: string[];
}

export async function readTenureConfig(
  workspaceRootUri: vscode.Uri
): Promise<TenureFileConfig | null> {
  const jsonConfig = await readTenureJsonConfig(workspaceRootUri);
  if (jsonConfig) return jsonConfig;

  const projectId = await readLegacyTenureFile(workspaceRootUri);
  if (projectId) return { projectId };

  return null;
}

async function readTenureJsonConfig(
  workspaceRootUri: vscode.Uri
): Promise<TenureFileConfig | null> {
  const fileUri = vscode.Uri.joinPath(workspaceRootUri, ".tenure.json");
  try {
    const rawContent = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder().decode(rawContent).trim();

    if (!text) return null;

    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const projectId =
      typeof parsed.projectId === "string" ? parsed.projectId.trim() : null;
    if (!projectId) return null;

    return {
      projectId,
      ignore: Array.isArray(parsed.ignore)
        ? parsed.ignore.filter((i): i is string => typeof i === "string")
        : undefined,
      noiseIgnores: Array.isArray(parsed.noiseIgnores)
        ? parsed.noiseIgnores.filter((i): i is string => typeof i === "string")
        : undefined
    };
  } catch {
    return null;
  }
}

async function readLegacyTenureFile(
  workspaceRootUri: vscode.Uri
): Promise<string | null> {
  const fileUri = vscode.Uri.joinPath(workspaceRootUri, ".tenure");
  try {
    const rawContent = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder().decode(rawContent).trim();
    return text || null;
  } catch {
    return null;
  }
}

export function generateDefaultTenureConfig(projectName: string): string {
  const config: TenureFileConfig = {
    projectId: projectName,
    ignore: [],
    noiseIgnores: []
  };
  return JSON.stringify(config, null, 2) + "\n";
}
