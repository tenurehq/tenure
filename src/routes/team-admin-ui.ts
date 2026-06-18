import type { FastifyInstance } from "fastify";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Db } from "mongodb";
import { randomBytes, randomUUID } from "node:crypto";
import type { Collections } from "../db/collections.js";

const isTeams = process.env.TENURE_MODE === "teams";

export interface TeamAdminUiDeps {
  runtimeStore: RuntimeConfigStore;
  providers: ProviderRegistry;
  db: Db;
  cols: Collections;
}

export function registerTeamAdminUiRoute(
  app: FastifyInstance,
  deps: TeamAdminUiDeps
): void {
  app.get<{ Querystring: { token?: string } }>(
    "/admin/team",
    async (req, reply) => {
      if (!isTeams) {
        return reply.redirect("/admin", 302);
      }
      if (!req.tenureUserId) {
        return reply
          .code(401)
          .send({ error: { message: "SSO authentication required" } });
      }

      reply.header("content-type", "text/html; charset=utf-8");
      const nonce = (reply.raw as any).cspNonce as string | undefined;
      return reply.send(buildTeamAdminHtml(req.tenureUserId, nonce));
    }
  );

  app.put<{ Body: { memory_mode: string } }>(
    "/admin/team/memory-mode",
    async (req, reply) => {
      if (!isTeams) {
        return reply
          .code(403)
          .send({ error: { message: "Not in teams mode" } });
      }
      if (!req.tenureUserId) {
        return reply.code(401).send({ error: { message: "Unauthorized" } });
      }

      const valid = ["inject_only", "curated", "autonomous", "reflective"];
      if (!valid.includes(req.body.memory_mode)) {
        return reply
          .code(400)
          .send({ error: { message: "Invalid memory mode" } });
      }

      await deps.runtimeStore.set("memory_mode", req.body.memory_mode as any);
      return reply.send({ ok: true });
    }
  );

  app.get("/admin/team/strategy", async (req, reply) => {
    if (!req.tenureUserId) {
      return reply.code(401).send({ error: { message: "Unauthorized" } });
    }
    const cfg = await deps.runtimeStore.load();
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers.host ?? "localhost";
    return {
      strategy: cfg.team_resolution_strategy ?? "static",
      default_team_id:
        cfg.default_team_id ?? process.env.TENURE_DEFAULT_TEAM_ID ?? "",
      default_org_id:
        cfg.default_org_id ?? process.env.TENURE_DEFAULT_ORG_ID ?? "",
      team_header_name: cfg.team_header_name ?? "x-team-id",
      org_header_name: cfg.org_header_name ?? "x-org-id",
      scim_group_mappings: cfg.scim_group_mappings ?? [],
      scim_token_preview: cfg.scim_token
        ? "••••••••" + cfg.scim_token.slice(-4)
        : null,
      scim_base_url: `${proto}://${host}/scim/v2`
    };
  });

  app.put<{
    Body: {
      strategy: string;
      default_team_id?: string;
      default_org_id?: string;
      team_header_name?: string;
      org_header_name?: string;
    };
  }>("/admin/team/strategy", async (req, reply) => {
    if (!req.tenureUserId) {
      return reply.code(401).send({ error: { message: "Unauthorized" } });
    }
    const valid = ["disabled", "static", "header", "manual", "scim_group"];
    if (!valid.includes(req.body.strategy)) {
      return reply.code(400).send({ error: { message: "Invalid strategy" } });
    }
    await deps.runtimeStore.set(
      "team_resolution_strategy",
      req.body.strategy as any
    );
    if (req.body.default_team_id !== undefined)
      await deps.runtimeStore.set(
        "default_team_id",
        req.body.default_team_id || null
      );
    if (req.body.default_org_id !== undefined)
      await deps.runtimeStore.set(
        "default_org_id",
        req.body.default_org_id || null
      );
    if (req.body.team_header_name !== undefined)
      await deps.runtimeStore.set(
        "team_header_name",
        req.body.team_header_name || null
      );
    if (req.body.org_header_name !== undefined)
      await deps.runtimeStore.set(
        "org_header_name",
        req.body.org_header_name || null
      );
    return { ok: true };
  });

  app.get("/admin/team/scim-mappings", async (req, reply) => {
    if (!req.tenureUserId) {
      return reply.code(401).send({ error: { message: "Unauthorized" } });
    }
    const cfg = await deps.runtimeStore.load();
    return { mappings: cfg.scim_group_mappings ?? [] };
  });

  app.put<{
    Body: {
      mappings: Array<{ groupId: string; teamId: string; orgId: string }>;
    };
  }>("/admin/team/scim-mappings", async (req, reply) => {
    if (!req.tenureUserId) {
      return reply.code(401).send({ error: { message: "Unauthorized" } });
    }
    if (!Array.isArray(req.body.mappings)) {
      return reply
        .code(400)
        .send({ error: { message: "mappings must be an array" } });
    }
    await deps.runtimeStore.set("scim_group_mappings", req.body.mappings);
    return { ok: true };
  });

  app.post("/admin/team/scim-token", async (req, reply) => {
    if (!req.tenureUserId) {
      return reply.code(401).send({ error: { message: "Unauthorized" } });
    }
    const token = `scim_${randomBytes(24).toString("base64url")}`;
    await deps.runtimeStore.set("scim_token", token);
    return { ok: true, token };
  });

  app.get("/admin/team/manual-mappings", async (req, reply) => {
    if (!req.tenureUserId) {
      return reply.code(401).send({ error: { message: "Unauthorized" } });
    }
    const docs = await deps.cols.team_memberships
      .find({})
      .sort({ created_at: -1 })
      .limit(500)
      .toArray();
    return {
      mappings: docs.map((d) => ({
        _id: d._id,
        user_id: d.user_id,
        team_id: d.team_id,
        org_id: d.org_id
      }))
    };
  });

  app.post<{
    Body: { user_id: string; team_id: string; org_id: string };
  }>("/admin/team/manual-mappings", async (req, reply) => {
    if (!req.tenureUserId) {
      return reply.code(401).send({ error: { message: "Unauthorized" } });
    }
    const { user_id, team_id, org_id } = req.body ?? {};
    if (!user_id || !team_id || !org_id) {
      return reply
        .code(400)
        .send({ error: { message: "user_id, team_id, org_id required" } });
    }
    const id = randomUUID();
    const now = new Date();
    await deps.cols.team_memberships.updateOne(
      { user_id },
      {
        $set: { user_id, team_id, org_id, updated_at: now },
        $setOnInsert: { _id: id, created_at: now }
      },
      { upsert: true }
    );
    const doc = await deps.cols.team_memberships.findOne({ user_id });
    return { ok: true, mapping: doc };
  });

  app.delete<{ Params: { id: string } }>(
    "/admin/team/manual-mappings/:id",
    async (req, reply) => {
      if (!req.tenureUserId) {
        return reply.code(401).send({ error: { message: "Unauthorized" } });
      }
      await deps.cols.team_memberships.deleteOne({ _id: req.params.id });
      return { ok: true };
    }
  );
}

function buildTeamAdminHtml(_ssoUserId: string, nonce?: string): string {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/x-icon" href="/assets/favicon.ico">
<title>Team Admin · Tenure</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --bg: #0f0f0f; --surface: #1a1a1a; --surface2: #222; --border: #2a2a2a; --text: #e8e8e8; --muted: #888; --accent: #015054; --danger: #ff6b6b; --ok: #6bffb8; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; padding: 2rem; }
  .card { max-width: 800px; margin: 0 auto; }
  .header { margin-bottom: 2rem; }
  .header h1 { font-size: 1.25rem; font-weight: 500; margin-bottom: .5rem; }
  .field { margin-bottom: 1.5rem; padding: 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
  .field label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: .5rem; }
  .field input, .field select, .field textarea { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: .6rem .75rem; font-family: inherit; font-size: .9rem; }
  .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--accent); }
  .hint { font-size: .78rem; color: var(--muted); margin-top: .5rem; line-height: 1.4; }
  .btn { padding: .6rem 1.25rem; border-radius: 6px; font-size: .9rem; cursor: pointer; border: none; font-family: inherit; background: var(--accent); color: white; }
  .btn:hover { opacity: .85; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn-secondary { background: var(--surface2); border: 1px solid var(--border); color: var(--text); }
  .status { font-size: .85rem; color: var(--muted); margin-top: .5rem; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .hidden { display: none; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-top: .5rem; }
  th, td { text-align: left; padding: .5rem; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  .token-box { background: var(--bg); border: 1px dashed var(--border); padding: .75rem; border-radius: 6px; font-family: monospace; font-size: .85rem; word-break: break-all; }
</style>
</head>
<body>
<div class="card" id="app">
  <div class="header"><h1>Team settings</h1></div>

  <div class="field">
    <label for="strategy">Team resolution strategy</label>
    <select id="strategy" onchange="onStrategyChange(this.value)">
      <option value="static">Static - everyone maps to the same team/org</option>
      <option value="header">Header - proxy sends team/org headers</option>
      <option value="scim_group">SCIM Group - map IdP groups to teams</option>
      <option value="manual">Manual - assign users in this UI</option>
      <option value="disabled">Disabled - no team features</option>
    </select>
    <div class="hint">How incoming users are mapped to a team and organization.</div>
    <div class="grid-2" style="margin-top:.75rem">
      <div><label>Default team ID</label><input id="default-team-id" placeholder="team_…"></div>
      <div><label>Default org ID</label><input id="default-org-id" placeholder="org_…"></div>
    </div>
    <div style="margin-top:.75rem">
      <button class="btn" onclick="saveStrategy(this)">Save strategy</button>
      <div class="status" id="strategy-status"></div>
    </div>
  </div>

  <div id="section-header" class="field hidden">
    <label>Header names</label>
    <div class="grid-2">
      <div><label>Team header</label><input id="header-team" placeholder="x-team-id"></div>
      <div><label>Org header</label><input id="header-org" placeholder="x-org-id"></div>
    </div>
  </div>

  <div id="section-scim" class="field hidden">
    <label>SCIM setup</label>
    <div class="hint">Give these values to your IdP (Okta, Azure AD, etc.).</div>
    <div style="margin-top:.5rem"><strong>SCIM base URL</strong></div>
    <div class="token-box" id="scim-url">...</div>
    <div style="margin-top:.5rem"><strong>SCIM token</strong></div>
    <div class="token-box" id="scim-token-display">Not configured</div>
    <div style="margin-top:.5rem"><button class="btn btn-secondary" onclick="generateScimToken(this)">Generate new SCIM token</button></div>
    <div class="status" id="scim-token-status"></div>

    <label style="margin-top:1.5rem">Group-to-team mappings</label>
    <div class="hint">When a user belongs to a SCIM group on the left, map them to the team/org on the right.</div>
    <table>
      <thead><tr><th>SCIM group ID</th><th>Team ID</th><th>Org ID</th><th></th></tr></thead>
      <tbody id="scim-mappings-body"></tbody>
    </table>
    <div style="margin-top:.5rem; display:flex; gap:.5rem;">
      <input id="scim-g" placeholder="groupId" style="flex:1">
      <input id="scim-t" placeholder="teamId" style="flex:1">
      <input id="scim-o" placeholder="orgId" style="flex:1">
      <button class="btn" onclick="addScimMapping()">Add</button>
    </div>
    <div style="margin-top:.5rem"><button class="btn" onclick="saveScimMappings()">Save mappings</button></div>
    <div class="status" id="scim-mapping-status"></div>
  </div>

  <div id="section-manual" class="field hidden">
    <label>Manual assignments</label>
    <div class="hint">Map a user identifier (e.g. email) to a team and org.</div>
    <div style="display:flex; gap:.5rem; margin-top:.5rem;">
      <input id="manual-user" placeholder="user_id / email" style="flex:1">
      <input id="manual-team" placeholder="team_id" style="flex:1">
      <input id="manual-org" placeholder="org_id" style="flex:1">
      <button class="btn" onclick="addManualMapping()">Add</button>
    </div>
    <table style="margin-top:.75rem;">
      <thead><tr><th>User</th><th>Team</th><th>Org</th><th></th></tr></thead>
      <tbody id="manual-mappings-body"></tbody>
    </table>
    <div class="status" id="manual-status"></div>
  </div>

  <div class="field">
    <label for="memory-mode">Memory mode</label>
    <select id="memory-mode">
      <option value="autonomous">Autonomous - extract and merge automatically</option>
      <option value="inject_only">Document-driven - only import/onboarding</option>
      <option value="curated">Curated - queue for admin approval</option>
      <option value="reflective">Reflective - extract, do not inject</option>
    </select>
    <div class="hint">Curated is recommended for teams.</div>
    <button class="btn" style="margin-top:1rem" id="save-btn" onclick="saveMode()">Save</button>
    <div class="status" id="status"></div>
  </div>
</div>

<script${nonceAttr}>
const ssoUserId = "${_ssoUserId.replace(/"/g, '\\"')}";
const MODE_LABELS = {
  autonomous: "Autonomous",
  inject_only: "Document-driven",
  curated: "Curated",
  reflective: "Reflective"
};

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function onStrategyChange(val) {
  document.getElementById("section-header").classList.toggle("hidden", val !== "header");
  document.getElementById("section-scim").classList.toggle("hidden", val !== "scim_group");
  document.getElementById("section-manual").classList.toggle("hidden", val !== "manual");
}

async function loadStrategy() {
  try {
    const res = await fetch("/admin/team/strategy");
    const data = await res.json();
    document.getElementById("strategy").value = data.strategy;
    document.getElementById("default-team-id").value = data.default_team_id || "";
    document.getElementById("default-org-id").value = data.default_org_id || "";
    document.getElementById("header-team").value = data.team_header_name || "x-team-id";
    document.getElementById("header-org").value = data.org_header_name || "x-org-id";
    document.getElementById("scim-url").textContent = data.scim_base_url;
    document.getElementById("scim-token-display").textContent = data.scim_token_preview || "Not configured";
    renderScimMappings(data.scim_group_mappings || []);
    onStrategyChange(data.strategy);
  } catch (e) {
    console.error("Failed to load strategy", e);
  }
}

async function saveStrategy(btn) {
  btn.disabled = true;
  const status = document.getElementById("strategy-status");
  status.textContent = "Saving…";
  try {
    const body = {
      strategy: document.getElementById("strategy").value,
      default_team_id: document.getElementById("default-team-id").value,
      default_org_id: document.getElementById("default-org-id").value,
      team_header_name: document.getElementById("header-team").value,
      org_header_name: document.getElementById("header-org").value
    };
    const res = await fetch("/admin/team/strategy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error("Save failed");
    status.textContent = "Saved.";
  } catch (e) {
    status.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

let scimMappings = [];

function renderScimMappings(rows) {
  scimMappings = rows;
  const tbody = document.getElementById("scim-mappings-body");
  tbody.innerHTML = rows.map((r, i) => \`
    <tr>
      <td>\${esc(r.groupId)}</td>
      <td>\${esc(r.teamId)}</td>
      <td>\${esc(r.orgId)}</td>
      <td><button class="btn btn-secondary" style="padding:.3rem .6rem;font-size:.75rem" onclick="removeScimMapping(\${i})">Remove</button></td>
    </tr>\`).join("");
}

function addScimMapping() {
  const g = document.getElementById("scim-g").value.trim();
  const t = document.getElementById("scim-t").value.trim();
  const o = document.getElementById("scim-o").value.trim();
  if (!g || !t || !o) return;
  scimMappings.push({ groupId: g, teamId: t, orgId: o });
  renderScimMappings(scimMappings);
  document.getElementById("scim-g").value = "";
  document.getElementById("scim-t").value = "";
  document.getElementById("scim-o").value = "";
}

function removeScimMapping(idx) {
  scimMappings.splice(idx, 1);
  renderScimMappings(scimMappings);
}

async function saveScimMappings() {
  const status = document.getElementById("scim-mapping-status");
  status.textContent = "Saving…";
  try {
    const res = await fetch("/admin/team/scim-mappings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings: scimMappings }) });
    if (!res.ok) throw new Error("Save failed");
    status.textContent = "Saved.";
  } catch (e) {
    status.textContent = "Error: " + e.message;
  }
}

async function generateScimToken(btn) {
  if (!confirm("Generating a new token will invalidate the previous one immediately. Continue?")) return;
  btn.disabled = true;
  const status = document.getElementById("scim-token-status");
  status.textContent = "Generating…";
  try {
    const res = await fetch("/admin/team/scim-token", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? "Failed");
    document.getElementById("scim-token-display").textContent = data.token;
    status.innerHTML = '<span style="color:var(--ok)">Token generated. Copy it now — it will not be shown again.</span>';
  } catch (e) {
    status.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function loadManualMappings() {
  try {
    const res = await fetch("/admin/team/manual-mappings");
    const data = await res.json();
    renderManualMappings(data.mappings || []);
  } catch (e) {
    console.error("Failed to load manual mappings", e);
  }
}

function renderManualMappings(rows) {
  const tbody = document.getElementById("manual-mappings-body");
  tbody.innerHTML = rows.map(r => \`
    <tr>
      <td>\${esc(r.user_id)}</td>
      <td>\${esc(r.team_id)}</td>
      <td>\${esc(r.org_id)}</td>
      <td><button class="btn btn-secondary" style="padding:.3rem .6rem;font-size:.75rem" onclick="deleteManualMapping('\${esc(r._id)}')">Remove</button></td>
    </tr>\`).join("");
}

async function addManualMapping() {
  const user = document.getElementById("manual-user").value.trim();
  const team = document.getElementById("manual-team").value.trim();
  const org = document.getElementById("manual-org").value.trim();
  if (!user || !team || !org) return;
  const status = document.getElementById("manual-status");
  status.textContent = "Saving…";
  try {
    const res = await fetch("/admin/team/manual-mappings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: user, team_id: team, org_id: org }) });
    if (!res.ok) throw new Error("Save failed");
    document.getElementById("manual-user").value = "";
    document.getElementById("manual-team").value = "";
    document.getElementById("manual-org").value = "";
    status.textContent = "Added.";
    await loadManualMappings();
  } catch (e) {
    status.textContent = "Error: " + e.message;
  }
}

async function deleteManualMapping(id) {
  if (!confirm("Remove this mapping?")) return;
  try {
    await fetch("/admin/team/manual-mappings/" + encodeURIComponent(id), { method: "DELETE" });
    await loadManualMappings();
  } catch (e) {
    alert("Delete failed: " + e.message);
  }
}

async function loadMode() {
  try {
    const res = await fetch("/admin/config");
    const data = await res.json();
    if (data?.memory_mode) document.getElementById("memory-mode").value = data.memory_mode;
  } catch (e) {
    console.error("Failed to load mode", e);
  }
}

async function saveMode() {
  const btn = document.getElementById("save-btn");
  const status = document.getElementById("status");
  btn.disabled = true;
  status.textContent = "Saving…";

  try {
    const res = await fetch("/admin/team/memory-mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory_mode: document.getElementById("memory-mode").value })
    });
    if (!res.ok) throw new Error("Save failed");
    status.textContent = "Saved.";
  } catch (e) {
    status.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

loadMode();
loadStrategy();
loadManualMappings();
</script>
</body>
</html>`;
}
