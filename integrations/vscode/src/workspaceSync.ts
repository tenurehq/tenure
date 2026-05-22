import * as vscode from "vscode";
import { resolveGitRemote } from "./gitResolver.js";
import type { TokenStore } from "./tokenStore.js";
import { readTenureConfig } from "./tenureConfig.js";
import { TenureBeliefsViewProvider } from "./beliefsViewProvider.js";
import type { TenureLmProvider } from "./lmProvider.js";
import path, { basename } from "node:path";
import { createHash } from "node:crypto";

export interface WorkspaceState {
  workspace_root: string;
  project_name: string;
  git_remote: string | null;
  active_file: string | null;
  active_language: string | null;
}

export class WorkspaceSync {
  private lastSyncedState: string | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  private cachedProjectName: string | null = null;
  private cachedGitRemote: string | null = null;
  private workspaceResolved = false;

  private onboardingPromptShown = false;

  constructor(
    private readonly tokenStore: TokenStore,
    private readonly context: vscode.ExtensionContext,
    private readonly statusBar?: vscode.StatusBarItem,
    private readonly beliefsProvider?: TenureBeliefsViewProvider,
    private readonly lmProvider?: TenureLmProvider,
  ) {
    this.lastSyncedState = null;

    this.beliefsProvider?.setOnConnectedCallback(() => {
      this.invalidateCache();
      this.scheduleSync();
    });
  }

  scheduleSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), 300);
  }

  invalidateCache(): void {
    this.lastSyncedState = null;
    this.workspaceResolved = false;
    this.cachedProjectName = null;
    this.cachedGitRemote = null;
  }

  invalidateManifestCache(): void {
    this.workspaceResolved = false;
    this.cachedProjectName = null;
  }

  getLastProjectName(): string | null {
    return this.cachedProjectName ?? null;
  }

  reconnectBeliefs(): void {
    this.beliefsProvider?.reconnect().catch(() => {});
  }

  sendActiveFileUpdate(
    activeFile: string,
    activeLanguage: string,
    fileUri: vscode.Uri,
  ): void {
    if (!this.beliefsProvider || !this.cachedProjectName) return;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    this.beliefsProvider.sendWorkspaceState({
      workspace_root: workspaceFolder.uri.fsPath,
      project_name: this.cachedProjectName,
      git_remote: this.cachedGitRemote,
      active_file: activeFile,
      active_language: activeLanguage,
    });

    if (fileUri.scheme === "file") {
      vscode.workspace.fs.stat(fileUri).then((stat) => {
        this.beliefsProvider?.sendFileMeta(activeFile, stat.size);
      });
    }
  }

  async sync(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("tenure");
    if (!cfg.get<boolean>("enabled", true)) return;

    if (!vscode.workspace.isTrusted) {
      if (this.statusBar) {
        this.statusBar.text = "$(symbol-misc) Tenure: Restricted";
        this.statusBar.tooltip =
          "Workspace not trusted. File-based scope resolution disabled.";
      }
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const token = await this.tokenStore.get();
    if (!token) {
      if (this.statusBar) {
        this.statusBar.text = "$(warning) Tenure: Token Missing";
        this.statusBar.command = "tenure.setToken";
      }
      return;
    }

    if (!this.workspaceResolved) {
      await this.resolveWorkspaceLevel(workspaceFolder.uri);
    }

    const activeEditor = vscode.window.activeTextEditor;
    const activeFileUri = activeEditor?.document.uri ?? null;
    const activeFile = activeFileUri ? toRelativeFile(activeFileUri) : null;
    const activeLanguage = activeEditor?.document.languageId ?? null;

    const state: WorkspaceState = {
      workspace_root: workspaceFolder.uri.fsPath,
      project_name: this.cachedProjectName!,
      git_remote: this.cachedGitRemote,
      active_file: activeFile,
      active_language: activeLanguage,
    };

    const stateKey = JSON.stringify(state);
    if (stateKey === this.lastSyncedState) {
      return;
    }

    const baseUrl = cfg.get<string>("baseUrl", "http://localhost:5757");

    if (this.lastSyncedState) {
      const previousState = JSON.parse(this.lastSyncedState) as WorkspaceState;
      if (previousState.project_name !== state.project_name) {
        this.migrateScope(
          previousState.project_name,
          state.project_name,
          token,
          baseUrl,
        ).catch(() => {});
      }
    }

    this.lastSyncedState = stateKey;

    if (this.statusBar) {
      this.statusBar.text = `$(symbol-misc) Tenure: ${this.cachedProjectName}`;
      this.statusBar.command = "tenure.openBeliefs";
    }

    if (this.beliefsProvider) {
      await this.beliefsProvider.ensureConnected();
      this.beliefsProvider.sendWorkspaceState(state);
    }

    await this.checkAndPromptOnboarding(baseUrl, token);
    await this.checkAndPromptTenureFile(workspaceFolder.uri);
  }

  dispose(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
  }

  private async checkAndPromptOnboarding(
    baseUrl: string,
    token: string,
  ): Promise<void> {
    if (this.onboardingPromptShown) return;

    try {
      const [providersRes, cfgRes] = await Promise.all([
        fetch(`${baseUrl}/admin/providers`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        }),
        fetch(`${baseUrl}/admin/config`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        }),
      ]);

      if (!providersRes.ok || !cfgRes.ok) return;

      const [providersData, cfg] = await Promise.all([
        providersRes.json() as Promise<{
          providers: Array<{ configured: boolean }>;
        }>,
        cfgRes.json() as Promise<{
          default_model: string | null;
          openai_configured: boolean;
          anthropic_configured: boolean;
          [key: string]: unknown;
        }>,
      ]);

      const hasProvider = providersData.providers.some((p) => p.configured);
      const hasModel = cfg.default_model != null;

      if (!hasProvider) {
        this.beliefsProvider?.showOnboardingPrompt();
        this.onboardingPromptShown = true;

        const alreadyDismissed = this.context.globalState.get<boolean>(
          "tenure.onboardingNudgeDismissed",
        );
        if (!alreadyDismissed) {
          const action = await vscode.window.showInformationMessage(
            "Tenure: No provider configured. Run setup to connect an LLM and enable memory injection.",
            "Set up Tenure",
            "Dismiss",
          );
          if (action === "Set up Tenure") {
            vscode.commands.executeCommand("tenure.runOnboarding");
          } else if (action === "Dismiss") {
            await this.context.globalState.update(
              "tenure.onboardingNudgeDismissed",
              true,
            );
          }
        }
        return;
      }

      if (!hasModel) {
        this.onboardingPromptShown = true;

        const alreadyDismissed = this.context.globalState.get<boolean>(
          "tenure.onboardingNudgeDismissed",
        );
        if (!alreadyDismissed) {
          const action = await vscode.window.showInformationMessage(
            "Tenure: Provider is connected but no model has been selected. Run setup to finish.",
            "Run Setup",
            "Dismiss",
          );
          if (action === "Run Setup") {
            vscode.commands.executeCommand("tenure.runOnboarding");
          } else if (action === "Dismiss") {
            await this.context.globalState.update(
              "tenure.onboardingNudgeDismissed",
              true,
            );
          }
        }
        return;
      }

      this.lmProvider?.refresh();
      this.onboardingPromptShown = true;
      this.beliefsProvider?.resetAndReconnect();
    } catch {}
  }

  private async resolveWorkspaceLevel(rootUri: vscode.Uri): Promise<void> {
    const tenureConfig = await readTenureConfig(rootUri);
    const gitRemote = resolveGitRemote(rootUri);
    const gitName = gitRemote ? extractRepoName(gitRemote) : null;

    this.cachedGitRemote = gitRemote;
    this.cachedProjectName =
      tenureConfig?.projectId ??
      gitName ??
      getLocalFallbackSlug(rootUri.fsPath);

    this.workspaceResolved = true;
  }

  private async checkAndPromptTenureFile(
    workspaceRoot: vscode.Uri,
  ): Promise<void> {
    const alreadyPrompted = this.context.globalState.get<boolean>(
      "tenure.tenureFilePromptShown",
    );
    if (alreadyPrompted) return;

    const tenureFileUri = vscode.Uri.joinPath(workspaceRoot, ".tenure");

    try {
      await vscode.workspace.fs.stat(tenureFileUri);
      await this.context.globalState.update(
        "tenure.tenureFilePromptShown",
        true,
      );
      return;
    } catch {}

    await this.context.globalState.update("tenure.tenureFilePromptShown", true);

    const action = await vscode.window.showInformationMessage(
      "Tenure: No `.tenure` file found. Create one to enable project-scoped memory?",
      "Create `.tenure`",
      "Remind me later",
    );

    if (action !== "Create `.tenure`") return;

    const inferredName =
      this.cachedProjectName ?? slugify(path.basename(workspaceRoot.fsPath));

    const contents = [
      `[project]`,
      `name = "${inferredName}"`,
      `# description = "What this project does"`,
      ``,
      `[context]`,
      `# stack = ["typescript", "node"]`,
      `# ignore = ["dist/**", "*.generated.ts"]`,
      ``,
    ].join("\n");

    await vscode.workspace.fs.writeFile(
      tenureFileUri,
      Buffer.from(contents, "utf8"),
    );

    const doc = await vscode.workspace.openTextDocument(tenureFileUri);
    await vscode.window.showTextDocument(doc);

    this.invalidateManifestCache();
    this.scheduleSync();
  }

  private async migrateScope(
    oldName: string,
    newName: string,
    token: string,
    baseUrl: string,
  ): Promise<void> {
    await fetch(`${baseUrl}/v1/workspace/migrate-scope`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        old_scope: `project:${slugify(oldName)}`,
        new_scope: `project:${slugify(newName)}`,
      }),
      signal: AbortSignal.timeout(5000),
    });
  }
}

function extractRepoName(remoteUrl: string): string | null {
  const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toRelativeFile(fileUri: vscode.Uri): string | null {
  const relative = vscode.workspace.asRelativePath(fileUri, true);
  if (path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function getLocalFallbackSlug(workspaceRoot: string): string {
  const folderName = basename(workspaceRoot);
  const hash = createHash("md5")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 8);
  return `${folderName}-${hash}`;
}
