import * as vscode from "vscode";
import type { TokenStore } from "./tokenStore.js";
import type { TenureLmProvider } from "./lmProvider.js";

export class OnboardingPanel {
  private static current: OnboardingPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  static open(
    context: vscode.ExtensionContext,
    tokenStore: TokenStore,
    lmProvider: TenureLmProvider | undefined,
    hostApp: import("./hostEnvironment.js").HostApp = "vscode",
  ): void {
    if (OnboardingPanel.current) {
      OnboardingPanel.current.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    new OnboardingPanel(context, tokenStore, lmProvider, hostApp);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tokenStore: TokenStore,
    private readonly lmProvider: TenureLmProvider | undefined,
    private readonly hostApp: import("./hostEnvironment.js").HostApp = "vscode",
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "tenure.onboarding",
      "Tenure Setup",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      },
    );

    OnboardingPanel.current = this;

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      context.subscriptions,
    );

    this.panel.onDidDispose(() => {
      this.disposed = true;
      OnboardingPanel.current = undefined;
    });
  }

  private post(msg: Record<string, unknown>): void {
    if (!this.disposed) {
      this.panel.webview.postMessage(msg);
    }
  }

  private async handleMessage(msg: {
    command: string;
    [k: string]: unknown;
  }): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("tenure");
    const baseUrl = cfg.get<string>("baseUrl", "http://localhost:5757");
    const token = await this.tokenStore.get();

    switch (msg.command) {
      case "ready": {
        if (!token) {
          this.post({ type: "show_token_entry" });
          return;
        }
        await this.checkAndRoute(baseUrl, token);
        break;
      }

      case "saveToken": {
        const t = (msg.token as string | undefined)?.trim();
        if (!t) return;
        await this.tokenStore.set(t);
        await vscode.commands.executeCommand(
          "setContext",
          "tenure.tokenConfigured",
          true,
        );
        await this.checkAndRoute(baseUrl, t);
        break;
      }

      case "saveProvider": {
        if (!token) return;
        const { providerId, apiKey, baseUrlOverride, endpointFlavor } = msg as {
          command: string;
          providerId: string;
          apiKey: string;
          baseUrlOverride?: string;
          endpointFlavor?: string;
        };
        try {
          const body: Record<string, string> = { api_key: apiKey };
          if (baseUrlOverride) body.base_url = baseUrlOverride;
          if (endpointFlavor) body.endpoint_flavor = endpointFlavor;

          const res = await fetch(`${baseUrl}/admin/providers/${providerId}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as {
              error?: { message?: string };
            };
            this.post({
              type: "provider_error",
              message: data?.error?.message ?? `HTTP ${res.status}`,
            });
            return;
          }

          await this.fetchAndSendModels(baseUrl, token, providerId);
        } catch (e) {
          this.post({ type: "provider_error", message: (e as Error).message });
        }
        break;
      }

      case "probeModels": {
        if (!token) return;
        await this.fetchAndSendModels(baseUrl, token, msg.providerId as string);
        break;
      }

      case "validateModel": {
        if (!token) return;
        const { providerId, modelId } = msg as {
          command: string;
          providerId: string;
          modelId: string;
        };
        try {
          const res = await fetch(`${baseUrl}/v1/onboarding/validate-model`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              provider_id: providerId,
              model_id: modelId,
            }),
            signal: AbortSignal.timeout(30_000),
          });
          const data = (await res.json()) as {
            ok?: boolean;
            error?: { message?: string };
          };
          if (!res.ok) {
            this.post({
              type: "model_error",
              message: data?.error?.message ?? `HTTP ${res.status}`,
            });
            return;
          }

          this.lmProvider?.refresh();

          await this.checkOnboardingStatus(baseUrl, token);
        } catch (e) {
          this.post({ type: "model_error", message: (e as Error).message });
        }
        break;
      }

      case "loadQuestions": {
        if (!token) return;
        try {
          const res = await fetch(`${baseUrl}/v1/onboarding/questions`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5_000),
          });
          const data = (await res.json()) as {
            questions: Array<{ id: string; category: string; text: string }>;
          };
          this.post({ type: "questions_loaded", questions: data.questions });
        } catch (e) {
          this.post({ type: "questions_error", message: (e as Error).message });
        }
        break;
      }

      case "submitAnswers": {
        if (!token) return;
        const answers = msg.answers as Array<{
          question_id: string;
          question: string;
          answer: string;
        }>;
        try {
          const res = await fetch(`${baseUrl}/v1/onboarding/complete`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ answers }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) {
            const d = (await res.json().catch(() => ({}))) as {
              error?: { message?: string };
            };
            this.post({
              type: "submit_error",
              message: d?.error?.message ?? `HTTP ${res.status}`,
            });
            return;
          }
          const data = (await res.json()) as {
            ok: boolean;
            belief_count: number;
            beliefs: unknown[];
            draft_id: string | null;
            project_scope: string | null;
            parse_failed?: boolean;
          };
          this.post({ type: "extraction_done", ...data });
        } catch (e) {
          this.post({ type: "submit_error", message: (e as Error).message });
        }
        break;
      }

      case "commitDraft": {
        if (!token) return;
        const { draftId, editedBeliefs } = msg as {
          command: string;
          draftId: string;
          editedBeliefs: unknown[];
        };
        try {
          const res = await fetch(`${baseUrl}/v1/onboarding/commit`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              draft_id: draftId,
              edited_beliefs: editedBeliefs,
            }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            const d = (await res.json().catch(() => ({}))) as {
              error?: { message?: string };
            };
            this.post({
              type: "commit_error",
              message: d?.error?.message ?? `HTTP ${res.status}`,
            });
            return;
          }

          await fetch(`${baseUrl}/admin/config/seeded_agent:vscode`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ value: true }),
            signal: AbortSignal.timeout(5_000),
          }).catch(() => {});

          this.lmProvider?.refresh();
          this.post({ type: "commit_done" });
        } catch (e) {
          this.post({ type: "commit_error", message: (e as Error).message });
        }
        break;
      }

      case "skipOnboarding": {
        if (!token) return;
        await fetch(`${baseUrl}/v1/onboarding/skip`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {});

        await fetch(`${baseUrl}/admin/config/seeded_agent:vscode`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ value: true }),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {});
        this.lmProvider?.refresh();
        this.post({ type: "skipped" });
        break;
      }
    }
  }

  private async checkAndRoute(baseUrl: string, token: string): Promise<void> {
    try {
      const cfgRes = await fetch(`${baseUrl}/admin/config`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (cfgRes.status === 401) {
        this.post({ type: "show_token_entry", error: "Invalid token." });
        return;
      }
      if (!cfgRes.ok) throw new Error(`HTTP ${cfgRes.status}`);

      const cfg = (await cfgRes.json()) as {
        openai_configured: boolean;
        anthropic_configured: boolean;
        default_provider: string | null;
        default_model: string | null;
      };

      const hasProvider = cfg.openai_configured || cfg.anthropic_configured;

      if (!hasProvider) {
        this.post({ type: "show_provider_setup" });
        return;
      }

      if (!cfg.default_model) {
        this.post({
          type: "show_model_picker",
          providerId: cfg.default_provider ?? "openai",
        });
        return;
      }

      await this.checkOnboardingStatus(baseUrl, token);
    } catch (e) {
      this.post({ type: "connection_error", message: (e as Error).message });
    }
  }

  private async checkOnboardingStatus(
    baseUrl: string,
    token: string,
  ): Promise<void> {
    try {
      const cfgRes = await fetch(`${baseUrl}/admin/config`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!cfgRes.ok) throw new Error(`HTTP ${cfgRes.status}`);

      const raw = (await cfgRes.json()) as Record<string, unknown>;
      const alreadySeeded =
        raw["seeded_agent:vscode"] === true ||
        raw["seeded_agent:openwebui"] === true ||
        raw["seeded_agent:openclaw"] === true;

      if (alreadySeeded) {
        this.post({ type: "show_already_complete" });
        return;
      }
    } catch {}
    this.post({ type: "show_questions" });
  }

  private async fetchAndSendModels(
    baseUrl: string,
    token: string,
    providerId: string,
  ): Promise<void> {
    try {
      const res = await fetch(
        `${baseUrl}/v1/onboarding/probe-models/${providerId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        this.post({
          type: "provider_error",
          message: d?.error?.message ?? `Probe failed (HTTP ${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as {
        models: Array<{
          id: string;
          supported: boolean;
          family: string | null;
          reason: string | null;
        }>;
        supports_listing: boolean;
      };
      this.post({
        type: "models_probed",
        models: data.models,
        providerId,
      });
    } catch (e) {
      this.post({
        type: "provider_error",
        message: `Probe error: ${(e as Error).message}`,
      });
    }
  }

  private buildHtml(): string {
    const completeInstructions =
      this.hostApp === "cursor"
        ? `<div class="label">Point Cursor at Tenure</div>
           <p style="font-size:0.85rem;line-height:1.5;margin-bottom:12px">
             Go to <strong>Cursor Settings → Models</strong>, enable <strong>OpenAI API Key</strong>,
             paste your Tenure token as the key, and set the override URL to
             <code>http://localhost:5757/v1</code>.
           </p>`
        : this.hostApp === "windsurf"
        ? `<div class="label">Point Windsurf at Tenure</div>
           <p style="font-size:0.85rem;line-height:1.5;margin-bottom:12px">
             Go to <strong>Windsurf Settings → AI Providers</strong> and add an OpenAI-compatible
             provider with base URL <code>http://localhost:5757/v1</code> and your Tenure token.
           </p>`
        : `<div class="label">Tenure is now available in the VS Code model picker</div>
           <p style="font-size:0.85rem;line-height:1.5;margin-bottom:12px">
             Open Copilot Chat and select a <strong>Tenure:</strong> model from the dropdown,
             or point any client at <code>http://localhost:5757/v1</code>.
           </p>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tenure Setup</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    min-height: 100vh;
    padding: 40px 20px;
  }

  .card {
    width: 100%;
    max-width: 560px;
  }

  h1 {
    font-size: 1.3rem;
    font-weight: 600;
    margin-bottom: 6px;
    color: var(--vscode-foreground);
  }

  .subtitle {
    color: var(--vscode-descriptionForeground);
    font-size: 0.88rem;
    margin-bottom: 28px;
    line-height: 1.5;
  }

  /* Progress dots */
  .progress {
    display: flex;
    gap: 6px;
    margin-bottom: 28px;
    align-items: center;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--vscode-button-secondaryBackground);
    transition: background 0.2s;
  }
  .dot.done { background: var(--vscode-button-background); }
  .dot.current { background: var(--vscode-focusBorder); }
  .step-label {
    font-size: 0.78rem;
    color: var(--vscode-descriptionForeground);
    margin-left: 4px;
  }

  /* Fields */
  .field { margin-bottom: 16px; }
  .field label {
    display: block;
    font-size: 0.82rem;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 5px;
  }
  .field input, .field select {
    width: 100%;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 0.9rem;
    padding: 6px 10px;
    border-radius: 3px;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
  }
  .field input:focus, .field select:focus {
    border-color: var(--vscode-focusBorder);
  }
  .field .hint {
    font-size: 0.76rem;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
    opacity: 0.8;
    line-height: 1.4;
  }

  /* Question cards */
  .question-card {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 14px;
    margin-bottom: 12px;
  }
  .question-text {
    font-size: 0.9rem;
    line-height: 1.5;
    margin-bottom: 8px;
  }
  .question-card textarea {
    width: 100%;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 0.85rem;
    padding: 6px 8px;
    border-radius: 3px;
    resize: vertical;
    min-height: 64px;
    outline: none;
  }
  .question-card textarea:focus {
    border-color: var(--vscode-focusBorder);
  }
  .cat-header {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
    margin-top: 20px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  /* Belief preview */
  .belief-card {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 10px 12px;
    margin-bottom: 8px;
  }
  .belief-name {
    font-size: 0.85rem;
    font-weight: 600;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .badge {
    font-size: 0.7rem;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .belief-content { font-size: 0.82rem; line-height: 1.4; margin-bottom: 3px; }
  .belief-why { font-size: 0.75rem; color: var(--vscode-descriptionForeground); font-style: italic; }
  .belief-card input[type=checkbox] { accent-color: var(--vscode-button-background); }

  /* Buttons */
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 20px; }
  .spacer { flex: 1; }
  .btn {
    padding: 6px 16px;
    border-radius: 3px;
    font-size: 0.88rem;
    cursor: pointer;
    border: none;
    font-family: inherit;
    transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-ghost {
    background: transparent;
    color: var(--vscode-descriptionForeground);
  }
  .btn-ghost:hover { color: var(--vscode-foreground); opacity: 1; }

  /* Model list */
  .model-option {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    margin-bottom: 6px;
    cursor: pointer;
    background: var(--vscode-editor-inactiveSelectionBackground);
  }
  .model-option:hover { border-color: var(--vscode-focusBorder); }
  .model-option.selected { border-color: var(--vscode-button-background); }
  .model-option.unsupported { opacity: 0.5; cursor: not-allowed; }
  .model-id { font-size: 0.85rem; font-family: var(--vscode-editor-font-family); }
  .model-reason { font-size: 0.73rem; color: var(--vscode-errorForeground); }

  /* Status / error */
  .error-msg {
    font-size: 0.83rem;
    color: var(--vscode-errorForeground);
    margin-top: 8px;
    line-height: 1.4;
  }
  .info-msg {
    font-size: 0.83rem;
    color: var(--vscode-descriptionForeground);
    margin-top: 8px;
    line-height: 1.4;
  }
  .spinner {
    font-size: 0.85rem;
    color: var(--vscode-descriptionForeground);
    margin-top: 12px;
  }

  /* Complete screen */
  .complete-box {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 20px;
    margin-top: 16px;
  }
  .complete-box .label { font-size: 0.75rem; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; }
  .complete-box code { font-family: var(--vscode-editor-font-family); font-size: 0.85rem; background: var(--vscode-textBlockQuote-background); padding: 2px 6px; border-radius: 2px; }

  #root { width: 100%; }
</style>
</head>
<body>
<div class="card" id="root"><div class="spinner">Loading…</div></div>
<script>



const vscode = acquireVsCodeApi();
function post(cmd, data) { vscode.postMessage({ command: cmd, ...data }); }




let questions = [];
let answers = [];
let draftBeliefs = [];
let beliefsKept = [];
let draftId = null;
let selectedModel = null;
let selectedProvider = null;
const root = document.getElementById('root');




function render(html) { root.innerHTML = html; }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const CATEGORY_LABELS = {
  communication_style: 'Communication style',
  expertise_calibration: 'Expertise calibration',
  working_style: 'Working style',
  output_preferences: 'Output preferences',
  project_seed: 'Project context',
};




function showTokenEntry(err) {
  render(\`
    <h1>Tenure Setup</h1>
    <p class="subtitle">Enter your Tenure API token to get started.</p>
    <div class="field">
      <label for="tok">API Token</label>
      <input id="tok" type="password" placeholder="mp_…" autocomplete="off">
    </div>
    \${err ? '<div class="error-msg">' + esc(err) + '</div>' : ''}
    <div class="actions">
      <div class="spacer"></div>
      <button class="btn btn-primary" id="tok-btn">Continue</button>
    </div>
  \`);
  const inp = document.getElementById('tok');
  inp?.focus();
  document.getElementById('tok-btn').addEventListener('click', () => {
    const v = document.getElementById('tok')?.value?.trim();
    if (v) post('saveToken', { token: v });
  });
  inp?.addEventListener('keydown', e => { if (e.key === 'Enter') post('saveToken', { token: inp.value.trim() }); });
}




const FLAVORS = [
  { id: 'generic',                label: 'Generic OpenAI',            placeholder: 'https://api.openai.com/v1',  hint: 'Standard OpenAI API or any compatible endpoint.' },
  { id: 'bedrock-access-gateway', label: 'Bedrock Access Gateway',    placeholder: 'http://localhost:5757/api/v1', hint: 'AWS Bedrock Access Gateway. Enables Bedrock prompt caching.' },
  { id: 'litellm',                label: 'LiteLLM',                   placeholder: 'http://localhost:4000',       hint: 'LiteLLM proxy. Cache hints are translated automatically.' },
];

function showProviderSetup(err) {
  render(\`
    <div class="progress">
      <div class="dot current"></div>
      <div class="dot"></div>
      <div class="dot"></div>
      <span class="step-label">Step 1 of 3 — Connect a provider</span>
    </div>
    <h1>Connect a provider</h1>
    <p class="subtitle">Tenure needs an LLM provider to run belief extraction and injection.</p>

    <div class="field">
      <label for="prov-id">Provider</label>
      <select id="prov-id">
        <option value="openai">OpenAI (or compatible)</option>
        <option value="anthropic">Anthropic</option>
      </select>
    </div>

    <div class="field">
      <label for="prov-key">API Key</label>
      <input id="prov-key" type="password" placeholder="sk-…" autocomplete="off">
    </div>

    <div id="openai-extra">
      <div class="field">
        <label for="flavor">Endpoint type</label>
        <select id="flavor">
          \${FLAVORS.map(f => '<option value="' + f.id + '">' + f.label + '</option>').join('')}
        </select>
      </div>
      <div class="field">
        <label for="prov-url">Base URL <span style="opacity:0.5;font-size:0.78rem">(optional for generic)</span></label>
        <input id="prov-url" type="text" placeholder="\${FLAVORS[0].placeholder}">
        <div class="hint" id="flavor-hint">\${FLAVORS[0].hint}</div>
      </div>
    </div>

    \${err ? '<div class="error-msg">' + esc(err) + '</div>' : ''}
    <div class="actions">
      <div class="spacer"></div>
      <button class="btn btn-primary" id="save-prov-btn">Save and continue</button>
    </div>
  \`);

  document.getElementById('prov-id').addEventListener('change', function() {
    document.getElementById('openai-extra').style.display =
      this.value === 'anthropic' ? 'none' : '';
  });

  document.getElementById('flavor').addEventListener('change', function() {
    const f = FLAVORS.find(x => x.id === this.value) ?? FLAVORS[0];
    document.getElementById('prov-url').placeholder = f.placeholder;
    document.getElementById('flavor-hint').textContent = f.hint;
    const lbl = document.getElementById('prov-url').previousElementSibling;
    const optional = this.value === 'generic';
    lbl.innerHTML = 'Base URL ' + (optional
      ? '<span style="opacity:0.5;font-size:0.78rem">(optional for generic)</span>'
      : '<span style="color:var(--vscode-errorForeground);font-size:0.78rem">*</span>');
  });

  document.getElementById('save-prov-btn').addEventListener('click', () => {
    const providerId = document.getElementById('prov-id').value;
    const apiKey = document.getElementById('prov-key').value?.trim();
    const baseUrlOverride = document.getElementById('prov-url')?.value?.trim() || undefined;
    const endpointFlavor = document.getElementById('flavor')?.value || 'generic';

    if (!apiKey) { showProviderSetup('API key is required.'); return; }
    if (providerId === 'openai' && endpointFlavor !== 'generic' && !baseUrlOverride) {
      showProviderSetup('A base URL is required for this endpoint type.');
      return;
    }
    selectedProvider = providerId;
    document.getElementById('save-prov-btn').disabled = true;
    document.getElementById('save-prov-btn').textContent = 'Saving…';
    post('saveProvider', { providerId, apiKey, baseUrlOverride, endpointFlavor });
  });

  document.getElementById('prov-key').focus();
}




function showModelPicker(providerId, models, err) {
  selectedProvider = selectedProvider ?? providerId;
  const supported   = (models ?? []).filter(m => m.supported);
  const unknown     = (models ?? []).filter(m => !m.supported && m.family === null);
  const unsupported = (models ?? []).filter(m => !m.supported && m.family !== null);

  function modelRow(m) {
    const disabled = !m.supported && m.family !== null;
    return \`<div class="model-option\${disabled ? ' unsupported' : ''}" data-id="\${esc(m.id)}" data-disabled="\${disabled}">
      <div style="flex:1">
        <div class="model-id">\${esc(m.id)}</div>
        \${m.reason ? '<div class="model-reason">' + esc(m.reason) + '</div>' : ''}
      </div>
      \${!disabled ? '<span class="badge" id="sel-badge-' + esc(m.id) + '" style="display:none">Selected</span>' : ''}
    </div>\`;
  }

  render(\`
    <div class="progress">
      <div class="dot done"></div>
      <div class="dot current"></div>
      <div class="dot"></div>
      <span class="step-label">Step 2 of 3 — Pick a model</span>
    </div>
    <h1>Pick a default model</h1>
    <p class="subtitle">Used for belief extraction and as your chat default. You can change this in settings later.</p>

    \${models === null ? '<div class="spinner">Probing models…</div>' : \`
      \${supported.length ? '<div class="cat-header">Supported</div>' + supported.map(modelRow).join('') : ''}
      \${unknown.length ? '<div class="cat-header">Unknown family (use at your own risk)</div>' + unknown.map(modelRow).join('') : ''}
      \${unsupported.length ? '<div class="cat-header">Below tier floor</div>' + unsupported.map(modelRow).join('') : ''}
      \${supported.length === 0 && unknown.length === 0 ? '<div class="error-msg">No models returned. Check your credentials or base URL.</div>' : ''}
    \`}

    \${err ? '<div class="error-msg">' + esc(err) + '</div>' : ''}
    <div class="actions">
      <button class="btn btn-ghost" id="back-to-prov">← Back</button>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="validate-btn" disabled>Test and continue</button>
    </div>
  \`);

  document.getElementById('back-to-prov').addEventListener('click', () => showProviderSetup());

  root.querySelectorAll('.model-option:not(.unsupported)').forEach(el => {
    el.addEventListener('click', () => {
      root.querySelectorAll('.model-option').forEach(x => x.classList.remove('selected'));
      root.querySelectorAll('[id^="sel-badge-"]').forEach(x => x.style.display = 'none');
      el.classList.add('selected');
      const badge = document.getElementById('sel-badge-' + el.dataset.id);
      if (badge) badge.style.display = '';
      selectedModel = el.dataset.id;
      document.getElementById('validate-btn').disabled = false;
    });
  });

  document.getElementById('validate-btn').addEventListener('click', () => {
    if (!selectedModel) return;
    document.getElementById('validate-btn').disabled = true;
    document.getElementById('validate-btn').textContent = 'Testing…';
    post('validateModel', { providerId: selectedProvider, modelId: selectedModel });
  });
}




function showQuestions(qs) {
  if (qs) questions = qs;

  
  if (answers.length !== questions.length) {
    answers = questions.map(q => ({ question_id: q.id, question: q.text, answer: '' }));
  }

  
  const cats = {};
  questions.forEach((q, i) => {
    if (!cats[q.category]) cats[q.category] = [];
    cats[q.category].push({ q, i });
  });

  const catHtml = Object.entries(cats).map(([cat, items]) => \`
    <div class="cat-header">\${esc(CATEGORY_LABELS[cat] ?? cat)}</div>
    \${items.map(({ q, i }) => \`
      <div class="question-card">
        <div class="question-text">\${esc(q.text)}</div>
        <textarea id="ans-\${i}" placeholder="Type your answer… (optional)">\${esc(answers[i].answer)}</textarea>
      </div>
    \`).join('')}
  \`).join('');

  render(\`
    <div class="progress">
      <div class="dot done"></div>
      <div class="dot done"></div>
      <div class="dot current"></div>
      <span class="step-label">Step 3 of 3 — Help Tenure understand you</span>
    </div>
    <h1>Help Tenure understand you</h1>
    <p class="subtitle">All questions are optional. The more you share, the better Tenure can calibrate its responses. Press <kbd>Ctrl+Enter</kbd> in any answer to submit.</p>
    \${catHtml}
    <div class="actions">
      <button class="btn btn-ghost" id="skip-all-btn">Skip setup</button>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="submit-btn">Extract and review</button>
    </div>
    <div id="q-error" class="error-msg" style="display:none"></div>
  \`);

  document.getElementById('skip-all-btn').addEventListener('click', () => {
    post('skipOnboarding');
  });

  document.getElementById('submit-btn').addEventListener('click', submitAnswers);

  
  root.querySelectorAll('textarea').forEach(ta => {
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitAnswers();
    });
  });
}

function captureAnswers() {
  questions.forEach((_, i) => {
    const ta = document.getElementById('ans-' + i);
    if (ta) answers[i].answer = ta.value.trim();
  });
}

function submitAnswers() {
  captureAnswers();
  const btn = document.getElementById('submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Extracting…'; }
  post('submitAnswers', { answers });
}




function showReview(data) {
  draftBeliefs = data.beliefs ?? [];
  draftId = data.draft_id;
  beliefsKept = draftBeliefs.map(() => true);

  if (data.parse_failed || draftBeliefs.length === 0) {
    render(\`
      <h1>No beliefs extracted</h1>
      <p class="subtitle">\${data.parse_failed ? 'Extraction could not parse the model output.' : 'No beliefs were found in your answers.'} You can still use Tenure — beliefs will accumulate from your chat sessions.</p>
      <div class="actions">
        <button class="btn btn-ghost" onclick="">← Edit answers</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="finish-btn">Finish setup</button>
      </div>
    \`);
    document.getElementById('finish-btn').addEventListener('click', () => {
      post('commitDraft', { draftId: null, editedBeliefs: [] });
    });
    return;
  }

  const preview = draftBeliefs.map((b, i) => \`
    <div class="belief-card">
      <label class="belief-name">
        <input type="checkbox" data-i="\${i}" checked onchange="toggleBelief(\${i})">
        <span>\${esc(b.canonical_name)}</span>
        <span class="badge">\${esc(b.type)}</span>
        \${(b.scope ?? []).filter(s => s !== 'user:universal').map(s => '<span class="badge">' + esc(s) + '</span>').join('')}
      </label>
      <div class="belief-content">\${esc(b.content)}</div>
      <div class="belief-why">\${esc(b.why_it_matters)}</div>
    </div>
  \`).join('');

  render(\`
    <h1>Review what we learned</h1>
    <p class="subtitle">Uncheck anything you don't want saved. You can edit beliefs later in the sidebar.</p>
    \${data.project_scope ? '<div class="info-msg">Project scope detected: <code>' + esc(data.project_scope) + '</code></div>' : ''}
    <div style="margin-top:16px">\${preview}</div>
    <div class="actions">
      <button class="btn btn-ghost" id="back-q-btn">← Back to questions</button>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="commit-btn">Save to world model</button>
    </div>
    <div id="commit-error" class="error-msg" style="display:none"></div>
  \`);

  document.getElementById('back-q-btn').addEventListener('click', () => showQuestions());
  document.getElementById('commit-btn').addEventListener('click', () => {
    const kept = draftBeliefs.filter((_, i) => beliefsKept[i]);
    document.getElementById('commit-btn').disabled = true;
    document.getElementById('commit-btn').textContent = 'Saving…';
    post('commitDraft', { draftId, editedBeliefs: kept });
  });
}

function toggleBelief(i) {
  const cb = root.querySelector('[data-i="' + i + '"]');
  beliefsKept[i] = cb?.checked ?? false;
}




function showComplete() {
  const cfg = typeof acquireVsCodeApi !== 'undefined' ? {} : {};
  render(\`
    <h1>You're all set</h1>
    <p class="subtitle">Tenure is configured and your beliefs are queued for extraction.</p>
    <div class="complete-box">
      \${completeInstructions}
      <div class="label" style="margin-top:12px">Or point your client directly</div>
      <p style="font-size:0.85rem;margin-bottom:4px"><span style="color:var(--vscode-descriptionForeground)">Base URL:</span> <code>http://localhost:5757/v1</code></p>
      <p style="font-size:0.85rem"><span style="color:var(--vscode-descriptionForeground)">API Key:</span> your Tenure token</p>
    </div>
    <div class="actions" style="margin-top:20px">
      <button class="btn btn-secondary" id="close-btn">Close</button>
    </div>
  \`);
  document.getElementById('close-btn').addEventListener('click', () => {
    
    post('closePanel');
  });
}

function showAlreadyComplete() {
  render(\`
    <h1>Setup already complete</h1>
    <p class="subtitle">Tenure is configured and your world model is active. You can run setup again to add more beliefs or reconfigure your provider.</p>
    <div class="actions">
      <button class="btn btn-primary" id="redo-btn">Run setup again</button>
    </div>
  \`);
  document.getElementById('redo-btn').addEventListener('click', () => {
    post('loadQuestions');
  });
}

function showConnectionError(message) {
  render(\`
    <h1>Connection error</h1>
    <p class="subtitle">Could not reach the Tenure proxy.</p>
    <div class="error-msg">\${esc(message)}</div>
    <p class="info-msg" style="margin-top:8px">Make sure your Tenure proxy is running at the configured base URL (<code>http://localhost:5757</code> by default).</p>
    <div class="actions">
      <button class="btn btn-primary" id="retry-btn">Retry</button>
    </div>
  \`);
  document.getElementById('retry-btn').addEventListener('click', () => post('ready'));
}




window.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'show_token_entry':
      showTokenEntry(data.error);
      break;
    case 'show_provider_setup':
      showProviderSetup(data.error);
      break;
    case 'show_model_picker':
      showModelPicker(data.providerId, null, null);
      post('probeModels', { providerId: data.providerId });
      break;
    case 'models_probed':
      showModelPicker(data.providerId, data.models, null);
      break;
    case 'provider_error':
      showProviderSetup(data.message);
      break;
    case 'model_error': {
      
      const errEl = root.querySelector('#validate-btn');
      if (errEl) {
        errEl.disabled = false;
        errEl.textContent = 'Test and continue';
      }
      const existing = root.querySelector('#model-inline-err');
      if (!existing) {
        const d = document.createElement('div');
        d.id = 'model-inline-err';
        d.className = 'error-msg';
        d.textContent = data.message;
        root.querySelector('.actions')?.before(d);
      }
      break;
    }
    case 'show_questions':
      post('loadQuestions');
      break;
    case 'show_already_complete':
      showAlreadyComplete();
      break;
    case 'questions_loaded':
      showQuestions(data.questions);
      break;
    case 'questions_error':
      root.querySelector('#q-error') && (root.querySelector('#q-error').style.display = '', root.querySelector('#q-error').textContent = data.message);
      break;
    case 'extraction_done':
      showReview(data);
      break;
    case 'submit_error': {
      const btn = document.getElementById('submit-btn');
      if (btn) { btn.disabled = false; btn.textContent = 'Extract and review'; }
      const errEl = document.getElementById('q-error');
      if (errEl) { errEl.style.display = ''; errEl.textContent = data.message; }
      break;
    }
    case 'commit_done':
      showComplete();
      break;
    case 'commit_error': {
      const ceBtn = document.getElementById('commit-btn');
      if (ceBtn) { ceBtn.disabled = false; ceBtn.textContent = 'Save to world model'; }
      const ceErr = document.getElementById('commit-error');
      if (ceErr) { ceErr.style.display = ''; ceErr.textContent = data.message; }
      break;
    }
    case 'skipped':
      showComplete();
      break;
    case 'connection_error':
      showConnectionError(data.message);
      break;
  }
});


post('ready');
</script>
</body>
</html>`;
  }
}
