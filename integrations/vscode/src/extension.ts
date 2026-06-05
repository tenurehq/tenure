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
  type DetectedClients,
} from "./clientIntegrations.js";
import { buildClientRows } from "./clientStatusPanel.js";
import {
  ensureTenureRunning,
  isTenureHealthy,
  readTenureToken,
  updateTenureImage,
} from "./tenureInstaller.js";
import { injectContinueConfig } from "./clientIntegrations.js";
import { detectHostApp } from "./hostEnvironment.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const tokenStore = new TokenStore(context.secrets);

  const existingToken = await tokenStore.get();
  await vscode.commands.executeCommand(
    "setContext",
    "tenure.tokenConfigured",
    existingToken !== undefined,
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
      lmProvider,
    );
    context.subscriptions.push(lmProviderDisposable);
  }
  context.subscriptions.push(lmProvider);

  let beliefsProvider: TenureBeliefsViewProvider | undefined;
  if (!vscode.workspace.workspaceFolders?.length) {
    beliefsProvider = new TenureBeliefsViewProvider(
      tokenStore,
      context.extensionUri,
    );
    beliefsProvider.setNoWorkspace(true);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "tenure.beliefsView",
        beliefsProvider,
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    );
  } else {
    beliefsProvider = new TenureBeliefsViewProvider(
      tokenStore,
      context.extensionUri,
    );
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "tenure.beliefsView",
        beliefsProvider,
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("tenure.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Paste your Tenure API token",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "mp_...",
      });
      if (token?.trim()) {
        await tokenStore.set(token.trim());
        await vscode.commands.executeCommand(
          "setContext",
          "tenure.tokenConfigured",
          true,
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
              "Done. Tenure is now available in Continue's model picker.",
            );

            if (beliefsProvider) {
              const clients = detectInstalledClients();
              const rows = buildClientRows(clients, token, baseUrl);
              beliefsProvider.updateClientStatus(rows);
            }
          } else if (result === "ts_config") {
            vscode.window.showWarningMessage(
              "Continue uses a TypeScript config — add Tenure manually. Base URL: " +
                `${baseUrl}/v1`,
            );
          }
        } else if (action === "docs") {
          vscode.env.openExternal(
            vscode.Uri.parse(
              "https://docs.continue.dev/reference/model-providers/openai",
            ),
          );
        }
      },
    ),
  );

  void (async () => {
    const healthy = await isTenureHealthy();

    if (healthy) {
      if (!existingToken) {
        const token = await readTenureToken();
        if (token) {
          await tokenStore.set(token);
          vscode.window.showInformationMessage(
            "Tenure is running and your token has been saved automatically.",
          );
        } else {
          await maybeShowTokenWarning(context);
        }
      }

      const currentVersion = context.extension.packageJSON.version as string;
      const lastVersion = context.globalState.get<string>(
        "tenure.lastSeenVersion",
      );
      if (lastVersion === undefined) {
        await context.globalState.update(
          "tenure.lastSeenVersion",
          currentVersion,
        );
      } else if (lastVersion !== currentVersion) {
        updateTenureImage().then(async (success) => {
          if (success) {
            await context.globalState.update(
              "tenure.lastSeenVersion",
              currentVersion,
            );
            beliefsProvider?.resetAndReconnect();
          }
        });
      }
    } else {
      const action = await vscode.window.showInformationMessage(
        "Tenure isn't running. Would you like to set it up automatically?",
        "Set Up Tenure",
        "I'll do it manually",
      );

      if (action === "Set Up Tenure") {
        const installStatus = vscode.window.createStatusBarItem(
          vscode.StatusBarAlignment.Right,
          101,
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
  })();

  if (!vscode.workspace.workspaceFolders?.length) {
    return;
  }

  const statusBar = vscode.window.createStatusBarItem(
    "tenure.status",
    vscode.StatusBarAlignment.Right,
    100,
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
    lmProvider,
  );

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
        }),
      );
    }
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const tenureWatcher = workspaceFolder
    ? vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, ".tenure"),
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
      tenureWatcher,
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("tenure.startInstall", async () => {
      const installStatus = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        101,
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
          true,
        );
        const projectName = sync.getLastProjectName();
        if (projectName && !path.isAbsolute(relativePath)) {
          const scope = `project:${slugify(projectName)}`;
          beliefsProvider!.sendFetchFileBeliefs(
            relativePath,
            scope,
            editor.document.uri,
          );
          sync.sendActiveFileUpdate(
            relativePath,
            editor.document.languageId,
            editor.document.uri,
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
    { dispose: () => sync.dispose() },
  );

  sync.scheduleSync();
}

export function deactivate(): void {}

const DONT_SHOW_TOKEN_WARNING = "tenure.dontShowTokenWarning";

async function maybeShowTokenWarning(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>(DONT_SHOW_TOKEN_WARNING)) return;

  const action = await vscode.window.showWarningMessage(
    "Tenure: No API token configured. Tenure will not sync workspace state.",
    "Set Token",
    "Don't show again",
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
  beliefsProvider: TenureBeliefsViewProvider | undefined,
): void {
  const currentVersion = context.extension.packageJSON.version as string;
  context.globalState.update("tenure.lastSeenVersion", currentVersion);
  lmProvider.refresh();
  beliefsProvider?.resetAndReconnect();
  vscode.window.showInformationMessage(
    "Tenure is running and your token has been saved automatically.",
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
