import * as vscode from "vscode";
import { TokenStore } from "./tokenStore.js";
import { WorkspaceSync } from "./workspaceSync.js";
import { TenureBeliefsViewProvider } from "./beliefsViewProvider.js";
import { TenureLmProvider } from "./lmProvider.js";
import { OnboardingPanel } from "./onboardingViewProvider.js";
import path from "node:path";
import {
  detectInstalledClients,
  offerClientIntegrations,
  type DetectedClients
} from "./clientIntegrations.js";
import { buildClientRows } from "./clientStatusPanel.js";
import {
  ensureTenureRunning,
  isTenureHealthy,
  readTenureToken,
  updateTenureImage
} from "./tenureInstaller.js";
import { injectContinueConfig } from "./clientIntegrations.js";
import { detectHostApp } from "./hostEnvironment.js";

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const tokenStore = new TokenStore(context.secrets);

  const existingToken = await tokenStore.get();
  await vscode.commands.executeCommand(
    "setContext",
    "tenure.tokenConfigured",
    existingToken !== undefined
  );

  const getBaseUrl = (): string =>
    vscode.workspace
      .getConfiguration("tenure")
      .get<string>("baseUrl", "http://localhost:5757");

  const hostApp = detectHostApp();
  const isNativeVSCode = hostApp === "vscode" || hostApp === "vscodium";

  const lmProvider = new TenureLmProvider(tokenStore, getBaseUrl);

  if (isNativeVSCode) {
    const lmProviderDisposable = vscode.lm.registerLanguageModelChatProvider(
      "tenure",
      lmProvider
    );
    context.subscriptions.push(lmProviderDisposable);
  }
  context.subscriptions.push(lmProvider);

  let beliefsProvider: TenureBeliefsViewProvider | undefined;
  if (!vscode.workspace.workspaceFolders?.length) {
    beliefsProvider = new TenureBeliefsViewProvider(
      tokenStore,
      context.extensionUri
    );
    beliefsProvider.setNoWorkspace(true);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "tenure.beliefsView",
        beliefsProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
  } else {
    beliefsProvider = new TenureBeliefsViewProvider(
      tokenStore,
      context.extensionUri
    );
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "tenure.beliefsView",
        beliefsProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("tenure.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Paste your Tenure API token",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "mp_..."
      });
      if (token?.trim()) {
        await tokenStore.set(token.trim());
        await vscode.commands.executeCommand(
          "setContext",
          "tenure.tokenConfigured",
          true
        );
        vscode.window.showInformationMessage("Tenure: token saved.");
        lmProvider.refresh();
        sync?.scheduleSync();
      }
    }),

    vscode.commands.registerCommand("tenure.openBeliefs", () => {
      const baseUrl = getBaseUrl();
      vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/beliefs`));
    }),

    vscode.commands.registerCommand("tenure.runOnboarding", () => {
      OnboardingPanel.open(context, tokenStore, lmProvider, hostApp);
    }),

    vscode.commands.registerCommand(
      "tenure.handleClientAction",
      async (clientId: string, action: string) => {
        const token = await tokenStore.get();
        const baseUrl = getBaseUrl();
        if (!token) return;

        if (action === "copy_url") {
          await vscode.env.clipboard.writeText(`${baseUrl}/v1`);
          vscode.window.showInformationMessage("Base URL copied to clipboard.");
        } else if (action === "copy_token") {
          await vscode.env.clipboard.writeText(token);
          vscode.window.showInformationMessage("Token copied to clipboard.");
        } else if (action === "auto_config" && clientId === "continue") {
          const result = await injectContinueConfig(token, baseUrl);
          if (result === "injected") {
            vscode.window.showInformationMessage(
              "Done. Tenure is now available in Continue's model picker."
            );

            if (beliefsProvider) {
              const clients = detectInstalledClients();
              const rows = buildClientRows(clients, token, baseUrl);
              beliefsProvider.updateClientStatus(rows);
            }
          } else if (result === "ts_config") {
            vscode.window.showWarningMessage(
              "Continue uses a TypeScript config — add Tenure manually. Base URL: " +
                `${baseUrl}/v1`
            );
          }
        } else if (action === "docs") {
          vscode.env.openExternal(
            vscode.Uri.parse(
              "https://docs.continue.dev/reference/model-providers/openai"
            )
          );
        }
      },

      vscode.commands.registerCommand("tenure.configureDeployment", () =>
        configureDeployment(
          context,
          tokenStore,
          lmProvider,
          beliefsProvider,
          sync
        )
      )
    )
  );

  void (async () => {
    const baseUrl = getBaseUrl();
    const healthy = await isTenureHealthy(baseUrl);

    if (healthy) {
      if (!existingToken) {
        const mode = context.globalState.get<"local" | "teams">("tenure.mode");
        if (mode === "teams") {
          await maybeShowTokenWarning(context);
        } else {
          const token = await readTenureToken();
          if (token) {
            await tokenStore.set(token);
            vscode.window.showInformationMessage(
              "Tenure is running and your token has been saved automatically."
            );
          } else {
            await maybeShowTokenWarning(context);
          }
        }
      }

      const currentVersion = context.extension.packageJSON.version as string;
      const lastVersion = context.globalState.get<string>(
        "tenure.lastSeenVersion"
      );
      if (lastVersion === undefined) {
        await context.globalState.update(
          "tenure.lastSeenVersion",
          currentVersion
        );
      } else if (lastVersion !== currentVersion) {
        const mode = context.globalState.get<"local" | "teams">("tenure.mode");
        if (mode !== "teams") {
          updateTenureImage().then(async (success) => {
            if (success) {
              await context.globalState.update(
                "tenure.lastSeenVersion",
                currentVersion
              );
              beliefsProvider?.resetAndReconnect();
            }
          });
        } else {
          await context.globalState.update(
            "tenure.lastSeenVersion",
            currentVersion
          );
          beliefsProvider?.resetAndReconnect();
        }
      }
    } else {
      const alreadyConfigured = context.globalState.get<boolean>(
        "tenure.deploymentConfigured"
      );

      if (!alreadyConfigured && !existingToken) {
        await configureDeployment(
          context,
          tokenStore,
          lmProvider,
          beliefsProvider,
          undefined
        );
      } else {
        const mode = context.globalState.get<"local" | "teams">("tenure.mode");
        if (mode === "teams") {
          const action = await vscode.window.showInformationMessage(
            "Tenure teams server is unreachable. Check your network or run Configure Deployment.",
            "Configure Deployment",
            "Dismiss"
          );
          if (action === "Configure Deployment") {
            await configureDeployment(
              context,
              tokenStore,
              lmProvider,
              beliefsProvider,
              undefined
            );
          }
        } else {
          const action = await vscode.window.showInformationMessage(
            "Tenure isn't running. Would you like to set it up automatically?",
            "Set Up Tenure",
            "I'll do it manually"
          );

          if (action === "Set Up Tenure") {
            const installStatus = vscode.window.createStatusBarItem(
              vscode.StatusBarAlignment.Right,
              101
            );
            installStatus.text = "$(sync~spin) Tenure: Setting up…";
            installStatus.show();
            context.subscriptions.push(installStatus);

            const result = await ensureTenureRunning(context, (msg) => {
              installStatus.text = `$(sync~spin) ${msg}`;
            });

            installStatus.hide();

            if (result !== "failed") {
              handleInstallSuccess(context, lmProvider, beliefsProvider);
            }
          } else {
            if (!existingToken) {
              await maybeShowTokenWarning(context);
            }
          }
        }
      }
    }
  })();

  if (!vscode.workspace.workspaceFolders?.length) {
    return;
  }

  const statusBar = vscode.window.createStatusBarItem(
    "tenure.status",
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = "tenure.openBeliefs";
  statusBar.text = "$(symbol-misc) Tenure";
  statusBar.tooltip = "Click to open your Beliefs Dashboard";
  statusBar.show();

  const sync = new WorkspaceSync(
    tokenStore,
    context,
    statusBar,
    beliefsProvider,
    lmProvider
  );

  async function requireProjectContext(): Promise<{
    token: string;
    projectName: string;
    baseUrl: string;
  } | null> {
    const token = await tokenStore.get();
    if (!token) {
      vscode.window.showWarningMessage("Tenure: No token configured.");
      return null;
    }
    if (!sync) {
      vscode.window.showWarningMessage("Tenure: Open a workspace first.");
      return null;
    }
    const projectName = sync.getLastProjectName();
    if (!projectName) {
      vscode.window.showWarningMessage(
        "Tenure: Project scope not resolved yet."
      );
      return null;
    }
    return { token, projectName, baseUrl: getBaseUrl() };
  }

  {
    const token = await tokenStore.get();
    if (token) {
      const clients = detectInstalledClients();
      const baseUrl = getBaseUrl();

      await offerClientIntegrations(context, clients, token, baseUrl);

      const rows = buildClientRows(clients, token, baseUrl);
      beliefsProvider.updateClientStatus(rows);

      context.subscriptions.push(
        vscode.extensions.onDidChange(() => {
          const updatedClients = detectInstalledClients();
          const updatedRows = buildClientRows(updatedClients, token, baseUrl);
          beliefsProvider!.updateClientStatus(updatedRows);
        })
      );
    }
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const tenureWatcher = workspaceFolder
    ? vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, ".tenure")
      )
    : null;

  if (tenureWatcher) {
    const handleConfigMutation = () => {
      sync.invalidateCache();
      sync.scheduleSync();
    };
    context.subscriptions.push(
      tenureWatcher.onDidChange(handleConfigMutation),
      tenureWatcher.onDidCreate(handleConfigMutation),
      tenureWatcher.onDidDelete(handleConfigMutation),
      tenureWatcher
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("tenure.startInstall", async () => {
      const installStatus = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        101
      );
      installStatus.text = "$(sync~spin) Tenure: Setting up…";
      installStatus.show();
      context.subscriptions.push(installStatus);

      const result = await ensureTenureRunning(context, (msg) => {
        installStatus.text = `$(sync~spin) ${msg}`;
      });

      installStatus.hide();

      if (result !== "failed") {
        handleInstallSuccess(context, lmProvider, beliefsProvider);
        sync.invalidateCache();
        sync.scheduleSync();
      }
    }),

    vscode.commands.registerCommand("tenure.syncNow", () => {
      sync.scheduleSync();
      vscode.window.showInformationMessage("Tenure: workspace sync triggered.");
    }),

    vscode.commands.registerCommand("tenure.recordBelief", async () => {
      const token = await tokenStore.get();
      if (!token) {
        vscode.window.showWarningMessage("Tenure: No token configured.");
        return;
      }
      vscode.commands.executeCommand("tenure.beliefsView.focus");
      beliefsProvider!.openRecordForm();
    }),

    vscode.commands.registerCommand("tenure.generateResume", async () => {
      const ctx = await requireProjectContext();
      if (!ctx) return;

      try {
        const res = await fetch(`${ctx.baseUrl}/v1/resume/generate`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ctx.token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({})
        });

        if (!res.ok) {
          const text = await res.text().catch(() => `HTTP ${res.status}`);
          throw new Error(text);
        }

        const { snapshot } = (await res.json()) as {
          snapshot: Record<string, unknown>;
        };

        const panel = vscode.window.createWebviewPanel(
          "tenureResume",
          "Tenure: Project Resume",
          vscode.ViewColumn.One,
          { enableScripts: true }
        );

        panel.webview.html = buildResumeHtml(snapshot);
      } catch (err) {
        vscode.window.showErrorMessage(`Tenure: ${(err as Error).message}`);
      }
    }),

    vscode.workspace.onDidRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) {
        const oldPath = vscode.workspace.asRelativePath(oldUri, true);
        const newPath = vscode.workspace.asRelativePath(newUri, true);
        if (path.isAbsolute(oldPath) || path.isAbsolute(newPath)) continue;
        beliefsProvider!.sendRenameFile(oldPath, newPath);
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri && editor.document.uri.scheme === "file") {
        const relativePath = vscode.workspace.asRelativePath(
          editor.document.uri,
          true
        );
        const projectName = sync.getLastProjectName();
        if (projectName && !path.isAbsolute(relativePath)) {
          const scope = `project:${slugify(projectName)}`;
          beliefsProvider!.sendFetchFileBeliefs(
            relativePath,
            scope,
            editor.document.uri
          );
          sync.sendActiveFileUpdate(
            relativePath,
            editor.document.languageId,
            editor.document.uri
          );
        }
      }
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => sync.scheduleSync()),

    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        beliefsProvider!.ensureConnected().catch(() => {});
      }
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tenure.enabled")) {
        const isEnabled = vscode.workspace
          .getConfiguration("tenure")
          .get<boolean>("enabled", true);
        if (!isEnabled) {
          sync.dispose();
          statusBar.text = "$(circle-slash) Tenure: Disabled";
          statusBar.command = undefined;
        } else {
          sync.scheduleSync();
          statusBar.command = "tenure.openBeliefs";
        }
      }
      if (event.affectsConfiguration("tenure.baseUrl")) {
        sync.invalidateCache();
        sync.reconnectBeliefs();
        sync.scheduleSync();
        lmProvider.refresh();
      }
    }),

    statusBar,
    { dispose: () => sync.dispose() }
  );

  sync.scheduleSync();
}

export function deactivate(): void {}

const DONT_SHOW_TOKEN_WARNING = "tenure.dontShowTokenWarning";

async function maybeShowTokenWarning(
  context: vscode.ExtensionContext
): Promise<void> {
  if (context.globalState.get<boolean>(DONT_SHOW_TOKEN_WARNING)) return;

  const action = await vscode.window.showWarningMessage(
    "Tenure: No API token configured. Tenure will not sync workspace state.",
    "Set Token",
    "Don't show again"
  );

  if (action === "Set Token") {
    vscode.commands.executeCommand("tenure.setToken");
  } else if (action === "Don't show again") {
    await context.globalState.update(DONT_SHOW_TOKEN_WARNING, true);
  }
}

function handleInstallSuccess(
  context: vscode.ExtensionContext,
  lmProvider: TenureLmProvider,
  beliefsProvider: TenureBeliefsViewProvider | undefined
): void {
  const currentVersion = context.extension.packageJSON.version as string;
  context.globalState.update("tenure.lastSeenVersion", currentVersion);
  lmProvider.refresh();
  beliefsProvider?.resetAndReconnect();
  vscode.window.showInformationMessage(
    "Tenure is running and your token has been saved automatically."
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildResumeHtml(snapshot: Record<string, unknown>): string {
  const files = (snapshot.active_files as any[] | undefined) ?? [];
  const beliefs = (snapshot.created_beliefs as any[] | undefined) ?? [];
  const queries = (snapshot.audit_queries as any[] | undefined) ?? [];
  const next = (snapshot.inferred_next_steps as string[] | undefined) ?? [];
  const openQuestions =
    (snapshot.open_question_beliefs as any[] | undefined) ?? [];

  const list = (items: string[]) =>
    items.length
      ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
      : "<p>None</p>";

  const fileList = files.length
    ? files
        .map(
          (f) =>
            `<div class="file"><strong>${escapeHtml(f.path)}</strong>
            <div class="meta">${new Date(
              f.last_seen_at
            ).toLocaleString()}</div></div>`
        )
        .join("")
    : "<p>No recently edited files.</p>";

  const beliefList = beliefs.length
    ? beliefs
        .map(
          (b) =>
            `<div class="belief">
              <div class="name">${escapeHtml(b.canonical_name ?? b.id)}</div>
              <div class="content">${escapeHtml(b.content)}</div>
              ${
                b.why_it_matters
                  ? `<div class="why">${escapeHtml(b.why_it_matters)}</div>`
                  : ""
              }
            </div>`
        )
        .join("")
    : "<p>No recent beliefs.</p>";

  const queryList = queries.length
    ? queries
        .map(
          (q) =>
            `<div class="query">
              <div class="time">${new Date(q.timestamp).toLocaleString()}</div>
              <div>${escapeHtml(q.query)}</div>
            </div>`
        )
        .join("")
    : "<p>No recent queries.</p>";

  const openList = openQuestions.length
    ? openQuestions
        .map(
          (q) =>
            `<div class="belief"><div class="content">${escapeHtml(
              q.content
            )}</div></div>`
        )
        .join("")
    : "<p>No open questions.</p>";

  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; padding: 20px; color: var(--vscode-foreground); max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
  .section { margin-top: 20px; }
  .section h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-bottom: 10px; }
  .summary { line-height: 1.5; margin-bottom: 12px; }
  .file { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .file:last-child { border-bottom: none; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .belief { padding: 10px; margin-bottom: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; }
  .belief .name { font-weight: 600; margin-bottom: 4px; }
  .belief .why { font-style: italic; color: var(--vscode-descriptionForeground); margin-top: 4px; font-size: 12px; }
  .query { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .query .time { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  ul { margin: 0; padding-left: 18px; }
  li { margin-bottom: 4px; }
</style>
</head>
<body>
  <h1>${escapeHtml((snapshot.title as string) ?? "Project Resume")}</h1>
  <div class="subtitle">Confidence: ${Math.round(
    ((snapshot.confidence as number) ?? 0) * 100
  )}% — ${escapeHtml((snapshot.confidence_reason as string) ?? "")}</div>
  <div class="summary">${escapeHtml((snapshot.summary as string) ?? "")}</div>

  <div class="section"><h2>Active Files</h2>${fileList}</div>
  <div class="section"><h2>Recent Beliefs</h2>${beliefList}</div>
  <div class="section"><h2>Recent Queries</h2>${queryList}</div>
  <div class="section"><h2>Inferred Next Steps</h2>${list(next)}</div>
  <div class="section"><h2>Open Questions</h2>${openList}</div>
</body>
</html>`;
}

async function configureDeployment(
  context: vscode.ExtensionContext,
  tokenStore: TokenStore,
  lmProvider: TenureLmProvider,
  beliefsProvider: TenureBeliefsViewProvider | undefined,
  sync: WorkspaceSync | undefined
): Promise<void> {
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: "$(desktop-download) Local (Docker)",
        description: "Install and run Tenure on this machine",
        value: "local" as const
      },
      {
        label: "$(globe) Teams / Self-hosted",
        description: "Connect to an existing Tenure server",
        value: "teams" as const
      }
    ],
    {
      placeHolder: "Select Tenure deployment",
      ignoreFocusOut: true,
      title: "Configure Tenure"
    }
  );
  if (!mode) return;

  await context.globalState.update("tenure.mode", mode.value);

  if (mode.value === "local") {
    await vscode.commands.executeCommand("tenure.startInstall");
    await context.globalState.update("tenure.deploymentConfigured", true);
    return;
  }

  const baseUrl = await vscode.window.showInputBox({
    prompt: "Enter your Tenure server base URL",
    placeHolder: "https://tenure.company.com:5757",
    value: vscode.workspace
      .getConfiguration("tenure")
      .get<string>("baseUrl", "http://localhost:5757"),
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value?.trim()) return "Base URL is required";
      try {
        new URL(value);
      } catch {
        return "Invalid URL";
      }
      return undefined;
    }
  });
  if (!baseUrl) return;

  const token = await vscode.window.showInputBox({
    prompt: "Enter your Tenure API token",
    password: true,
    placeHolder: "mp_...",
    ignoreFocusOut: true,
    validateInput: (value) => (!value?.trim() ? "Token is required" : undefined)
  });
  if (!token?.trim()) return;

  await vscode.workspace
    .getConfiguration("tenure")
    .update("baseUrl", baseUrl.trim(), true);
  await tokenStore.set(token.trim());
  await vscode.commands.executeCommand(
    "setContext",
    "tenure.tokenConfigured",
    true
  );
  await context.globalState.update("tenure.deploymentConfigured", true);

  vscode.window.showInformationMessage("Tenure: Teams server configured.");
  lmProvider.refresh();
  beliefsProvider?.resetAndReconnect();
  sync?.invalidateCache();
  sync?.reconnectBeliefs();
  sync?.scheduleSync();
}
