import type { FastifyInstance } from "fastify";

export function registerAdminUiRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { token?: string } }>("/admin", async (req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    const nonce = (reply.raw as any).cspNonce as string | undefined;
    return reply.send(buildAdminHtml(req.query.token ?? "", nonce));
  });
}

function buildAdminHtml(embeddedToken: string, nonce?: string): string {
  const tokenJS = embeddedToken
    ? JSON.stringify(embeddedToken).replace(/</g, "\\u003c")
    : `new URLSearchParams(location.search).get("token") || localStorage.getItem("mp_token") || ""`;

  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/x-icon" href="/assets/favicon.ico">
<title>Settings · Tenure</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f0f0f; --surface: #1a1a1a; --surface2: #222;
  --border: #2a2a2a; --text: #e8e8e8; --muted: #888;
  --accent: #015054; --danger: #ff6b6b; --ok: #6bffb8;
}
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; }

.nav { display: flex; align-items: center; gap: 0; padding: 0 2rem; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 10; }
.nav-brand { font-size: .875rem; font-weight: 600; color: var(--text); text-decoration: none; margin-right: 1.5rem; padding: .875rem 0; white-space: nowrap; }
.nav-brand:hover { color: var(--accent); }
.nav-links { display: flex; align-items: stretch; gap: 0; }
.nav-link { font-size: .8rem; color: var(--muted); text-decoration: none; padding: .875rem .75rem; border-bottom: 2px solid transparent; transition: color .15s; white-space: nowrap; }
.nav-link:hover { color: var(--text); }
.nav-link.active { color: var(--text); border-bottom-color: var(--accent); }

.main { padding: 2rem; max-width: 680px; margin: 0 auto; }
.section { margin-bottom: 2.5rem; }
.section-title { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 1rem; }

.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem 1.375rem; margin-bottom: .5rem; }
.card-header { display: flex; align-items: center; gap: .75rem; margin-bottom: 1rem; }
.card-title { font-size: .9rem; font-weight: 500; flex: 1; }
.card-status { font-size: .72rem; padding: .2rem .5rem; border-radius: 3px; font-weight: 600; }
.status-ok { background: #0d2a1a; color: var(--ok); }
.status-off { background: var(--surface2); color: var(--muted); }

.field { margin-bottom: .875rem; }
.field:last-child { margin-bottom: 0; }
.field label { display: flex; font-size: .75rem; color: var(--muted); margin-bottom: .3rem; }
.field input:not([type=checkbox]), .field select { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-family: inherit; font-size: .85rem; padding: .55rem .75rem; outline: none; appearance: none; -webkit-appearance: none; }
.field input:focus, .field select:focus { border-color: var(--accent); }
.field input[type=password] { font-family: monospace; letter-spacing: .05em; }
.field input[type=number] { width: 140px; }
.field select { cursor: pointer; }
.field select option { background: var(--surface2); }
.field .hint { font-size: .75rem; color: var(--muted); margin-top: .3rem; line-height: 1.4; opacity: .75; }

.row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.row .field { flex: 1; min-width: 0; margin-bottom: 0; }

.btn { padding: .35rem .75rem; border-radius: 5px; font-size: .8rem; cursor: pointer; border: 1px solid var(--border); font-family: inherit; color: var(--muted); background: transparent; transition: all .15s; }
.btn:hover { color: var(--text); border-color: #444; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover { opacity: .85; color: #fff; }
.btn-danger { color: var(--danger); border-color: transparent; }
.btn-danger:hover { border-color: var(--danger); }

.model-select { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-family: inherit; font-size: .85rem; padding: .55rem .75rem; outline: none; cursor: pointer; appearance: none; -webkit-appearance: none; }
.model-select:focus { border-color: var(--accent); }
.model-select option { background: var(--surface2); }

.advanced-toggle { display: flex; align-items: center; gap: .5rem; font-size: .78rem; color: var(--muted); cursor: pointer; background: none; border: none; font-family: inherit; padding: 0; margin-bottom: 1rem; }
.advanced-toggle:hover { color: var(--text); }
.advanced-content { display: none; }
.advanced-content.open { display: block; }

.screen { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 2rem; }
.screen-inner { width: 100%; max-width: 380px; }
.screen-inner h1 { font-size: 1.1rem; font-weight: 500; margin-bottom: .375rem; }
.screen-inner p { color: var(--muted); font-size: .875rem; margin-bottom: 1.5rem; line-height: 1.5; }
.screen-inner label { display: block; font-size: .8rem; color: var(--muted); margin-bottom: .375rem; }
.screen-inner input { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-family: monospace; font-size: .9rem; padding: .75rem 1rem; outline: none; margin-bottom: .75rem; }
.screen-inner input:focus { border-color: var(--accent); }
.err-msg { color: var(--danger); font-size: .8rem; margin-bottom: .75rem; }
.loading { text-align: center; padding: 4rem 2rem; color: var(--muted); font-size: .875rem; }

.toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: .6rem 1rem; border-radius: 6px; font-size: .8rem; z-index: 200; pointer-events: none; animation: slideup .2s ease; }
.toast-ok    { background: #0d2a1a; border: 1px solid var(--ok);     color: var(--ok); }
.toast-error { background: #2a1212; border: 1px solid var(--danger); color: var(--danger); }
@keyframes slideup { from { opacity: 0; transform: translateY(.4rem); } to { opacity: 1; transform: none; } }
.logo { display: block; margin: 0 auto 2rem; width: 120px; }
.badge { display: inline-block; font-size: .68rem; padding: .15rem .45rem; border-radius: 3px; font-weight: 600; white-space: nowrap; }
.token-status-active { background: #0d2a1a; color: #4dda8a; }
.token-status-expired { background: #2a1f0d; color: #d4a84b; }
.token-status-revoked { background: #2a0d0d; color: #cc5555; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; width: 100%; max-width: 760px; max-height: 85vh; overflow-y: auto; padding: 1.5rem; }
.modal h2 { font-size: .95rem; font-weight: 500; margin-bottom: 1.25rem; }
.modal-footer { display: flex; justify-content: flex-end; gap: .625rem; margin-top: 1.25rem; border-top: 1px solid var(--border); padding-top: 1rem; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.form-grid-col { min-width: 0; }
.cap-list { display: flex; flex-direction: column; gap: .5rem; }
.checkbox-row { display: flex; align-items: flex-start; gap: .6rem; font-size: .85rem; cursor: pointer; margin-bottom: 0; }
.checkbox-row input[type=checkbox] { position: absolute; opacity: 0; width: 1px; height: 1px; }
.checkbox-box { display: inline-block; width: 18px; min-width: 18px; max-width: 18px; height: 18px; min-height: 18px; flex: 0 0 18px; margin-top: .15rem; border-radius: 4px; border: 1px solid var(--border); background: var(--surface2); position: relative; vertical-align: top; }
.checkbox-row input[type=checkbox]:checked + .checkbox-box { background: var(--accent); border-color: var(--accent); }
.checkbox-row input[type=checkbox]:focus-visible + .checkbox-box { outline: 2px solid rgba(1,80,84,.35); outline-offset: 2px; }
.checkbox-row input[type=checkbox]:checked + .checkbox-box::after { content: "✓"; position: absolute; left: 3px; top: -1px; font-size: 12px; line-height: 16px; color: #fff; font-weight: 700; }
.checkbox-content { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.field-error { color: var(--danger); font-size: .78rem; margin-top: .35rem; }
.input-error { border-color: var(--danger) !important; }
.token-result-list { display: flex; flex-direction: column; gap: .65rem; margin-top: .5rem; }
.token-result { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: .65rem; }
.token-result-name { font-size: .8rem; color: var(--muted); margin-bottom: .4rem; }
.token-result-row { display: flex; gap: .5rem; align-items: center; }
.token-result-value { display: block; flex: 1; overflow-x: auto; white-space: nowrap; background: #111; padding: .45rem .55rem; border-radius: 4px; font-size: .76rem; color: var(--text); }
.token-result-warn { font-size: .75rem; color: var(--muted); }
@media (max-width: 720px) {
  .form-grid { grid-template-columns: 1fr; }
  .token-result-row { flex-direction: column; align-items: stretch; }
}
</style>
</head>
<body>
<div id="app"><div class="loading">Loading…</div></div>
<script${nonceAttr}>
const STORAGE_KEY = "mp_token";
let token = ${tokenJS};

const PROVIDERS = ["openai", "anthropic"];

let cfg = null;      
let providers = [];   
let models = {};      
let availableProjectScopes = [];
let tokens = [];
let agentTokens = [];
let tokenModalOpen = false;
let tokenModalMode = "client";
let tokenModalResults = [];
let tokenForm = {
  name: "",
  caps: [],
  scopesInput: "",
  scopes: [],
  ttlDays: ""
};
let tokenFormErrors = {
  name: "",
  caps: ""
};

const CLIENT_CAPS = [
  "chat",
  "beliefs:read",
  "beliefs:write",
  "extraction",
  "injection"
];

const AGENT_CAPS = ["chat", "extraction", "injection"];

const TOKEN_LABELS = {
  chat: "Chat completions",
  "beliefs:read": "Read beliefs",
  "beliefs:write": "Manual belief CRUD",
  extraction: "Auto-extract beliefs",
  injection: "Inject beliefs into context"
};

const TOKEN_HINTS = {
  chat: "Use /v1/chat/completions and /v1/messages",
  "beliefs:read": "List, search, and inspect beliefs",
  "beliefs:write": "Create, update, delete beliefs via API",
  extraction: "Auto-extract beliefs from chat turns",
  injection: "Inject beliefs into chat context"
};

const app = document.getElementById("app");

const FLAVORS = [
  {
    id: "generic",
    label: "Generic OpenAI",
    urlPlaceholder: "https://api.openai.com/v1",
    hint: "Standard OpenAI API or any compatible endpoint without special caching support.",
  },
  {
    id: "bedrock-access-gateway",
    label: "Bedrock Access Gateway",
    urlPlaceholder: "http://localhost:5757/api/v1",
    hint: "AWS Bedrock Access Gateway. Enables Bedrock prompt caching, cutting input costs by up to 90%.",
  },
  {
    id: "litellm",
    label: "LiteLLM",
    urlPlaceholder: "http://localhost:4000",
    hint: "LiteLLM proxy. If pointed at Bedrock, prompt caching hints are translated automatically.",
  },
];

function flavorById(id) {
  return FLAVORS.find(f => f.id === id) ?? FLAVORS;
}

async function apiFetch(method, path, body) {
  const init = { method, headers: { Authorization: \`Bearer \${token}\` } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    localStorage.removeItem(STORAGE_KEY);
    showTokenScreen("Token rejected.");
    throw new Error("unauthorized");
  }
  return res;
}

async function init() {
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const [cfgRes, provRes] = await Promise.all([
      apiFetch("GET", "/admin/config"),
      apiFetch("GET", "/admin/providers"),
    ]);
    if (!cfgRes.ok) throw new Error(\`Config load failed (HTTP \${cfgRes.status})\`);
    if (!provRes.ok) throw new Error(\`Providers load failed (HTTP \${provRes.status})\`);
    cfg = await cfgRes.json();
    providers = (await provRes.json()).providers ?? [];
    await Promise.all([loadTokens(), loadProjectScopes()]);
    render();
    loadPersona();
    loadErrors();
  } catch (e) {
    if (e.message !== "unauthorized") {
      app.innerHTML = \`<div class="loading">
        <p style="color:var(--danger);margin-bottom:1rem">\${esc(e.message)}</p>
        <button class="btn" data-action="retry">Retry</button>
      </div>\`;
    }
  }
}

function navHtml() {
  return \`<nav class="nav">
    <a class="nav-brand" href="/beliefs">
      <img src="/assets/tenure-logo.png" alt="Tenure" height="24" style="vertical-align:middle">
    </a>
    <div class="nav-links">
      <a class="nav-link" href="/beliefs">World Model</a>
      <a class="nav-link active" href="/admin">Settings</a>
      <a class="nav-link" href="/audit">Audit</a> 
      <a class="nav-link" href="/onboarding">Onboarding</a>
    </div>
  </nav>\`;
}

function render() {
  const providerCards = providers.map(providerCard).join("");

  const defaultProvider = cfg.default_provider ?? "openai";
  const defaultModel = cfg.default_model ?? "";

  app.innerHTML = \`
    \${navHtml()}
    <div class="main">

      <div class="section">
        <div class="section-title">Providers</div>
        \${providerCards}
      </div>

      <div class="section">
        <div class="section-title">Default Model</div>
        <div class="card">
          <div class="field">
            <label>Model</label>
            <div class="row" style="align-items:flex-start">
              <div class="field" style="flex:1;margin:0">
                <select id="model-select" class="model-select" style="width:100%">
                  <option value="" disabled \${!defaultModel ? "selected" : ""}>— select a model —</option>
                  \${defaultModel ? \`<option value="\${esc(defaultModel)}" selected>\${esc(defaultModel)}</option>\` : ""}
                </select>
              </div>
              <button class="btn" data-action="load-models">Browse</button>
              <button class="btn btn-primary" data-action="save-model">Save</button>
            </div>
            <div class="hint">Used for belief extraction and onboarding. Must meet the minimum tier floor.</div>
          </div>
        </div>
      </div>

       <div class="section">
        <div class="section-title">Extraction</div>
        <div class="card">
      <div class="field">
        <label>Belief extraction</label>
        <div class="hint">When off, Tenure still injects your existing beliefs into every
        session but stops extracting new ones from conversations.</div>
        <div style="display:flex;align-items:center;gap:.75rem;margin-top:.625rem">
          <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;flex-shrink:0">
            <input type="checkbox" id="extraction-enabled"
              \${cfg.extraction_enabled !== false ? "checked" : ""}
              data-action="set-extraction-enabled"
              style="opacity:0;width:0;height:0;position:absolute">
            <span id="extraction-track" style="
              position:absolute;inset:0;border-radius:11px;transition:background .2s;
              background:\${cfg.extraction_enabled !== false ? 'var(--ok)' : 'var(--border)'};
            "></span>
            <span id="extraction-thumb" style="
              position:absolute;top:3px;width:16px;height:16px;border-radius:50%;
              background:#fff;transition:transform .2s;
              transform:translateX(\${cfg.extraction_enabled !== false ? '21px' : '3px'});
            "></span>
          </label>
          <span id="extraction-label" style="font-size:.85rem;color:\${cfg.extraction_enabled !== false ? 'var(--ok)' : 'var(--muted)'}">
            \${cfg.extraction_enabled !== false ? "Enabled" : "Paused"}
          </span>
        </div>
      </div>
      <div class="field" style="margin-top:1rem">
        <label>Belief injection</label>
        <div class="hint">When off, Tenure stops injecting your world model into sessions.
        The model has no context about you. Extraction still runs unless also paused.</div>
        <div style="display:flex;align-items:center;gap:.75rem;margin-top:.625rem">
          <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;flex-shrink:0">
            <input type="checkbox" id="injection-enabled"
              \${cfg.injection_enabled !== false ? "checked" : ""}
              data-action="set-injection-enabled"
              style="opacity:0;width:0;height:0;position:absolute">
            <span id="injection-track" style="
              position:absolute;inset:0;border-radius:11px;transition:background .2s;
              background:\${cfg.injection_enabled !== false ? 'var(--ok)' : 'var(--border)'};
            "></span>
            <span id="injection-thumb" style="
              position:absolute;top:3px;width:16px;height:16px;border-radius:50%;
              background:#fff;transition:transform .2s;
              transform:translateX(\${cfg.injection_enabled !== false ? '21px' : '3px'});
            "></span>
          </label>
          <span id="injection-label" style="font-size:.85rem;color:\${cfg.injection_enabled !== false ? 'var(--ok)' : 'var(--muted)'}">
            \${cfg.injection_enabled !== false ? "Enabled" : "Paused"}
          </span>
        </div>
      </div>
        </div>
        </div>

        <div class="section">
          <div class="section-title">Scope</div>
          <div class="card">
            <div class="field">
              <label>Automatic scope detection</label>
              <div class="hint">When enabled, Tenure detects the domain from your first message each session.
              When disabled, scope is only set via explicit <code>!scope</code> commands or client metadata.</div>
              <div style="display:flex;align-items:center;gap:.75rem;margin-top:.625rem">
                <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;flex-shrink:0">
                  <input type="checkbox" id="scope-auto-detect"
                    \${cfg.scope_auto_detect !== false ? "checked" : ""}
                    data-action="set-scope-auto-detect"
                    style="opacity:0;width:0;height:0;position:absolute">
                  <span id="scope-auto-track" style="
                    position:absolute;inset:0;border-radius:11px;transition:background .2s;
                    background:\${cfg.scope_auto_detect !== false ? "var(--ok)" : "var(--border)"};
                  "></span>
                  <span id="scope-auto-thumb" style="
                    position:absolute;top:3px;width:16px;height:16px;border-radius:50%;
                    background:#fff;transition:transform .2s;
                    transform:translateX(\${cfg.scope_auto_detect !== false ? "21px" : "3px"});
                  "></span>
                </label>
                <span id="scope-auto-label" style="font-size:.85rem;color:\${cfg.scope_auto_detect !== false ? "var(--ok)" : "var(--muted)"}">
                 \${cfg.scope_auto_detect !== false ? "Auto-detect" : "Explicit only"}
                </span>
              </div>
            </div>
          </div>
        </div>

      <div class="section">
        <div class="section-title">Your Persona</div>
        <div class="card">
          <div class="field">
            <label>Standing context</label>
            <div class="hint">This is injected into every session as standing context about you.</div>
            <div id="persona-universal" style="margin-top:.5rem;font-size:.82rem;color:var(--text);line-height:1.5;min-height:2rem;background:var(--surface2);border-radius:5px;padding:.65rem .75rem;white-space:pre-wrap">Loading…</div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:.75rem">
            <button class="btn btn-primary" data-action="regenerate-persona">Regenerate</button>
          </div>
        </div>
      </div>
       
      

      <div class="section">
        <button class="advanced-toggle" data-action="toggle-advanced">
          <span id="adv-arrow">▶</span> Advanced
        </button>
        <div class="advanced-content" id="adv-content">
          <div class="card">
            <div class="field">
              <label>Context budget (tokens)</label>
              <input id="cfg-token-target" type="number" min="100" max="2000" step="50"
                value="\${cfg.always_on_token_target ?? 400}">
              <div class="hint">How many tokens to reserve for injected beliefs per request. Lower values mean less context but faster responses. Default: 400.</div>
            </div>
            <div class="field">
              <label>Verified models only</label>
              <div class="hint">When off, unverified model families are allowed. Disable if running a self-hosted model.</div>
              <div style="display:flex;align-items:center;gap:.75rem;margin-top:.5rem">
                <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;flex-shrink:0">
                  <input type="checkbox" id="strict-model-tiers"
                    \${cfg.strict_model_tiers !== false ? "checked" : ""}
                    data-action="set-strict-model-tiers"
                    style="opacity:0;width:0;height:0;position:absolute">
                  <span id="strict-tiers-track" style="
                    position:absolute;inset:0;border-radius:11px;transition:background .2s;
                    background:\${cfg.strict_model_tiers !== false ? 'var(--ok)' : 'var(--border)'};
                  "></span>
                  <span id="strict-tiers-thumb" style="
                    position:absolute;top:3px;width:16px;height:16px;border-radius:50%;
                    background:#fff;transition:transform .2s;
                    transform:translateX(\${cfg.strict_model_tiers !== false ? '21px' : '3px'});
                  "></span>
                </label>
                <span id="strict-tiers-label" style="font-size:.85rem;color:\${cfg.strict_model_tiers !== false ? 'var(--ok)' : 'var(--muted)'}">
                  \${cfg.strict_model_tiers !== false ? "Enforced" : "Off"}
                </span>
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:1rem">
              <button class="btn btn-primary" data-action="save-advanced">Save</button>
            </div>
          </div>
        </div>
      </div>


        <div class="section">
          <div class="section-title">API Token</div>
          <div class="card">
            <div class="field">
              <label>Token rotation</label>
              <div class="hint">Generates a new token immediately. Your current session will end. Copy the new token before closing this dialog.</div>
            </div>
            <div style="display:flex;justify-content:flex-end">
              <button class="btn btn-danger" data-action="rotate-token">Rotate token…</button>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Access Tokens</div>

          <div class="card">
            <div class="field">
              <label>Client tokens</label>
              <div class="hint">
                For VSCode, OpenWebUI, CI, or any client tool. Full belief read/write access.
              </div>
            </div>
            <div style="margin-top:.75rem">
              \${renderTokenRows(tokens, "No active client tokens.")}
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:.75rem">
              <button class="btn btn-primary" data-action="open-token-modal" data-token-mode="client">Generate client token</button>
            </div>
          </div>

          <div class="card" style="margin-top:.5rem">
            <div class="field">
              <label>Agent tokens</label>
              <div class="hint">
                For agent tools. Limited to chat, extraction, and injection. Cannot read or write beliefs directly.
              </div>
            </div>
            <div style="margin-top:.75rem">
              \${renderTokenRows(agentTokens, "No active agent tokens.")}
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:.75rem">
              <button class="btn btn-primary" data-action="open-token-modal" data-token-mode="agent">Generate agent token</button>
            </div>
          </div>
        </div>

      <div class="section">
        <div class="section-title">Error Log</div>
        <div class="card">
          <div class="field">
            <label>Recent errors</label>
            <div class="hint">If you're experiencing issues, copy these when filing a bug report.</div>
          </div>
          <div id="error-log" style="margin-top:.75rem;font-size:.8rem;color:var(--muted)">Loading...</div>
          <div style="display:flex;justify-content:flex-end;margin-top:.75rem;gap:.5rem">
            <button class="btn" data-action="copy-errors">Copy to clipboard</button>
            <button class="btn" data-action="load-errors">Refresh</button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Backup & Restore</div>
        <div class="card">
          <div class="field">
            <label>Export</label>
            <div class="hint">Download an encrypted archive of your entire world model.</div>
          </div>
          <div id="backup-preview" style="margin-top:.75rem;font-size:.8rem;color:var(--muted);display:none">
            <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:.75rem">
              <span id="bp-beliefs"></span>
              <span id="bp-persona"></span>
            </div>
          </div>
          <div class="row" style="margin-top:.75rem">
            <div class="field" style="flex:1;margin:0">
              <input id="export-passphrase" type="password" placeholder="Passphrase (min 8 characters)" autocomplete="off">
            </div>
            <button class="btn" data-action="load-backup-preview">Preview</button>
            <button class="btn btn-primary" data-action="export-backup">Export</button>
          </div>
        </div>
        <div class="card" style="margin-top:.5rem">
          <div class="field">
            <label>Import</label>
            <div class="hint">Restore from a previously exported archive. Existing beliefs with the same ID are skipped by default.</div>
          </div>
          <div class="field" style="margin-top:.75rem">
            <input id="import-file" type="file" accept=".enc" style="font-size:.8rem">
          </div>
          <div class="row" style="margin-top:.5rem">
            <div class="field" style="flex:1;margin:0">
              <input id="import-passphrase" type="password" placeholder="Passphrase" autocomplete="off">
            </div>
            <button class="btn btn-primary" data-action="import-backup">Import</button>
          </div>
          <div style="display:flex;gap:.75rem;margin-top:.75rem">
            <label style="font-size:.75rem;color:var(--muted);display:flex;align-items:center;gap:.35rem">
              <input type="checkbox" id="import-skip-existing" checked> Skip existing beliefs
            </label>
            <label style="font-size:.75rem;color:var(--muted);display:flex;align-items:center;gap:.35rem">
              <input type="checkbox" id="import-config" checked> Restore settings
            </label>
          </div>
          <div id="import-result" style="margin-top:.75rem;font-size:.8rem;color:var(--ok);display:none"></div>
        </div>
      </div>

    </div>
  \`;

  const sel = document.getElementById("model-select");
  if (sel && models[defaultProvider]?.length) populateModelSelect(defaultProvider);
}

function providerCard(p) {
  const configured = p.configured;
  const isOpenAI = p.id === "openai";
  const currentFlavor = p.endpoint_flavor ?? "generic";
  const flavor = flavorById(currentFlavor);

  return \`
    <div class="card" id="card-\${esc(p.id)}">
      <div class="card-header">
        <span class="card-title">\${esc(providerLabel(p))}</span>
        <span class="card-status \${configured ? "status-ok" : "status-off"}">\${configured ? "Connected" : "Not connected"}</span>
      </div>
      <div class="field">
        <label>API Key</label>
        <input id="key-\${esc(p.id)}" type="password"
          placeholder="\${configured ? "••••••••  (set — enter new key to replace)" : "Paste API key…"}"
          autocomplete="off">
      </div>
      \${isOpenAI ? \`
      <div class="field">
        <label>Endpoint type</label>
        <select id="flavor-\${esc(p.id)}" data-action="on-admin-flavor-change" data-provider-id="\${esc(p.id)}">
          \${FLAVORS.map(f => \`<option value="\${f.id}" \${f.id === currentFlavor ? "selected" : ""}>\${f.label}</option>\`).join("")}
        </select>
      </div>
      <div class="field">
        <label id="url-label-\${esc(p.id)}">Base URL\${currentFlavor !== "generic" ? ' <span style="color:var(--danger);font-size:.75rem">*</span>' : ' <span style="opacity:.5;font-size:.75rem">(optional)</span>'}</label>
        <input id="url-\${esc(p.id)}" type="text"
          placeholder="\${esc(flavor.urlPlaceholder)}"
          value="\${esc(p.base_url ?? "")}">
        <div class="hint" id="flavor-hint-\${esc(p.id)}">\${esc(flavor.hint)}</div>
      </div>\` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:.25rem">
        \${configured ? \`<button class="btn btn-danger" data-action="remove-provider" data-provider-id="\${esc(p.id)}">Disconnect</button>\` : ""}
        <button class="btn btn-primary" data-action="save-provider" data-provider-id="\${esc(p.id)}">Save</button>
      </div>
    </div>
  \`;
}

function onAdminFlavorChange(providerId, flavorId) {
  const flavor = flavorById(flavorId);
  const urlInput = document.getElementById(\`url-\${providerId}\`);
  const urlLabel = document.getElementById(\`url-label-\${providerId}\`);
  const hint = document.getElementById(\`flavor-hint-\${providerId}\`);

  if (urlInput) urlInput.placeholder = flavor.urlPlaceholder;
  if (hint) hint.textContent = flavor.hint;
  if (urlLabel) {
    const optional = flavorId === "generic";
    urlLabel.innerHTML = \`Base URL\${optional
      ? ' <span style="opacity:.5;font-size:.75rem">(optional)</span>'
      : ' <span style="color:var(--danger);font-size:.75rem">*</span>'}\`;
  }
}

function providerLabel(p) {
  if (p.id === "anthropic") return "Anthropic";
  if (p.id === "openai") {
    const flavor = flavorById(p.endpoint_flavor ?? "generic");
    return flavor.id === "generic" ? "OpenAI (or compatible endpoint)" : flavor.label;
  }
  return p.id;
}

async function loadModels() {
  const provider = cfg.default_provider ?? "openai";
  const p = providers.find(x => x.id === provider);
  if (!p?.configured) {
    toast(\`No \${provider} credentials configured\`, "error");
    return;
  }

  const sel = document.getElementById("model-select");
  if (sel) { sel.innerHTML = '<option disabled selected>Loading…</option>'; }

  try {
    const res = await apiFetch("GET", \`/v1/onboarding/probe-models/\${provider}\`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    models[provider] = data.models ?? [];
    populateModelSelect(provider);
  } catch (e) {
    toast(e.message, "error");
    if (sel) sel.innerHTML = \`<option value="\${esc(cfg.default_model ?? "")}" selected>\${esc(cfg.default_model ?? "— select a model —")}</option>\`;
  }
}

function populateModelSelect(provider) {
  const sel = document.getElementById("model-select");
  if (!sel) return;
  const list = models[provider] ?? [];
  const supported   = list.filter(m => m.supported);
  const unknown     = list.filter(m => !m.supported && m.family === null);
  const unsupported = list.filter(m => !m.supported && m.family !== null);
  const current = cfg.default_model ?? "";
  const opt = (m, disabled) =>
    \`<option value="\${esc(m.id)}"\${m.id === current ? " selected" : ""}\${disabled ? " disabled" : ""}>\${esc(m.id)}\${disabled ? \` — \${esc(m.reason ?? "below floor")}\` : ""}</option>\`;
  sel.innerHTML = \`
    <option value="" disabled \${!current ? "selected" : ""}>— select a model —</option>
    \${supported.length   ? \`<optgroup label="Supported">\${supported.map(m => opt(m, false)).join("")}</optgroup>\` : ""}
    \${unknown.length     ? \`<optgroup label="Unknown family (use at your own risk)">\${unknown.map(m => opt(m, false)).join("")}</optgroup>\` : ""}
    \${unsupported.length ? \`<optgroup label="Below tier floor (disabled)">\${unsupported.map(m => opt(m, true)).join("")}</optgroup>\` : ""}
  \`;
}

async function saveModel() {
  const sel = document.getElementById("model-select");
  const modelId = sel?.value;
  if (!modelId) { toast("Select a model first", "error"); return; }

  const provider = cfg.default_provider ?? "openai";
  try {
    const res = await apiFetch("POST", "/v1/onboarding/validate-model", { provider_id: provider, model_id: modelId });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    cfg.default_model = modelId;
    toast("Default model saved", "ok");
    render();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function saveProvider(id) {
  const key     = document.getElementById(\`key-\${id}\`)?.value?.trim();
  const urlEl   = document.getElementById(\`url-\${id}\`);
  const flavorEl = document.getElementById(\`flavor-\${id}\`);
  const url     = urlEl?.value?.trim() || undefined;
  const flavor  = flavorEl?.value ?? "generic";

  if (!key) { toast("API key is required", "error"); return; }

  if (id === "openai" && flavor !== "generic" && !url) {
    toast("A base URL is required for this endpoint type", "error");
    return;
  }

  try {
    const body = {
      api_key: key,
      ...(url !== undefined ? { base_url: url } : {}),
      ...(id === "openai" ? { endpoint_flavor: flavor } : {}),
    };
    const res = await apiFetch("PUT", \`/admin/providers/\${id}\`, body);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    toast(\`\${providerLabel({ id, endpoint_flavor: flavor })} saved\`, "ok");
    await init();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function removeProvider(id) {
  const p = providers.find(x => x.id === id);
  if (!confirm(\`Disconnect \${providerLabel(p ?? { id })}? This will remove the stored API key.\`)) return;
  try {
    const res = await apiFetch("DELETE", \`/admin/providers/\${id}\`);
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    toast(\`Disconnected\`, "ok");
    await init();
  } catch (e) {
    toast(e.message, "error");
  }
}

function toggleAdvanced() {
  const content = document.getElementById("adv-content");
  const arrow   = document.getElementById("adv-arrow");
  if (!content || !arrow) return;
  const open = content.classList.toggle("open");
  arrow.textContent = open ? "▼" : "▶";
}

async function saveAdvanced() {
  const target = parseInt(document.getElementById("cfg-token-target")?.value ?? "", 10);

  if (isNaN(target)) { toast("Invalid values", "error"); return; }

  try {
    await Promise.all([
      apiFetch("PUT", "/admin/config/always_on_token_target", { value: target }),
    ]);
    cfg.always_on_token_target = target;
    toast("Advanced settings saved", "ok");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function setExtractionEnabled(enabled) {
  try {
    const res = await apiFetch("PUT", "/admin/config/extraction_enabled", {
      value: enabled,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    const track = document.getElementById("extraction-track");
    const thumb = document.getElementById("extraction-thumb");
    const label = document.getElementById("extraction-label");

    if (track) track.style.background = enabled ? "var(--ok)" : "var(--border)";
    if (thumb) thumb.style.transform = \`translateX(\${enabled ? "21px" : "3px"})\`;
    if (label) {
      label.textContent = enabled ? "Enabled" : "Paused";
      label.style.color = enabled ? "var(--ok)" : "var(--muted)";
    }

    toast(
      enabled ? "Extraction enabled" : "Extraction paused - existing beliefs still injected",
      "ok",
    );
  } catch (e) {
    toast(e.message, "error");
    const cb = document.getElementById("extraction-enabled");
    if (cb) cb.checked = !enabled;
  }
}

async function loadTokens() {
  try {
    const res = await apiFetch("GET", "/admin/tokens");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    const all = data.tokens ?? [];
    tokens = all.filter(t => t.kind === "client");
    agentTokens = all.filter(t => t.kind === "agent");
  } catch {
    tokens = [];
    agentTokens = [];
  }
}

async function loadProjectScopes() {
  try {
    const res = await apiFetch("GET", "/v1/scopes/projects");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    availableProjectScopes = data.scopes ?? [];
  } catch {
    availableProjectScopes = [];
  }
}

function getTokenStatus(t) {
  if (t.revoked_at) return "revoked";
  if (t.expires_at && new Date(t.expires_at).getTime() <= Date.now()) {
    return "expired";
  }
  return "active";
}

function tokenStatusLabel(status) {
  if (status === "revoked") return "Revoked";
  if (status === "expired") return "Expired";
  return "Active";
}

function openTokenModal(mode) {
  tokenModalMode = mode;
  tokenModalOpen = true;
  tokenForm = {
    name: "",
    caps: [],
    scopesInput: "",
    scopes: [],
    ttlDays: ""
  };
  tokenFormErrors = {
    name: "",
    caps: ""
  };
  tokenModalResults = [];
  renderTokenModal();
}

function closeTokenModal() {
  tokenModalOpen = false;
  const overlay = document.querySelector(".overlay");
  if (overlay) overlay.remove();
}

function toggleTokenCap(cap) {
  if (tokenFormErrors.caps) tokenFormErrors.caps = "";
  const prev = tokenForm.caps.slice();
  const has = prev.includes(cap);

  if (has) {
    if (cap === "chat") {
      tokenForm.caps = prev.filter(
        c => c !== "chat" && c !== "extraction" && c !== "injection"
      );
    } else {
      tokenForm.caps = prev.filter(c => c !== cap);
    }
  } else {
    if (cap === "extraction" || cap === "injection") {
      const next = new Set(prev);
      next.add(cap);
      next.add("chat");
      tokenForm.caps = [...next];
    } else {
      tokenForm.caps = [...prev, cap];
    }
  }

  renderTokenModal();
}



async function copyTokenValue(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast("Copied to clipboard", "ok");
  } catch {
    toast("Couldn't copy to clipboard", "error");
  }
}

async function submitTokenCreate() {
  const trimmedName = tokenForm.name.trim();
  let hasError = false;

  tokenFormErrors = {
    name: "",
    caps: ""
  };

  if (!trimmedName) {
    tokenFormErrors.name = "Enter a token name.";
    hasError = true;
  }
  if (tokenForm.caps.length === 0) {
    tokenFormErrors.caps = "Select at least one capability.";
    hasError = true;
  }
  if (hasError) {
    renderTokenModal();
    return;
  }

  try {
    const endpoint =
      tokenModalMode === "client"
        ? "/admin/tokens/client"
        : "/admin/tokens/agent";

    const res = await apiFetch("POST", endpoint, {
      name: trimmedName,
      capabilities: tokenForm.caps,
      project_scopes: tokenForm.scopes.length > 0 ? tokenForm.scopes : null,
      ttl_days: tokenForm.ttlDays ? parseInt(tokenForm.ttlDays, 10) : null
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    tokenModalResults = [
      { name: trimmedName, token: data.token },
      ...tokenModalResults
    ];

    tokenForm = {
      name: "",
      caps: [],
      scopesInput: "",
      scopes: [],
      ttlDays: ""
    };

    await loadTokens();
    render();
    renderTokenModal();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function revokeToken(id) {
  if (!confirm("Revoke this token? Any clients using it will immediately lose access.")) return;
  try {
    const res = await apiFetch("DELETE", \`/admin/tokens/\${id}\`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    toast("Token revoked", "ok");
    await loadTokens();
    render();
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderTokenRows(list, emptyText) {
  if (!list.length) {
    return \`<span style="color:var(--muted);font-size:.8rem">\${esc(emptyText)}</span>\`;
  }

  return list.map(t => {
    const status = getTokenStatus(t);
    return \`
      <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface2);border-radius:4px;padding:.5rem .65rem;margin-bottom:.4rem">
        <div>
          <div style="font-size:.85rem;display:flex;align-items:center;gap:.45rem;flex-wrap:wrap">
            <span>\${esc(t.name)}</span>
            <span class="badge token-status-\${status}">\${tokenStatusLabel(status)}</span>
            \${t.token_prefix ? \`<code style="font-size:.7rem;color:var(--muted)">\${esc(t.token_prefix)}</code>\` : ""}
          </div>
          <div style="font-size:.72rem;color:var(--muted)">
            \${(t.capabilities ?? []).join(", ")} &middot; Created \${new Date(t.created_at).toLocaleDateString()}
            \${t.expires_at ? \` · Expires \${new Date(t.expires_at).toLocaleDateString()}\` : " · No expiry"}
          </div>
        </div>
        <button class="btn btn-danger" data-action="revoke-token" data-token-id="\${esc(t.id)}" \${status === "revoked" ? "disabled" : ""}>Revoke</button>
      </div>
    \`;
  }).join("");
}

function tokenModalHtml() {
  const mode = tokenModalMode;
  const caps = mode === "client" ? CLIENT_CAPS : AGENT_CAPS;
  const title = \`Generate \${mode === "client" ? "client" : "agent"} token\`;

  return \`
    <div class="modal">
      <h2>\${esc(title)}</h2>
      <div class="form-grid">
        <div class="form-grid-col">
          <div class="field">
            <label>Token name</label>
            <input
              id="token-name"
              type="text"
              class="\${tokenFormErrors.name ? "input-error" : ""}"
              placeholder="\${mode === "client" ? "e.g. VSCode Laptop" : "e.g. CI Agent"}"
              value="\${esc(tokenForm.name)}"
            >
            \${tokenFormErrors.name ? \`<div class="field-error">\${esc(tokenFormErrors.name)}</div>\` : ""}
          </div>

          <div class="field">
            <label>Capabilities</label>
            <div class="hint" style="margin-bottom:.6rem">
              Select which capabilities to grant this token.
            </div>
            \${tokenFormErrors.caps ? \`<div class="field-error" style="margin:0 0 .6rem">\${esc(tokenFormErrors.caps)}</div>\` : ""}
            <div class="cap-list">
              \${caps.map(cap => \`
                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    data-action="toggle-token-cap"
                    data-cap="\${esc(cap)}"
                    \${tokenForm.caps.includes(cap) ? "checked" : ""}
                  >
                  <span class="checkbox-box"></span>
                  <div class="checkbox-content">
                    <div style="font-size:.85rem;font-weight:500">\${esc(TOKEN_LABELS[cap] ?? cap)}</div>
                    <div class="hint" style="margin-top:0">\${esc(TOKEN_HINTS[cap] ?? "")}</div>
                  </div>
                </label>
              \`).join("")}
            </div>
          </div>
        </div>

        <div class="form-grid-col">
          <div class="field">
            <label>Project scopes (optional)</label>
            <div class="hint">
              Restrict this token to specific projects. Leave empty for all projects.
            </div>
            \${availableProjectScopes.length > 0 ? \`
              <select id="token-project-scopes" multiple size="\${Math.min(Math.max(availableProjectScopes.length, 4), 8)}" style="margin-top:.5rem">
                \${availableProjectScopes.map(scope => \`
                  <option value="\${esc(scope)}" \${tokenForm.scopes.includes(scope) ? "selected" : ""}>\${esc(scope)}</option>
                \`).join("")}
              </select>
              <div class="hint">Hold Ctrl or Cmd to select multiple scopes.</div>
            \` : \`
              <div class="hint" style="margin-top:.5rem">
                No project scopes found yet.
              </div>
            \`}
            \${tokenForm.scopes.length > 0 ? \`
              <div style="display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.5rem">
                \${tokenForm.scopes.map(scope => \`
                  <span class="badge token-status-active" style="cursor:default">\${esc(scope)}</span>
                \`).join("")}
              </div>
            \` : ""}
          </div>

          <div class="field">
            <label>Token expiry</label>
            <div class="hint">
              Optionally set a time limit for this token. Leave blank for no expiry.
            </div>
            <select id="token-ttl">
              <option value="" \${tokenForm.ttlDays === "" ? "selected" : ""}>No expiry</option>
              <option value="7" \${tokenForm.ttlDays === "7" ? "selected" : ""}>7 days</option>
              <option value="30" \${tokenForm.ttlDays === "30" ? "selected" : ""}>30 days</option>
              <option value="90" \${tokenForm.ttlDays === "90" ? "selected" : ""}>90 days</option>
            </select>
          </div>

          <div class="field">
            <label>
              Generated tokens
              \${tokenModalResults.length > 0 ? \`<span style="opacity:.5;font-weight:400">(\${tokenModalResults.length})</span>\` : ""}
            </label>
            \${tokenModalResults.length === 0 ? \`
              <div class="hint">
                Tokens you generate in this session will appear here. Copy them now, they will not be shown again.
              </div>
            \` : \`
              <div class="token-result-list">
                \${tokenModalResults.map((r, i) => \`
                  <div class="token-result">
                    <div class="token-result-name">\${esc(r.name)}</div>
                    <div class="token-result-row">
                      <code class="token-result-value">\${esc(r.token)}</code>
                      <button class="btn" data-action="copy-token-value" data-token-value="\${esc(r.token)}">Copy</button>
                    </div>
                  </div>
                \`).join("")}
                <div class="token-result-warn">
                  These values will not be shown again after you close this dialog.
                </div>
              </div>
            \`}
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" data-action="close-token-modal">Done</button>
        <button class="btn btn-primary" data-action="submit-token-create">Generate</button>
      </div>
    </div>
  \`;
}

function renderTokenModal() {
  const existing = document.querySelector(".overlay");
  if (existing) existing.remove();
  if (!tokenModalOpen) return;

  const el = document.createElement("div");
  el.className = "overlay";
  el.innerHTML = tokenModalHtml();
  document.body.appendChild(el);

  const nameEl = document.getElementById("token-name");
  const scopeEl = document.getElementById("token-project-scopes");
  const ttlEl = document.getElementById("token-ttl");

  if (nameEl) {
    nameEl.addEventListener("input", e => {
      tokenForm.name = e.target.value;
      if (tokenFormErrors.name) {
        tokenFormErrors.name = "";
        renderTokenModal();
      }
    });
  }

  if (scopeEl) {
    scopeEl.addEventListener("change", e => {
      tokenForm.scopes = Array.from(e.target.selectedOptions).map(o => o.value);
      renderTokenModal();
    });
  }

  if (ttlEl) {
    ttlEl.addEventListener("change", e => {
      tokenForm.ttlDays = e.target.value;
    });
  }
}

async function createToken() {
  const name = document.getElementById("new-token-name")?.value?.trim();
  if (!name) { toast("Enter a token name", "error"); return; }
  try {
    const res = await apiFetch("POST", "/admin/tokens", { name });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    const resultEl = document.getElementById("new-token-result");
    if (resultEl) {
      resultEl.style.display = "block";
      resultEl.innerHTML = \`Token created. Copy it now, it will not be shown again.<br><code style="background:var(--surface2);padding:.25rem .4rem;border-radius:3px;word-break:break-all">\${esc(data.token)}</code>\`;
    }
    document.getElementById("new-token-name").value = "";
    loadTokens();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function revokeToken(id) {
  if (!confirm("Revoke this token? Any clients using it will immediately lose access.")) return;
  try {
    const res = await apiFetch("DELETE", \`/admin/tokens/\${id}\`);
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    toast("Token revoked", "ok");
    loadTokens();
  } catch (e) {
    toast(e.message, "error");
  }
}

function showTokenScreen(err) {
  app.innerHTML = \`<div class="screen"><div class="screen-inner">
  <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <h1>Tenure</h1>
    <p>Enter your API token to manage settings.</p>
    \${err ? \`<div class="err-msg">\${esc(err)}</div>\` : ""}
    <label for="tok">API Token</label>
    <input id="tok" type="password" placeholder="your-token-here" autocomplete="off">
    <button class="btn btn-primary" data-action="handle-token" style="width:100%">Continue</button>
  </div></div>\`;
  const inp = document.getElementById("tok");
  inp?.focus();
  inp?.addEventListener("keydown", e => { if (e.key === "Enter") handleToken(); });
}

function handleToken() {
  const v = document.getElementById("tok")?.value?.trim();
  if (!v) return;
  token = v;
  localStorage.setItem(STORAGE_KEY, token);
  init();
}

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function rotateToken() {
  if (!confirm("This will invalidate your current token immediately. Continue?")) return;
  try {
    const res = await apiFetch("POST", "/admin/token/rotate");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    const newToken = data.token;
    alert(\`New token:\\n\\n\${newToken}\\n\\nCopy this now, then click OK to continue.\`);


    token = newToken;
    localStorage.setItem(STORAGE_KEY, newToken);


    window.location.href = \`/admin?token=\${encodeURIComponent(newToken)}\`;
  } catch (e) {
    toast(e.message, "error");
  }
}

async function exportBackup() {
  const passphrase = document.getElementById("export-passphrase")?.value ?? "";
  if (passphrase.length < 8) {
    toast("Passphrase must be at least 8 characters", "error");
    return;
  }
  try {
    const res = await apiFetch("POST", "/v1/backup/export", { passphrase });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = \`tenure-backup-\${Date.now()}.enc\`;
    a.click();
    URL.revokeObjectURL(url);
    document.getElementById("export-passphrase").value = "";
    toast("Backup exported", "ok");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function importBackup() {
  const fileInput = document.getElementById("import-file");
 const file = fileInput?.files?.[0];
  const passphrase = document.getElementById("import-passphrase")?.value ?? "";

  if (!file) { toast("Select a backup file", "error"); return; }
  if (!passphrase) { toast("Passphrase is required", "error"); return; }

  const skipExisting = document.getElementById("import-skip-existing")?.checked ?? true;
  const importConfig = document.getElementById("import-config")?.checked ?? true;

  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const res = await apiFetch("POST", "/v1/backup/import", {
      passphrase,
      archive: base64,
      skip_existing: skipExisting,
      import_config: importConfig,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    const r = data.result;
    const resultEl = document.getElementById("import-result");
    if (resultEl) {
      resultEl.style.display = "block";
      resultEl.textContent = \`Imported \${r.beliefs_imported} beliefs (\${r.beliefs_skipped} skipped). \`
        + \`\${r.persona_restored ? "Persona restored. " : ""}\`
        + \`\${r.config_restored ? "Settings restored." : ""}\`;
    }

    document.getElementById("import-passphrase").value = "";
    toast("Backup imported", "ok");

    if (importConfig) {
      setTimeout(() => init(), 1500);
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

async function loadBackupPreview() {
  try {
    const res = await apiFetch("GET", "/v1/backup/preview");
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();
    const c = data.counts;
    const el = document.getElementById("backup-preview");
    if (el) {
      el.style.display = "block";
      document.getElementById("bp-beliefs").textContent = \`\${c.beliefs_active} active beliefs (\${c.beliefs} total)\`;
      document.getElementById("bp-persona").textContent = c.has_persona ? "Persona: ✓" : "Persona: not generated";
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

async function setStrictModelTiers(enabled) {
  try {
    const res = await apiFetch("PUT", "/admin/config/strict_model_tiers", { value: enabled });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    const track = document.getElementById("strict-tiers-track");
    const thumb = document.getElementById("strict-tiers-thumb");
    const label = document.getElementById("strict-tiers-label");
    if (track) track.style.background = enabled ? "var(--ok)" : "var(--border)";
    if (thumb) thumb.style.transform = \`translateX(\${enabled ? "21px" : "3px"})\`;
    if (label) { label.textContent = enabled ? "Enforced" : "Off"; label.style.color = enabled ? "var(--ok)" : "var(--muted)"; }
    toast(enabled ? "Strict tiers enforced" : "Strict tiers disabled", "ok");
  } catch (e) {
    toast(e.message, "error");
    const cb = document.getElementById("strict-model-tiers");
    if (cb) cb.checked = !enabled;
  }
}

async function setScopeAutoDetect(enabled) {
  try {
    const res = await apiFetch("PUT", "/admin/config/scope_auto_detect", {
      value: enabled,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    const track = document.getElementById("scope-auto-track");
    const thumb = document.getElementById("scope-auto-thumb");
    const label = document.getElementById("scope-auto-label");

    if (track) track.style.background = enabled ? "var(--ok)" : "var(--border)";
    if (thumb) thumb.style.transform = \`translateX(\${enabled ? "21px" : "3px"})\`;
    if (label) {
      label.textContent = enabled ? "Auto-detect" : "Explicit only";
      label.style.color = enabled ? "var(--ok)" : "var(--muted)";
    }

    toast(
      enabled
        ? "Scope auto-detection enabled"
        : "Scope set to explicit only, use !scope to set manually",
      "ok",
    );
  } catch (e) {
    toast(e.message, "error");
    const cb = document.getElementById("scope-auto-detect");
    if (cb) cb.checked = !enabled;
  }
}

async function setInjectionEnabled(enabled) {
  try {
    const res = await apiFetch("PUT", "/admin/config/injection_enabled", {
      value: enabled,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ??  \`HTTP \${res.status} \`);

    const track = document.getElementById("injection-track");
    const thumb = document.getElementById("injection-thumb");
    const label = document.getElementById("injection-label");

    if (track) track.style.background = enabled ? "var(--ok)" : "var(--border)";
    if (thumb) thumb.style.transform =  \`translateX(\${enabled ? "21px" : "3px"})\`;
    if (label) {
      label.textContent = enabled ? "Enabled" : "Paused";
      label.style.color = enabled ? "var(--ok)" : "var(--muted)";
    }

    toast(
      enabled
        ? "Belief injection enabled"
        : "Injection paused, model has no world model context. Extraction still running.",
      "ok",
    );
  } catch (e) {
    toast(e.message, "error");
    const cb = document.getElementById("injection-enabled");
    if (cb) cb.checked = !enabled;
  }
}



async function runCompaction() {
  const btn = document.getElementById("compact-btn");
  const status = document.getElementById("compact-status");
  if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
  try {
    const res = await apiFetch("POST", "/admin/maintenance/compact");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    if (status) status.innerHTML = \`<span style="color:var(--ok)">Compaction complete.</span>\`;
    toast("Compaction complete", "ok");
  } catch (e) {
    toast(e.message, "error");
    if (status) status.innerHTML = \`<span style="color:var(--danger)">\${esc(e.message)}</span>\`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Merge redundant beliefs"; }
  }
}

async function loadPersona() {
  try {
    const res = await apiFetch("GET", "/v1/persona");
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();
    const el = document.getElementById("persona-universal");
    if (el) el.textContent = data.universal || "(No persona generated yet, run onboarding or wait for extraction to build one)";
  } catch (e) {
    const el = document.getElementById("persona-universal");
    if (el) el.textContent = "(Could not load persona)";
  }
}

async function loadErrors() {
  const el = document.getElementById("error-log");
  if (!el) return;
  try {
    const res = await apiFetch("GET", "/admin/errors?limit=10");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    if (data.errors.length === 0) {
      el.innerHTML = \`<span style="color:var(--ok)">No errors recorded.</span>\`;
      return;
    }

    el.innerHTML = data.errors.map(e => \`
      <div style="background:var(--surface2);border-radius:4px;padding:.5rem .65rem;margin-bottom:.5rem;border-left:2px solid \${e.severity === 'error' || e.severity === 'critical' ? 'var(--danger)' : '#d4a84b'}">
        <div style="display:flex;justify-content:space-between;gap:.5rem;margin-bottom:.2rem">
          <span style="color:var(--text);font-size:.78rem;font-weight:500">\${esc(e.severity)}/\${esc(e.stage)}</span>
          <span style="font-size:.72rem;color:var(--muted)">\${new Date(e.occurred_at).toLocaleString()}</span>
        </div>
        <div style="color:var(--text);font-size:.8rem;word-break:break-word;margin-bottom:.35rem">\${esc(e.message)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:.4rem .75rem;font-size:.72rem;color:var(--muted)">
          \${e.provider ? \`<span>provider: <code style="color:var(--text)">\${esc(e.provider)}</code></span>\` : ""}
          \${e.model           ? \`<span>model: <code style="color:var(--text)">\${esc(e.model)}</code></span>\` : ""}
          \${e.exception_type  ? \`<span>exception: <code style="color:var(--text)">\${esc(e.exception_type)}</code></span>\` : ""}
          \${e.user_impacted ? \`<span style="color:var(--danger)">user impacted</span>\` : ""}
          \${e.passthrough_succeeded === true ? \`<span style="color:var(--ok)">response delivered</span>\` : e.passthrough_succeeded === false ? \`<span style="color:var(--danger)">response failed</span>\` : ""}
        </div>
        \${e.stack_trace ? \`
        <details style="margin-top:.35rem">
          <summary style="font-size:.72rem;color:var(--muted);cursor:pointer">Stack trace</summary>
          <pre style="font-size:.7rem;color:var(--muted);overflow-x:auto;margin-top:.25rem;white-space:pre-wrap;word-break:break-all">\${esc(e.stack_trace.slice(0, 1500))}</pre>
        </details>\` : ""}
      </div>
    \`).join("");
  } catch (e) {
    if (el) el.textContent = \`Failed to load: \${e.message}\`;
  }
}

async function copyErrors() {
  try {
    const res = await apiFetch("GET", "/admin/errors?limit=5");
    const data = await res.json();
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);

    const text = data.errors.map(e => [
      \`[\${e.occurred_at}] \${e.severity}/\${e.stage}: \${e.message}\`,
      e.provider        ? \`  provider: \${e.provider}\`                         : null,
      e.model           ? \`  model: \${e.model}\`                                : null,
      e.exception_type  ? \`  exception: \${e.exception_type}\`                   : null,
      e.user_impacted !== undefined ? \`  user_impacted: \${e.user_impacted}\`    : null,
      e.passthrough_succeeded !== null && e.passthrough_succeeded !== undefined
        ? \`  passthrough_succeeded: \${e.passthrough_succeeded}\`                : null,
      e.stack_trace ? \`  stack:\\n\${e.stack_trace.split("\\n").slice(0, 6).map(l => \`    \${l}\`).join("\\n")}\` : null,
    ].filter(Boolean).join("\\n")).join("\\n\\n");

    await navigator.clipboard.writeText(text || "No errors recorded.");
    toast("Copied to clipboard", "ok");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function regeneratePersona() {
  try {
    const res = await apiFetch("POST", "/v1/persona/regenerate");
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    toast("Persona regeneration started", "ok");
    setTimeout(loadPersona, 3000);
  } catch (e) {
    toast(e.message, "error");
  }
}

function toast(msg, type) {
  const el = document.createElement("div");
  el.className = \`toast toast-\${type}\`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

document.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case "retry": init(); break;
    case "load-models": loadModels(); break;
    case "save-model": saveModel(); break;
    case "toggle-advanced": toggleAdvanced(); break;
    case "save-advanced": saveAdvanced(); break;
    case "rotate-token": rotateToken(); break;
    case "create-token": createToken(); break;
    case "revoke-token": revokeToken(el.dataset.tokenId); break;
    case "run-compaction": runCompaction(); break;
    case "copy-errors": copyErrors(); break;
    case "load-errors": loadErrors(); break;
    case "load-backup-preview": loadBackupPreview(); break;
    case "export-backup": exportBackup(); break;
    case "import-backup": importBackup(); break;
    case "handle-token": handleToken(); break;
    case "save-provider": saveProvider(el.dataset.providerId); break;
    case "remove-provider": removeProvider(el.dataset.providerId); break;
    case "regenerate-persona": regeneratePersona(); break;
    case "save-advanced": saveAdvanced(); break;
    case "rotate-token": rotateToken(); break;
    case "open-token-modal": openTokenModal(el.dataset.tokenMode); break;
    case "close-token-modal": closeTokenModal(); break;
    case "submit-token-create": submitTokenCreate(); break;
    case "copy-token-value": copyTokenValue(el.dataset.tokenValue); break;
  }
});

document.addEventListener("change", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case "set-extraction-enabled": setExtractionEnabled(el.checked); break;
    case "set-injection-enabled": setInjectionEnabled(el.checked); break;
    case "set-scope-auto-detect": setScopeAutoDetect(el.checked); break;
    case "set-strict-model-tiers": setStrictModelTiers(el.checked); break;
    case "on-admin-flavor-change": onAdminFlavorChange(el.dataset.providerId, el.value); break;
    case "toggle-token-cap": toggleTokenCap(el.dataset.cap); break;
  }
});

document.addEventListener("click", e => {
  if (e.target.classList?.contains("overlay")) {
    closeTokenModal();
  }
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && tokenModalOpen) {
    closeTokenModal();
  }
});

token ? init() : showTokenScreen();

<\/script>
</body>
</html>`;
}
