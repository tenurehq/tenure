import * as vscode from "vscode";
import type { TokenStore } from "./tokenStore.js";
import WebSocket from "ws";

interface BeliefSummary {
  id: string;
  type: string;
  canonical_name: string;
  content: string;
  why_it_matters: string;
  epistemic_status: string;
  confidence: number;
  pinned: boolean;
  scope: string[];
  aliases: string[];
  origin_context?: {
    active_file: string | null;
    language: string | null;
    project_scope: string | null;
  } | null;
}

interface CategorizedBeliefs {
  file: BeliefSummary[];
  project: BeliefSummary[];
  universal: BeliefSummary[];
}

type ServerMessage =
  | {
      type: "beliefs_categorized";
      file: BeliefSummary[];
      project: BeliefSummary[];
      universal: BeliefSummary[];
      scope: string;
      active_file: string | null;
    }
  | { type: "belief_upserted"; belief: BeliefSummary }
  | { type: "belief_superseded"; id: string }
  | {
      type: "contradiction_detected";
      contradiction: {
        belief_ids: [string, string];
        reason: string;
        scope: string;
      };
    }
  | { type: "patch_ack"; id: string; belief: BeliefSummary }
  | { type: "record_ack"; belief: BeliefSummary }
  | { type: "scope_confirmed"; scope: string; active_file: string | null }
  | { type: "toggles_state"; injection: boolean; extraction: boolean }
  | { type: "error"; request_type: string; message: string };

type ClientMessage =
  | { type: "subscribe"; scope: string }
  | {
      type: "fetch_categorized_beliefs";
      scope: string;
      active_file: string | null;
    }
  | {
      type: "patch_belief";
      id: string;
      patch: {
        content?: string;
        epistemic_status?: string;
        pinned?: boolean;
        canonical_name?: string;
        why_it_matters?: string;
        aliases?: string[];
      };
    }
  | {
      type: "record_belief";
      belief_type: "decision" | "preference" | "entity" | "relation";
      content: string;
      why_it_matters: string;
      scope: string[];
      canonical_name: string;
      active_file: string | null;
      active_language: string | null;
      project_scope: string | null;
    }
  | { type: "rename_file"; old_path: string; new_path: string }
  | {
      type: "workspace_state";
      workspace_root: string;
      project_name: string;
      git_remote: string | null;
      active_file: string | null;
      active_language: string | null;
    }
  | { type: "file_meta"; path: string; size_bytes: number }
  | { type: "set_toggle"; toggle: "injection" | "extraction"; value: boolean }
  | { type: "fetch_toggles" };

const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export class TenureBeliefsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private socket: WebSocket | null = null;
  private currentScope: string | null = null;
  private currentActiveFile: string | null = null;
  private currentActiveFileUri: vscode.Uri | null = null;
  private beliefs: BeliefSummary[] = [];
  private categorizedBeliefs: CategorizedBeliefs = {
    file: [],
    project: [],
    universal: [],
  };
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private onConnectedCallback: (() => void) | null = null;
  private pendingWorkspaceState:
    | Parameters<TenureBeliefsViewProvider["sendWorkspaceState"]>[0]
    | null = null;

  private noWorkspace = false;
  private onboardingMode = false;

  constructor(
    private readonly tokenStore: TokenStore,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.buildShell();

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "openDashboard") {
        vscode.commands.executeCommand("tenure.openBeliefs");
      }
      if (msg.command === "pinBelief") {
        this.togglePin(msg.id, msg.pinned);
      }
      if (msg.command === "ready") {
        if (this.noWorkspace) {
          this.showNoWorkspace();
        } else if (this.currentScope) {
          this.pushCategorizedState();
          this.ensureConnected().catch(() => {});
        }
      }
      if (msg.command === "recordBelief") {
        const scopeLevel = msg.scopeLevel ?? "project";
        let scope: string[];
        if (scopeLevel === "universal") {
          scope = ["user:universal"];
        } else if (scopeLevel === "file") {
          scope = this.currentScope ? [this.currentScope] : ["user:universal"];
        } else {
          scope = this.currentScope ? [this.currentScope] : ["user:universal"];
        }
        this.recordBelief(
          msg.content,
          msg.why,
          scope,
          msg.beliefType,
          scopeLevel === "file" ? this.currentActiveFile : null,
        );
      }
      if (msg.command === "openOnboarding") {
        vscode.commands.executeCommand("tenure.runOnboarding");
      }
      if (msg.command === "clientAction") {
        vscode.commands.executeCommand(
          "tenure.handleClientAction",
          msg.clientId,
          msg.action,
        );
      }
      if (msg.command === "openInstall") {
        vscode.commands.executeCommand("tenure.startInstall");
      }
      if (msg.command === "setToggle") {
        this.send({
          type: "set_toggle",
          toggle: msg.toggle,
          value: msg.value,
        });
      }
    });
  }

  async refresh(projectName: string, activeFile: string | null): Promise<void> {
    const scope = `project:${this.slugify(projectName)}`;
    this.currentActiveFile = activeFile;

    const scopeChanged = scope !== this.currentScope;
    this.currentScope = scope;

    await this.ensureConnected();

    if (scopeChanged) {
      this.send({ type: "subscribe", scope });
    }

    this.send({
      type: "fetch_categorized_beliefs",
      scope,
      active_file: activeFile,
    });
  }

  async reconnect(): Promise<void> {
    this.closeSocket();
    await this.ensureConnected();
    if (this.currentScope) {
      this.send({ type: "subscribe", scope: this.currentScope });
      this.send({
        type: "fetch_categorized_beliefs",
        scope: this.currentScope,
        active_file: this.currentActiveFile,
      });
    }
  }

  openRecordForm(): void {
    this.view?.webview.postMessage({ type: "open_form" });
  }

  recordBelief(
    content: string,
    whyItMatters: string,
    scope: string[],
    beliefType: "decision" | "preference" | "entity" | "relation" = "decision",
    activeFileOverride?: string | null,
  ): void {
    const canonicalName = content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .slice(0, 5)
      .join("_");

    const activeFile =
      activeFileOverride !== undefined
        ? activeFileOverride
        : this.currentActiveFile;

    this.ensureConnected()
      .then(() => {
        this.send({
          type: "record_belief",
          belief_type: beliefType,
          content,
          why_it_matters: whyItMatters,
          scope,
          canonical_name: canonicalName,
          active_file: activeFile,
          active_language: this.pendingWorkspaceState?.active_language ?? null,
          project_scope: this.currentScope,
        });
      })
      .catch(() => {});
  }

  setOnConnectedCallback(cb: () => void): void {
    this.onConnectedCallback = cb;
  }

  sendWorkspaceState(state: {
    workspace_root: string;
    project_name: string;
    git_remote: string | null;
    active_file: string | null;
    active_language: string | null;
  }): void {
    this.pendingWorkspaceState = state;
    this.send({ type: "workspace_state", ...state });
  }

  sendRenameFile(oldPath: string, newPath: string): void {
    this.send({ type: "rename_file", old_path: oldPath, new_path: newPath });
  }

  sendFileMeta(path: string, sizeBytes: number): void {
    this.send({ type: "file_meta", path, size_bytes: sizeBytes });
  }

  setNoWorkspace(value: boolean): void {
    this.noWorkspace = value;
    if (value) {
      this.showNoWorkspace();
    }
  }

  updateClientStatus(rows: import("./clientStatusPanel.js").ClientRow[]): void {
    this.view?.webview.postMessage({ type: "client_status", rows });
  }

  showNoWorkspace(): void {
    this.view?.webview.postMessage({ type: "no_workspace" });
  }

  showDisconnected(): void {
    if (this.onboardingMode) return;
    this.view?.webview.postMessage({ type: "disconnected" });
  }

  showOnboardingPrompt(): void {
    this.onboardingMode = true;
    this.view?.webview.postMessage({ type: "onboarding_prompt" });
  }

  resetAndReconnect(): void {
    this.onboardingMode = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ensureConnected().catch(() => {});
  }

  sendFetchFileBeliefs(
    filePath: string,
    scope: string,
    fileUri: vscode.Uri,
  ): void {
    this.currentActiveFile = filePath;
    this.currentActiveFileUri = fileUri;
    this.send({
      type: "fetch_categorized_beliefs",
      scope,
      active_file: filePath,
    });
  }

  async ensureConnected(): Promise<void> {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const cfg = vscode.workspace.getConfiguration("tenure");
    const baseUrl = cfg.get<string>("baseUrl", "http://localhost:5757");
    const token = await this.tokenStore.get();
    this.openSocket(baseUrl, token ?? "");
  }

  dispose(): void {
    this.disposed = true;
    this.closeSocket();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }

  private openSocket(baseUrl: string, token: string): void {
    if (this.disposed) return;

    this.showDisconnected();

    const wsUrl = baseUrl.replace(/^http/, "ws") + "/v1/ws/beliefs";

    const socket = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    this.socket = socket;

    socket.on("open", () => {
      this.tokenStore.get().then((currentToken) => {
        if (!currentToken) {
          this.view?.webview.postMessage({ type: "no_token" });
          this.closeSocket();
          this.scheduleReconnect();
          return;
        }
        this.reconnectAttempt = 0;
        this.onboardingMode = false;
        this.onConnectedCallback?.();
        this.pendingWorkspaceState = null;
        if (this.currentScope) {
          this.send({ type: "subscribe", scope: this.currentScope });
          this.send({
            type: "fetch_categorized_beliefs",
            scope: this.currentScope,
            active_file: this.currentActiveFile,
          });
          this.send({ type: "fetch_toggles" });
        }
      });
    });

    socket.on("message", (raw) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.disposed) {
        this.tokenStore.get().then((currentToken) => {
          if (!currentToken) {
            this.view?.webview.postMessage({ type: "no_token" });
          } else {
            this.showDisconnected();
          }
        });
        this.scheduleReconnect();
      }
    });

    socket.on("error", () => {});
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "beliefs_categorized": {
        this.categorizedBeliefs = {
          file: msg.file,
          project: msg.project,
          universal: msg.universal,
        };
        this.beliefs = [...msg.file, ...msg.project, ...msg.universal];
        this.pushCategorizedState();
        break;
      }
      case "belief_upserted": {
        const idx = this.beliefs.findIndex((b) => b.id === msg.belief.id);
        if (idx !== -1) this.beliefs[idx] = msg.belief;
        else this.beliefs.unshift(msg.belief);
        this.categorizeBeliefsClientSide(this.beliefs);
        this.pushCategorizedState();
        break;
      }
      case "belief_superseded": {
        this.beliefs = this.beliefs.filter((b) => b.id !== msg.id);
        this.categorizeBeliefsClientSide(this.beliefs);
        this.pushCategorizedState();
        break;
      }
      case "record_ack": {
        const idx = this.beliefs.findIndex((b) => b.id === msg.belief.id);
        if (idx !== -1) this.beliefs[idx] = msg.belief;
        else this.beliefs.unshift(msg.belief);
        this.categorizeBeliefsClientSide(this.beliefs);
        this.pushCategorizedState();
        break;
      }
      case "patch_ack": {
        const idx = this.beliefs.findIndex((b) => b.id === msg.id);
        if (idx !== -1) {
          this.beliefs[idx] = msg.belief;
          this.categorizeBeliefsClientSide(this.beliefs);
          this.pushCategorizedState();
        }
        break;
      }
      case "scope_confirmed": {
        const scope = msg.scope;
        const scopeChanged = scope !== this.currentScope;
        this.currentScope = scope;
        this.currentActiveFile = msg.active_file;
        if (scopeChanged) {
          this.send({ type: "subscribe", scope });
        }
        this.send({
          type: "fetch_categorized_beliefs",
          scope,
          active_file: msg.active_file,
        });
        break;
      }
      case "toggles_state": {
        this.view?.webview.postMessage({
          type: "toggles_state",
          injection: msg.injection,
          extraction: msg.extraction,
        });
        break;
      }
      case "contradiction_detected": {
        this.view?.webview.postMessage(msg);
        break;
      }
      case "error": {
        this.view?.webview.postMessage(msg);
        break;
      }
    }
  }

  private categorizeBeliefsClientSide(beliefs: BeliefSummary[]): void {
    const file: BeliefSummary[] = [];
    const project: BeliefSummary[] = [];
    const universal: BeliefSummary[] = [];

    for (const b of beliefs) {
      if (b.scope.includes("user:universal")) {
        universal.push(b);
      } else if (
        b.origin_context?.active_file &&
        b.origin_context.active_file === this.currentActiveFile
      ) {
        file.push(b);
      } else {
        project.push(b);
      }
    }

    this.categorizedBeliefs = { file, project, universal };
  }

  private pushCategorizedState(): void {
    const activeFileName = this.currentActiveFile
      ? this.currentActiveFile.split("/").pop() ?? this.currentActiveFile
      : null;

    this.view?.webview.postMessage({
      type: "categorized_state",
      scope: this.currentScope ?? "No scope resolved",
      activeFileName,
      file: this.categorizedBeliefs.file,
      project: this.categorizedBeliefs.project,
      universal: this.categorizedBeliefs.universal,
      totalActive:
        this.categorizedBeliefs.file.length +
        this.categorizedBeliefs.project.length +
        this.categorizedBeliefs.universal.length,
    });
  }

  private togglePin(id: string, currentlyPinned: boolean): void {
    this.send({
      type: "patch_belief",
      id,
      patch: { pinned: !currentlyPinned },
    });
  }

  private send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private closeSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.ensureConnected().catch(() => {});
    }, delay);
  }

  private buildShell(): string {
    return `<!DOCTYPE html>
<html>
<head>
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); margin: 0; }

  /* Header */
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .header-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
  .header-badge { font-size: 10px; padding: 2px 6px; border-radius: 3px; background: transparent; color: var(--vscode-descriptionForeground); font-weight: 600; border: 1px solid var(--vscode-panel-border); }

  /* Toggles bar */
  .toggles-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; padding: 6px 8px; background: transparent; border-radius: 4px; border: none; }
  .toggle-item { display: flex; align-items: center; gap: 5px; font-size: 10px; }
  .toggle-item label { cursor: pointer; user-select: none; color: var(--vscode-descriptionForeground); }
  .toggle-switch { position: relative; width: 28px; height: 14px; cursor: pointer; }
  .toggle-switch input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-secondaryBackground); border-radius: 7px; transition: background 0.2s; }
  .toggle-slider::before { content: ""; position: absolute; width: 10px; height: 10px; left: 1px; top: 1px; background: var(--vscode-button-secondaryForeground); border-radius: 50%; transition: transform 0.2s; }
  .toggle-switch input:checked + .toggle-slider { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  .toggle-switch input:checked + .toggle-slider::before { transform: translateX(14px); background: var(--vscode-button-foreground); }

  /* Section */
  .section { margin-bottom: 14px; }
  .section-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .section-icon { font-size: 12px; }

  /* Belief card */
  .belief { padding: 8px; margin-bottom: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .belief.pinned { border-left: 2px solid var(--vscode-foreground); }
  .belief-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; }
  .name { font-weight: 600; }
  .pin-btn { background: none; border: none; cursor: pointer; color: var(--vscode-foreground); font-size: 14px; padding: 0 2px; line-height: 1; }
  .content { margin-bottom: 4px; line-height: 1.4; }
  .why { font-style: italic; color: var(--vscode-descriptionForeground); margin-bottom: 4px; font-size: 11px; }
  .meta { display: flex; gap: 6px; align-items: center; }
  .badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; }
  .badge-active { background: var(--vscode-testing-iconPassed); color: #fff; }
  .badge-inferred { background: var(--vscode-charts-blue); color: #fff; }
  .type { font-size: 10px; color: var(--vscode-descriptionForeground); }

  /* Record form */
  .scope-selector { display: flex; gap: 4px; margin-bottom: 8px; }
  .scope-btn { flex: 1; padding: 4px; font-size: 10px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); color: var(--vscode-foreground); cursor: pointer; border-radius: 3px; text-align: center; }
  .scope-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }

  .empty { color: var(--vscode-descriptionForeground); padding: 16px 0; text-align: center; font-size: 11px; }
  .link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }

  .onboarding-banner {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--vscode-button-background);
    border-radius: 4px;
    padding: 10px 10px 10px 12px;
    margin-bottom: 12px;
  }
  .onboarding-banner p { font-size: 11px; line-height: 1.5; margin-bottom: 8px; }
  .onboarding-banner button {
    width: 100%;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    font-family: inherit;
    font-size: 11px;
    padding: 5px;
    cursor: pointer;
    border-radius: 3px;
  }

  .clients-section { margin-top: 12px; border-top: 1px solid var(--vscode-panel-border); padding-top: 10px; }
  .clients-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .client-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 11px; }
  .client-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .client-dot.connected { background: var(--vscode-testing-iconPassed); }
  .client-dot.disconnected { background: var(--vscode-descriptionForeground); opacity: 0.4; }
  .client-label { flex: 1; }
  .client-action { font-size: 10px; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; white-space: nowrap; }
</style>
</head>
<body>
  <div id="onboarding-banner" class="onboarding-banner" style="display:none">
    <p>Tenure needs a provider configured before it can inject memory into your AI sessions.</p>
    <button onclick="post('openOnboarding')">Set up Tenure &rarr;</button>
  </div>

  <!-- Toggles -->
  <div class="toggles-bar" id="toggles-bar" style="display:none">
    <div class="toggle-item">
      <span class="toggle-switch">
        <input type="checkbox" id="toggle-injection" checked onchange="handleToggle('injection', this.checked)">
        <span class="toggle-slider"></span>
      </span>
      <label for="toggle-injection">Belief Injection</label>
    </div>
    <div class="toggle-item">
      <span class="toggle-switch">
        <input type="checkbox" id="toggle-extraction" checked onchange="handleToggle('extraction', this.checked)">
        <span class="toggle-slider"></span>
      </span>
      <label for="toggle-extraction">Belief Extraction</label>
    </div>
  </div>

  <div class="header" id="main-header" style="display:none">
    <span class="header-title">Tenure Beliefs</span>
    <span class="header-badge" id="total-badge">0 ACTIVE</span>
  </div>

  <div id="beliefs-container">
    <div id="section-file" class="section" style="display:none">
      <div class="section-header">
        <span>This File &mdash; <span id="file-name"></span></span>
      </div>
      <div id="file-beliefs"></div>
    </div>

    <div id="section-project" class="section" style="display:none">
      <div class="section-header">
        <span>Project Beliefs</span>
      </div>
      <div id="project-beliefs"></div>
    </div>

    <div id="section-universal" class="section" style="display:none">
      <div class="section-header">
        <span>Universal Beliefs</span>
      </div>
      <div id="universal-beliefs"></div>
    </div>
  </div>

  <div id="empty-state" class="empty" style="display:none"></div>

  <!-- Client status -->
  <div id="clients-section" class="clients-section" style="display:none">
    <div class="clients-title" id="clients-toggle" onclick="toggleClients()" style="cursor:pointer;user-select:none;">
      Connected clients <span id="clients-chevron" style="float:right;font-size:9px;">\u{25B6}</span>
    </div>
    <div id="clients-list" style="display:none"></div>
  </div>

  <!-- Record form -->
  <div id="record-panel" style="display:none">
    <div style="border-top:1px solid var(--vscode-panel-border);margin-top:8px;padding-top:8px;">
      <div style="font-size:11px;font-weight:600;margin-bottom:8px;">Record Belief</div>
      <div class="scope-selector">
        <button class="scope-btn" data-scope="file" onclick="selectScope('file')">This File</button>
        <button class="scope-btn active" data-scope="project" onclick="selectScope('project')">Project</button>
        <button class="scope-btn" data-scope="universal" onclick="selectScope('universal')">Universal</button>
      </div>
      <div style="margin-bottom:6px;">
        <select id="r-type" style="width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-family:inherit;font-size:11px;padding:4px;">
          <option value="decision">Decision</option>
          <option value="preference">Preference</option>
          <option value="entity">Entity</option>
          <option value="relation">Relation</option>
        </select>
      </div>
      <div style="margin-bottom:6px;">
        <textarea id="r-content" placeholder="What should Tenure remember?" rows="3"
          style="width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-family:inherit;font-size:11px;padding:4px;resize:vertical;box-sizing:border-box;"></textarea>
      </div>
      <div style="margin-bottom:8px;">
        <input id="r-why" type="text" placeholder="Why does this matter?"
          style="width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-family:inherit;font-size:11px;padding:4px;box-sizing:border-box;">
      </div>
      <div id="r-error" style="color:var(--vscode-errorForeground);font-size:10px;margin-bottom:4px;display:none"></div>
      <div style="display:flex;gap:4px;justify-content:flex-end;">
        <button onclick="closeForm()" style="background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);font-family:inherit;font-size:11px;padding:3px 8px;cursor:pointer;border-radius:3px;">Cancel</button>
        <button onclick="submitForm()" style="background:var(--vscode-button-background);border:none;color:var(--vscode-button-foreground);font-family:inherit;font-size:11px;padding:3px 8px;cursor:pointer;border-radius:3px;">Record</button>
      </div>
    </div>
  </div>
  <div id="record-belief-bar" style="display:none; border-top:1px solid var(--vscode-panel-border);margin-top:8px;padding-top:8px;">
    <button onclick="openForm()" id="open-form-btn"
      style="width:100%;background:var(--vscode-button-secondaryBackground);border:none;color:var(--vscode-button-secondaryForeground);font-family:inherit;font-size:11px;padding:5px;cursor:pointer;border-radius:3px;">
      + Record Belief
    </button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let selectedScope = "project";

    function post(cmd, data) {
      vscode.postMessage({ command: cmd, ...data });
    }

    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function handleToggle(toggle, value) {
      post("setToggle", { toggle, value });
    }

    function selectScope(scope) {
      selectedScope = scope;
      document.querySelectorAll(".scope-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.scope === scope);
      });
    }

    function renderBeliefCard(b) {
      return (
        '<div class="belief ' + (b.pinned ? "pinned" : "") +
        '" data-belief-id="' + esc(b.id) +
        '" data-hash="' + esc(hashBelief(b)) + '">' +
          '<div class="belief-header">' +
            '<div class="name">' + esc(b.canonical_name) + "</div>" +
            '<button class="pin-btn" ' +
              'onclick="post(\\'pinBelief\\', {id:\\'' + esc(b.id) + '\\',pinned:' + b.pinned + '})" ' +
              'title="' + (b.pinned ? "Unpin" : "Pin") + '">' +
              (b.pinned ? "\u2605" : "\u2606") +
            "</button>" +
          "</div>" +
          '<div class="content">' + esc(b.content) + "</div>" +
          (b.why_it_matters
            ? '<div class="why">' + esc(b.why_it_matters) + "</div>"
            : "") +
          '<div class="meta">' +
            '<span class="badge badge-' + esc(b.epistemic_status) + '">' +
              esc(b.epistemic_status) +
            "</span>" +
            '<span class="type">' + esc(b.type) + "</span>" +
          "</div>" +
        "</div>"
      );
    }

    function hashBelief(b) {
      return b.id + "_" + b.pinned + "_" + b.epistemic_status;
    }

    function renderSection(container, beliefs) {
      container.innerHTML = beliefs.map(renderBeliefCard).join("");
    }

    function renderCategorized(data) {
      const header = document.getElementById("main-header");
      const badge = document.getElementById("total-badge");
      const fileSection = document.getElementById("section-file");
      const projectSection = document.getElementById("section-project");
      const universalSection = document.getElementById("section-universal");
      const emptyState = document.getElementById("empty-state");
      const togglesBar = document.getElementById("toggles-bar");

      header.style.display = "flex";
      togglesBar.style.display = "flex";
      badge.textContent = data.totalActive + " ACTIVE";

      const hasFile = data.file.length > 0;
      const hasProject = data.project.length > 0;
      const hasUniversal = data.universal.length > 0;

      if (!hasFile && !hasProject && !hasUniversal) {
        emptyState.innerHTML = 'No beliefs yet.<br><span class="link" onclick="post(\\'openDashboard\\')">Open Dashboard</span>';
        emptyState.style.display = "block";
        fileSection.style.display = "none";
        projectSection.style.display = "none";
        universalSection.style.display = "none";
        return;
      }

      emptyState.style.display = "none";

      if (hasFile) {
        fileSection.style.display = "block";
        document.getElementById("file-name").textContent = (data.activeFileName ?? "").toUpperCase();
        renderSection(document.getElementById("file-beliefs"), data.file);
      } else {
        fileSection.style.display = "none";
      }

      if (hasProject) {
        projectSection.style.display = "block";
        renderSection(document.getElementById("project-beliefs"), data.project);
      } else {
        projectSection.style.display = "none";
      }

      if (hasUniversal) {
        universalSection.style.display = "block";
        renderSection(document.getElementById("universal-beliefs"), data.universal);
      } else {
        universalSection.style.display = "none";
      }
    }

    function openForm() {
      document.getElementById("record-panel").style.display = "block";
      document.getElementById("open-form-btn").style.display = "none";
      document.getElementById("r-content").focus();
    }

    function closeForm() {
      document.getElementById("record-panel").style.display = "none";
      document.getElementById("open-form-btn").style.display = "block";
      document.getElementById("r-content").value = "";
      document.getElementById("r-why").value = "";
      document.getElementById("r-error").style.display = "none";
      selectedScope = "project";
      selectScope("project");
    }

    function submitForm() {
      const type = document.getElementById("r-type").value;
      const content = document.getElementById("r-content").value.trim();
      const why = document.getElementById("r-why").value.trim();
      const errEl = document.getElementById("r-error");

      if (!content) { errEl.textContent = "Content is required."; errEl.style.display = "block"; return; }
      if (!why) { errEl.textContent = "Why it matters is required."; errEl.style.display = "block"; return; }

      errEl.style.display = "none";
      post("recordBelief", { beliefType: type, content, why, scopeLevel: selectedScope });
      closeForm();
    }

    function toggleClients() {
      const list = document.getElementById("clients-list");
      const chevron = document.getElementById("clients-chevron");
      const isOpen = list.style.display !== "none";
      list.style.display = isOpen ? "none" : "block";
      chevron.textContent = isOpen ? "\\u25B6" : "\\u25BC";
    }

    function renderEmpty(label, line1, line2) {
      document.getElementById("main-header").style.display = "none";
      document.getElementById("toggles-bar").style.display = "none";
      document.getElementById("section-file").style.display = "none";
      document.getElementById("section-project").style.display = "none";
      document.getElementById("section-universal").style.display = "none";
      const emptyState = document.getElementById("empty-state");
      emptyState.style.display = "block";
      emptyState.innerHTML = '<strong>' + label + '</strong><br>' + line1 +
        (line2 ? '<br><span style="font-size:10px;opacity:0.7;">' + line2 + '</span>' : '');
    }

    window.addEventListener("message", ({ data }) => {
      switch (data.type) {
        case "categorized_state":
          renderCategorized(data);
          document.getElementById("record-belief-bar").style.display = "block";
          break;
        case "state":
          // Legacy flat support - treat all as project
          renderCategorized({ file: [], project: data.beliefs, universal: [], totalActive: data.beliefs.length, activeFileName: null });
          document.getElementById("record-belief-bar").style.display = "block";
          break;
        case "toggles_state":
          document.getElementById("toggles-bar").style.display = "flex";
          document.getElementById("toggle-injection").checked = data.injection;
          document.getElementById("toggle-extraction").checked = data.extraction;
          break;
        case "no_workspace":
          renderEmpty("No workspace open", "Open a folder to start", "Tenure tracks beliefs per project");
          document.getElementById("record-belief-bar").style.display = "none";
          break;
        case "disconnected":
          renderEmpty("Not connected", "Tenure isn\\'t running", "<span class=\\"link\\" onclick=\\"post('openInstall')\\">Set up Tenure</span> or start it manually");
          document.getElementById("record-belief-bar").style.display = "none";
          break;
        case "no_token":
          renderEmpty("Not configured", "Set your Tenure token to get started", null);
          document.getElementById("record-belief-bar").style.display = "none";
          break;
        case "error":
          break;
        case "open_form":
          openForm();
          break;
        case "onboarding_prompt":
          document.getElementById("onboarding-banner").style.display = "block";
          document.getElementById("main-header").style.display = "none";
          document.getElementById("beliefs-container").style.display = "none";
          document.getElementById("record-belief-bar").style.display = "none";
          break;
        case "client_status": {
          const section = document.getElementById("clients-section");
          const list = document.getElementById("clients-list");
          if (!section || !list || !data.rows?.length) break;
          section.style.display = "block";
          list.innerHTML = data.rows.map(row => {
            const dotClass = row.connected ? "connected" : "disconnected";
            let actionHtml = "";
            if (!row.connected && row.action) {
              const labels = { auto_config: "Set up", copy_url: "Copy URL", copy_token: "Copy token", docs: "View docs" };
              const label = labels[row.action] ?? "Configure";
              actionHtml = '<span class="client-action" onclick="post(\\'clientAction\\', {clientId:\\'' + esc(row.id) + '\\',action:\\'' + esc(row.action) + '\\'})">' + label + '</span>';
            }
            return '<div class="client-row"><div class="client-dot ' + dotClass + '"></div><span class="client-label">' + esc(row.label) + '</span>' + actionHtml + '</div>';
          }).join("");
          break;
        }
      }
    });

    post("ready");
  </script>
</body>
</html>`;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/^@[^/]+\//, "")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }
}
