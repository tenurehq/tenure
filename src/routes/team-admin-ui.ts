import type { FastifyInstance } from "fastify";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Db } from "mongodb";
import { synthesizeOrgSummary } from "../context/orgSummary.js";

const isTeams = process.env.TENURE_MODE === "teams";

export interface TeamAdminUiDeps {
  runtimeStore: RuntimeConfigStore;
  providers: ProviderRegistry;
  db: Db;
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

  app.get("/admin/team/org-summary", async (req, reply) => {
    if (!req.tenureUserId) {
      return reply.code(401).send({ error: { message: "Unauthorized" } });
    }

    const orgId =
      req.tenureOrgId ?? process.env.TENURE_DEFAULT_ORG_ID ?? "default";
    const doc = await deps.db
      .collection("org_summaries")
      .findOne({ org_id: orgId });
    return {
      summary: doc?.summary ?? null,
      updated_at: doc?.updated_at ?? null
    };
  });

  app.post<{ Body: { text: string } }>(
    "/admin/team/org-summary",
    async (req, reply) => {
      if (!req.tenureUserId) {
        return reply.code(401).send({ error: { message: "Unauthorized" } });
      }

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

function buildTeamAdminHtml(ssoUserId: string, nonce?: string): string {
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
  .card { max-width: 720px; margin: 0 auto; }
  .header { margin-bottom: 2rem; }
  .header h1 { font-size: 1.25rem; font-weight: 500; margin-bottom: .5rem; }
  .field { margin-bottom: 1.5rem; padding: 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
  .field label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: .5rem; }
  .field select { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: .6rem .75rem; font-family: inherit; }
  .hint { font-size: .78rem; color: var(--muted); margin-top: .5rem; line-height: 1.4; }
  .btn { padding: .6rem 1.25rem; border-radius: 6px; font-size: .9rem; cursor: pointer; border: none; font-family: inherit; background: var(--accent); color: white; }
  .btn:hover { opacity: .85; }
  .status { font-size: .85rem; color: var(--muted); margin-top: .5rem; }
</style>
</head>
<body>
<div class="card" id="app">
  <div class="header"><h1>Team settings</h1></div>
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
  <div class="field">
    <label>Organization summary</label>
    <div style="font-size:.78rem;color:var(--muted);margin-bottom:.5rem;line-height:1.4">
      Paste organizational policies, standards, or working agreements. This is synthesized into a tight governance prelude that constrains team beliefs during compaction.
    </div>
    <textarea id="org-text" style="min-height:160px;resize:vertical;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:inherit;font-size:.85rem;padding:.6rem .75rem;width:100%" placeholder="Paste policies here… or drag and drop a file"></textarea>
    <div id="org-status" class="status"></div>
    <button class="btn" style="margin-top:.75rem" id="org-generate" onclick="generateOrg()">Generate & save</button>
  </div>
</div>
<script${nonceAttr}>
const ssoUserId = ${JSON.stringify(ssoUserId)};
const MODE_LABELS = {
  autonomous: "Autonomous",
  inject_only: "Document-driven",
  curated: "Curated",
  reflective: "Reflective"
};

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function generateOrg() {
  const btn = document.getElementById("org-generate");
  const status = document.getElementById("org-status");
  const text = document.getElementById("org-text")?.value?.trim();

  if (!text) { status.textContent = "Paste some text first."; return; }

  btn.disabled = true;
  status.textContent = "Synthesizing…";

  try {
    const res = await fetch("/admin/team/org-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error("Generation failed");
    const data = await res.json();
    status.innerHTML = \`<span style="color:var(--ok)">Saved. Preview: \${esc(data.summary.slice(0, 120))}…</span>\`;
    document.getElementById("org-text").value = "";
  } catch (e) {
    status.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
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

(function() {
  const dz = document.getElementById("org-text");
  if (dz) {
    dz.addEventListener("dragover", e => e.preventDefault());
    dz.addEventListener("drop", async e => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const text = await file.text();
      dz.value = text;
    });
  }
})();
</script>
</body>
</html>`;
}
