import type { FastifyInstance } from "fastify";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Db } from "mongodb";
import { requireRootToken } from "./setup-guard.js";
import { synthesizeOrgSummary } from "../context/orgSummary.js";

const isTeams = process.env.TENURE_MODE === "teams";

export interface AdminSetupDeps {
  runtimeStore: RuntimeConfigStore;
  db: Db;
  providers: ProviderRegistry;
}

export function registerAdminSetupRoute(
  app: FastifyInstance,
  deps: AdminSetupDeps
): void {
  app.get<{ Querystring: { token?: string } }>(
    "/admin/setup",
    { preHandler: requireRootToken },
    async (req, reply) => {
      if (!isTeams) {
        return reply.redirect("/admin", 302);
      }

      const cfg = await deps.runtimeStore.load();
      const hasProvider =
        cfg.openai_api_key !== null || cfg.anthropic_api_key !== null;

      if (hasProvider) {
        return reply.redirect("/admin", 302);
      }

      reply.header("content-type", "text/html; charset=utf-8");
      return reply.send(buildSetupHtml(req.query.token ?? ""));
    }
  );

  app.post<{ Body: { text: string } }>(
    "/admin/setup/org-summary",
    { preHandler: requireRootToken },
    async (req, reply) => {
      const { text } = req.body ?? {};
      if (!text?.trim()) {
        return reply.code(400).send({ error: { message: "text is required" } });
      }

      const cfg = await deps.runtimeStore.load();
      const model = cfg.default_model;
      const provider = cfg.default_provider;
      if (!model || !provider) {
        return reply.code(400).send({
          error: { message: "no default model or provider configured" }
        });
      }

      try {
        const summary = await synthesizeOrgSummary(
          text.trim(),
          model,
          () => deps.providers.detectFromModel(model, provider) as any
        );
        const orgId =
          req.tenureOrgId ?? process.env.TENURE_DEFAULT_ORG_ID ?? "default";

        await deps.db
          .collection("org_summaries")
          .updateOne(
            { org_id: orgId },
            { $set: { org_id: orgId, summary, updated_at: new Date() } },
            { upsert: true }
          );

        return { ok: true, summary };
      } catch (err) {
        req.log.error({ err }, "org summary generation failed");
        return reply
          .code(502)
          .send({ error: { message: "LLM generation failed" } });
      }
    }
  );
}

function buildSetupHtml(embeddedToken: string): string {
  const tokenJS = embeddedToken
    ? JSON.stringify(embeddedToken).replace(/</g, "\\u003c")
    : `new URLSearchParams(location.search).get("token") || ""`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/x-icon" href="/assets/favicon.ico">
<title>Initial Setup · Tenure</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --bg: #0f0f0f; --surface: #1a1a1a; --surface2: #222; --border: #2a2a2a; --text: #e8e8e8; --muted: #888; --accent: #015054; --danger: #ff6b6b; --ok: #6bffb8; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
  .card { width: 100%; max-width: 600px; }
  .header { margin-bottom: 2.5rem; }
  .header h1 { font-size: 1.25rem; font-weight: 500; margin-bottom: 0.5rem; }
  .header p { color: var(--muted); font-size: 0.9rem; line-height: 1.5; }
  .field { margin-bottom: 1rem; }
  .field label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.5rem; }
  .field input, .field select, .field textarea { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 0.9rem; padding: 0.75rem 1rem; outline: none; margin-bottom: 1rem; appearance: none; -webkit-appearance: none; }
  .field input:focus, .field select:focus, .field textarea:focus { border-color: var(--accent); }
  .field input[type=password] { font-family: monospace; }
  .field select option { background: var(--surface); }
  .field .hint { font-size: 0.78rem; color: var(--muted); margin-top: -0.75rem; margin-bottom: 1rem; line-height: 1.4; opacity: 0.7; }
  .actions { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; }
  .btn { padding: 0.6rem 1.25rem; border-radius: 6px; font-size: 0.9rem; cursor: pointer; border: none; font-family: inherit; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: white; }
  .error { color: var(--danger); font-size: 0.85rem; margin-bottom: 0.75rem; }
  .status { text-align: center; padding: 2rem 0; color: var(--muted); font-size: 0.9rem; }
  .status h2 { font-size: 1.25rem; color: var(--text); margin-bottom: 0.75rem; font-weight: 500; }
  .logo { display: block; margin: 0 auto 2rem; width: 120px; }
</style>
</head>
<body>
<div class="card" id="app"><div class="status"><p>Loading…</p></div></div>
<script>
const token = ${tokenJS};

const FLAVORS = [
  { id: "generic", label: "Generic OpenAI", urlPlaceholder: "https://api.openai.com/v1", hint: "Standard OpenAI API or any compatible endpoint without special caching support." },
  { id: "bedrock-access-gateway", label: "Bedrock Access Gateway", urlPlaceholder: "http://localhost:5757/api/v1", hint: "AWS Bedrock Access Gateway. Enables Bedrock prompt caching." },
  { id: "litellm", label: "LiteLLM", urlPlaceholder: "http://localhost:4000", hint: "LiteLLM proxy. Translates caching hints automatically." }
];

function flavorById(id) {
  return FLAVORS.find(f => f.id === id) ?? FLAVORS;
}

function set(html) {
  document.getElementById("app").innerHTML = html;
}

function showProviderSetup(err) {
  set(\`
    <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <div class="header"><h1>Connect a provider</h1><p>Tenure needs an LLM for belief extraction and chat routing.</p></div>
    <div class="field">
      <label for="prov-id">Provider</label>
      <select id="prov-id" onchange="onProviderChange(this.value)">
        <option value="openai">OpenAI (or compatible endpoint)</option>
        <option value="anthropic">Anthropic</option>
      </select>
    </div>
    <div class="field">
      <label for="prov-key">API Key</label>
      <input id="prov-key" type="password" placeholder="sk-…" autocomplete="off">
    </div>
    <div id="openai-extra">
      <div class="field">
        <label for="endpoint-flavor">Endpoint type</label>
        <select id="endpoint-flavor" onchange="onFlavorChange(this.value)">
          \${FLAVORS.map(f => \`<option value="\${f.id}">\${f.label}</option>\`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="prov-url">Base URL <span id="url-optional" style="opacity:0.5;font-size:0.8rem">(optional for generic OpenAI)</span></label>
        <input id="prov-url" type="text" placeholder="\${FLAVORS.urlPlaceholder}">
        <div class="hint" id="flavor-hint">\${FLAVORS.hint}</div>
      </div>
    </div>
    \${err ? \`<div class="error">\${err}</div>\` : ""}
    <div class="actions">
      <div class="spacer" style="flex:1"></div>
      <button class="btn btn-primary" id="save-provider" onclick="submitProvider()">Save and continue</button>
    </div>
  \`);
  document.getElementById("prov-key")?.focus();
}

function onProviderChange(provider) {
  const extra = document.getElementById("openai-extra");
  if (extra) extra.style.display = provider === "anthropic" ? "none" : "";
}

function onFlavorChange(flavorId) {
  const flavor = flavorById(flavorId);
  document.getElementById("prov-url").placeholder = flavor.urlPlaceholder;
  document.getElementById("flavor-hint").textContent = flavor.hint;
  const optional = flavorId === "generic";
  document.getElementById("url-optional").innerHTML = optional
    ? '(optional for generic OpenAI)'
    : '<span style="color:var(--danger);font-size:0.8rem">*</span>';
}

async function submitProvider() {
  const id = document.getElementById("prov-id").value;
  const key = document.getElementById("prov-key").value.trim();
  const url = document.getElementById("prov-url").value.trim() || undefined;
  const flavor = document.getElementById("endpoint-flavor")?.value || "generic";
  const btn = document.getElementById("save-provider");

  if (!key) return showProviderSetup("API key is required.");
  if (id === "openai" && flavor !== "generic" && !url) {
    return showProviderSetup("A base URL is required for this endpoint type.");
  }

  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const body = {
      api_key: key,
      ...(url ? { base_url: url } : {}),
      ...(id === "openai" ? { endpoint_flavor: flavor } : {})
    };
    const res = await fetch(\`/admin/providers/\${id}\`, {
      method: "PUT",
      headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return showProviderSetup(data?.error?.message ?? \`HTTP \${res.status}\`);
    }
    showModelPicker(id);
  } catch (e) {
    showProviderSetup(e.message);
  }
}

async function showModelPicker(providerId, err) {
  set(\`<div class="status"><p>Probing available models…</p></div>\`);
  try {
    const res = await fetch(\`/v1/onboarding/probe-models/\${providerId}\`, {
      headers: { Authorization: \`Bearer \${token}\` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`Probe failed (HTTP \${res.status})\`);

    const models = data.models ?? [];
    const supported = models.filter(m => m.supported);
    const unknown = models.filter(m => !m.supported && m.family === null);
    const unsupported = models.filter(m => !m.supported && m.family !== null);

    if (supported.length === 0 && unknown.length === 0 && unsupported.length === 0) {
      return showProviderSetup("No models returned by this provider. Check credentials or base URL.");
    }

    set(\`
      <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
      <div class="header"><h1>Pick a default model</h1><p>Used for belief extraction and as the chat default. You can change this later.</p></div>
      <div class="field">
        <label for="model-select">Model</label>
        <select id="model-select">
          \${supported.length ? \`<optgroup label="Supported">\${supported.map(m => \`<option value="\${m.id}">\${m.id}</option>\`).join("")}</optgroup>\` : ""}
          \${unknown.length ? \`<optgroup label="Unknown family (use at your own risk)">\${unknown.map(m => \`<option value="\${m.id}">\${m.id}</option>\`).join("")}</optgroup>\` : ""}
          \${unsupported.length ? \`<optgroup label="Below tier floor (disabled)">\${unsupported.map(m => \`<option value="\${m.id}" disabled>\${m.id} — \${m.reason ?? ""}</option>\`).join("")}</optgroup>\` : ""}
        </select>
        <div class="hint">\${supported.length} supported, \${unknown.length} unknown, \${unsupported.length} below floor</div>
      </div>
      \${err ? \`<div class="error">\${err}</div>\` : ""}
      <div class="actions">
        <div class="spacer" style="flex:1"></div>
        <button class="btn btn-primary" id="validate-btn" onclick="validateModel('\${providerId}')">Test and save</button>
      </div>
    \`);
  } catch (e) {
    showProviderSetup(\`Probe error: \${e.message}\`);
  }
}

async function validateModel(providerId) {
  const modelId = document.getElementById("model-select").value;
  const btn = document.getElementById("validate-btn");
  if (!modelId) return;
  btn.disabled = true;
  btn.textContent = "Testing…";

  try {
    const res = await fetch("/v1/onboarding/validate-model", {
      method: "POST",
      headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: providerId, model_id: modelId })
    });
    const data = await res.json();
    if (!res.ok) {
      return showModelPicker(providerId, data?.error?.message ?? \`HTTP \${res.status}\`);
    }
    showTeamSetup(modelId);
  } catch (e) {
    showModelPicker(providerId, e.message);
  }
}

function showTeamSetup(modelId, err) {
  set(\`
    <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <div class="header"><h1>Team configuration</h1><p>Set the default team, organization, and how users are resolved.</p></div>
    <div class="field">
      <label for="team-strategy">Resolution strategy</label>
      <select id="team-strategy">
        <option value="static">Static - everyone maps to the same team/org</option>
        <option value="header">Header - proxy sends team/org headers</option>
        <option value="scim_group">SCIM Group - map IdP groups to teams</option>
        <option value="manual">Manual - assign users later in Team Admin</option>
      </select>
      <div class="hint">You can change this anytime in /admin/team.</div>
    </div>
    <div class="field">
      <label>Default team ID</label>
      <input id="setup-team-id" type="text" placeholder="team_default">
    </div>
    <div class="field">
      <label>Default org ID</label>
      <input id="setup-org-id" type="text" placeholder="org_default">
    </div>
    \${err ? \`<div class="error">\${esc(err)}</div>\` : ""}
    <div class="actions">
      <div class="spacer" style="flex:1"></div>
      <button class="btn btn-primary" id="team-save" onclick="submitTeamSetup('\${esc(modelId)}')">Save and continue</button>
    </div>
  \`);
}

async function submitTeamSetup(modelId) {
  const btn = document.getElementById("team-save");
  btn.disabled = true;
  btn.textContent = "Saving…";

  const strategy = document.getElementById("team-strategy").value;
  const teamId = document.getElementById("setup-team-id").value.trim();
  const orgId = document.getElementById("setup-org-id").value.trim();

  try {
    const res = await fetch("/admin/team/strategy", {
      method: "PUT",
      headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
      body: JSON.stringify({ strategy, default_team_id: teamId, default_org_id: orgId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    showOrgSetup(modelId);
  } catch (e) {
    showTeamSetup(modelId, e.message);
  }
}

function showOrgSetup(modelId, err) {
  set(\`
    <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <div class="header"><h1>Organization summary</h1><p>Paste organizational policies, standards, or working agreements. This is synthesized into a tight governance prelude that constrains team beliefs during compaction.</p></div>
    <div class="field">
      <textarea id="org-text" style="min-height:160px;resize:vertical;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:.75rem 1rem;font-family:inherit;font-size:.9rem;width:100%;" placeholder="Paste policies here…"></textarea>
    </div>
    \${err ? \`<div class="error">\${esc(err)}</div>\` : ""}
    <div class="actions">
      <div class="spacer" style="flex:1"></div>
      <button class="btn btn-secondary" onclick="skipOrg('\${esc(modelId)}')">Skip</button>
      <button class="btn btn-primary" id="org-save" onclick="submitOrgSetup('\${esc(modelId)}')">Save and finish</button>
    </div>
  \`);
}

async function submitOrgSetup(modelId) {
  const btn = document.getElementById("org-save");
  btn.disabled = true;
  btn.textContent = "Synthesizing…";

  const text = document.getElementById("org-text")?.value?.trim();
  if (!text) {
    showOrgSetup(modelId, "Paste some text first.");
    return;
  }

  try {
    const res = await fetch("/admin/setup/org-summary", {
      method: "POST",
      headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    showDone(modelId);
  } catch (e) {
    showOrgSetup(modelId, e.message);
  }
}

function skipOrg(modelId) {
  showDone(modelId);
}

function showDone(modelId) {
  set(\`
    <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <div class="status">
      <h2>Setup complete</h2>
      <p>Default model: <code style="background:var(--surface2);padding:0.2rem 0.4rem;border-radius:4px">\${esc(modelId)}</code></p>
      <p style="margin-top:1rem;font-size:0.85rem;color:var(--muted)">Redirecting to settings…</p>
    </div>
  \`);
  setTimeout(() => { window.location.href = "/admin"; }, 2000);
}

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

if (token) {
  showProviderSetup();
} else {
  set(\`
    <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <div class="header"><h1>Initial Setup</h1><p>Please authenticate first.</p></div>
  \`);
}
<\/script>
</body>
</html>`;
}
