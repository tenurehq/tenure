import type { FastifyInstance } from "fastify";

export function registerAuditUiRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { token?: string } }>("/audit", async (req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    const nonce = (reply.raw as any).cspNonce as string;
    return reply.send(
      buildAuditHtml(req.query.token ?? "", req.tenureUserId, nonce)
    );
  });
}

function buildAuditHtml(
  embeddedToken: string,
  ssoUserId?: string,
  nonce?: string
): string {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";
  const isTeams = process.env.TENURE_MODE === "teams";

  const tokenJS = embeddedToken
    ? JSON.stringify(embeddedToken).replace(/</g, "\\u003c")
    : isTeams
    ? `new URLSearchParams(location.search).get("token") || ""`
    : `new URLSearchParams(location.search).get("token") || localStorage.getItem(STORAGE_KEY) || ""`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/x-icon" href="/assets/favicon.ico">
<title>Injection Audit · Tenure</title>
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

.main { padding: 2rem; max-width: 900px; margin: 0 auto; }
.section-title { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 1rem; }

.filters { display: flex; gap: .75rem; margin-bottom: 1.5rem; flex-wrap: wrap; align-items: center; }
.input-sm { background: var(--surface); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-family: inherit; font-size: .8rem; padding: .4rem .65rem; outline: none; }
.input-sm:focus { border-color: var(--accent); }

.btn { padding: .35rem .75rem; border-radius: 5px; font-size: .8rem; cursor: pointer; border: 1px solid var(--border); font-family: inherit; color: var(--muted); background: transparent; transition: all .15s; }
.btn:hover { color: var(--text); border-color: #444; }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover { opacity: .85; color: #fff; }

.record { background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 1rem 1.125rem; margin-bottom: .625rem; }
.record-header { display: flex; align-items: center; gap: .75rem; margin-bottom: .625rem; flex-wrap: wrap; }
.record-time { font-size: .75rem; color: var(--muted); }
.record-query { font-size: .85rem; font-weight: 500; flex: 1; min-width: 0; word-break: break-word; }
.record-meta { font-size: .72rem; color: var(--muted); display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: .5rem; }
.record-meta code { color: var(--text); font-size: .72rem; }

.belief-group { margin-top: .625rem; }
.belief-group-title { font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: .375rem; }
.belief-chip { display: inline-block; background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; padding: .25rem .5rem; margin: .15rem .25rem .15rem 0; font-size: .78rem; cursor: default; }
.belief-chip:hover { border-color: var(--accent); }
.belief-chip .chip-name { color: var(--text); font-weight: 500; }
.belief-chip .chip-content { color: var(--muted); margin-left: .35rem; }

.pagination { display: flex; justify-content: center; gap: .75rem; margin-top: 1.5rem; }
.loading { text-align: center; padding: 4rem 2rem; color: var(--muted); font-size: .875rem; }
.empty { font-size: .85rem; color: var(--muted); text-align: center; padding: 3rem 1rem; }

.detail-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
.detail-modal { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; width: 100%; max-width: 640px; max-height: 85vh; overflow-y: auto; padding: 1.5rem; }
.detail-modal h2 { font-size: .95rem; font-weight: 500; margin-bottom: 1rem; }
.detail-belief { background: var(--surface2); border-radius: 5px; padding: .75rem; margin-bottom: .5rem; }
.detail-belief .db-name { font-size: .82rem; font-weight: 500; margin-bottom: .25rem; }
.detail-belief .db-content { font-size: .8rem; color: var(--text); line-height: 1.45; }
.detail-belief .db-why { font-size: .78rem; color: var(--muted); font-style: italic; margin-top: .2rem; }
.detail-belief .db-meta { font-size: .7rem; color: var(--muted); margin-top: .25rem; }

.toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: .6rem 1rem; border-radius: 6px; font-size: .8rem; z-index: 200; pointer-events: none; animation: slideup .2s ease; }
.toast-ok    { background: #0d2a1a; border: 1px solid var(--ok);     color: var(--ok); }
.toast-error { background: #2a1212; border: 1px solid var(--danger); color: var(--danger); }
@keyframes slideup { from { opacity: 0; transform: translateY(.4rem); } to { opacity: 1; transform: none; } }
</style>
${
  ssoUserId
    ? `<script${nonceAttr}>window.__TENURE_SSO_USER__ = ${JSON.stringify(
        ssoUserId
      )};</script>`
    : ""
}
</head>
<body>
<div id="app"><div class="loading">Loading...</div></div>
<script${nonceAttr}>
const STORAGE_KEY = "mp_token";
let token = ${tokenJS};
let records = [];
let total = 0;
let page = 0;
const PAGE_SIZE = 30;
let filterStart = "";
let filterEnd = "";
let filterBelief = "";
let filterScope = ""; 
let auditScopes = [];
let detailRecord = null;

const app = document.getElementById("app");

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

async function loadRecords() {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    skip: String(page * PAGE_SIZE),
  });
  if (filterStart) params.set("start", new Date(filterStart).toISOString());
  if (filterEnd) {
    const end = new Date(filterEnd);
    end.setHours(23, 59, 59, 999);
    params.set("end", end.toISOString());
  }
  if (filterBelief) params.set("belief_id", filterBelief);
  if (filterScope) params.set("scope", filterScope);

  const res = await apiFetch("GET", \`/admin/audit/injections?\${params}\`);
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  const data = await res.json();
  records = data.records ?? [];
  total = data.total ?? 0;
}

async function init() {
  app.innerHTML = '<div class="loading">Loading...</div>';
  try {
    await Promise.all([loadRecords(), loadScopes()]);
    render();
    loadTaxDashboard();
  } catch (e) {
    if (e.message !== "unauthorized") {
      app.innerHTML = \`<div class="loading"><p style="color:var(--danger)">\${esc(e.message)}</p>
        <button class="btn" data-action="retry">Retry</button></div>\`;
    }
  }
}

async function loadScopes() {
  try {
    const res = await apiFetch("GET", "/admin/audit/scopes");
    if (res.ok) {
      const data = await res.json();
      auditScopes = data.scopes ?? [];
    }
  } catch {}
}

function render() {
  const totalPages = Math.ceil(total / PAGE_SIZE);

  app.innerHTML = \`
    <nav class="nav">
      <a class="nav-brand" href="/beliefs">
        <img src="/assets/tenure-logo.png" alt="Tenure" height="24" style="vertical-align:middle">
      </a>
      <div class="nav-links">
        <a class="nav-link" href="/beliefs">World Model</a>
        <a class="nav-link" href="/admin">Settings</a>
        <a class="nav-link active" href="/audit">Audit</a>
        <a class="nav-link" href="/onboarding">Onboarding</a>
      </div>
    </nav>
    <div class="main">
     <div id="tax-dashboard" style="margin-bottom:2rem"></div>
      <div class="section-title">Injection Audit Trail</div>
       <div class="filters">
        <input class="input-sm" id="filter-start" type="date"
          value="\${esc(filterStart)}" title="From date" style="width:150px">
        <input class="input-sm" id="filter-end" type="date"
          value="\${esc(filterEnd)}" title="To date" style="width:150px">
        <select class="input-sm" id="filter-scope" style="width:200px">
          <option value="">All scopes</option>
          \${auditScopes.map(s => \`<option value="\${esc(s)}"\${filterScope === s ? " selected" : ""}>\${esc(s)}</option>\`).join("")}
        </select>
        <input class="input-sm" id="filter-belief" type="text" placeholder="Filter by belief ID"
          value="\${esc(filterBelief)}" style="width:200px">
        <button class="btn btn-primary" data-action="apply-filters">Filter</button>
        <button class="btn" data-action="clear-filters">Clear</button>
        <span style="margin-left:auto;font-size:.78rem;color:var(--muted)">\${total} record\${total === 1 ? "" : "s"}</span>
      </div>
      \${records.length === 0
        ? '<div class="empty">No injection audit records found.</div>'
        : records.map(renderRecord).join("")}
      \${totalPages > 1 ? \`
        <div class="pagination">
          <button class="btn" \${page === 0 ? "disabled" : ""} data-action="prev-page">Previous</button>
          <span style="font-size:.8rem;color:var(--muted);line-height:2">Page \${page + 1} of \${totalPages}</span>
          <button class="btn" \${page >= totalPages - 1 ? "disabled" : ""} data-action="next-page">Next</button>
        </div>
      \` : ""}
    </div>
  \`;

  if (detailRecord) renderDetail();
}

function renderRecord(r) {
  const pinCount = r.injected_beliefs?.pinned_facts?.length ?? 0;
  const relCount = r.injected_beliefs?.relevant_beliefs?.length ?? 0;
  const qCount = r.injected_beliefs?.open_questions?.length ?? 0;

  return \`
    <div class="record" data-id="\${esc(r._id)}">
      <div class="record-header">
        <span class="record-query">\${esc(truncate(r.user_query, 120))}</span>
        <span class="record-time">\${fmtDateTime(r.created_at)}</span>
      </div>
      <div class="record-meta">
        <span>Pinned: <code>\${pinCount}</code></span>
        <span>Relevant: <code>\${relCount}</code></span>
        <span>Questions: <code>\${qCount}</code></span>
        <span>Total: <code>\${r.belief_count}</code></span>
        \${r.scope?.length ? \`<span>Scope: <code>\${esc(r.scope.join(", "))}</code></span>\` : ""}
        \${r.agent_id ? \`<span>Agent: <code>\${esc(r.agent_id)}</code></span>\` : ""}
        <span style="color:\${r.injected ? 'var(--ok)' : '#d4a84b'}">\${r.injected ? "Injected" : "Observation only"}</span>
      </div>
      <div class="belief-group">
        \${(r.injected_beliefs?.pinned_facts ?? []).slice(0, 5).map(b =>
          \`<span class="belief-chip"><span class="chip-name">\${esc(b.canonical_name)}</span></span>\`
        ).join("")}
        \${(r.injected_beliefs?.relevant_beliefs ?? []).slice(0, 5).map(b =>
          \`<span class="belief-chip"><span class="chip-name">\${esc(b.canonical_name)}</span></span>\`
        ).join("")}
        \${r.belief_count > 10 ? \`<span style="font-size:.75rem;color:var(--muted)">+\${r.belief_count - 10} more</span>\` : ""}
      </div>
    </div>
  \`;
}

function openDetail(id) {
  detailRecord = records.find(r => r._id === id) ?? null;
  if (detailRecord) renderDetail();
}

function closeDetail() {
  detailRecord = null;
  const overlay = document.querySelector(".detail-overlay");
  if (overlay) overlay.remove();
}

function renderDetail() {
  const r = detailRecord;
  if (!r) return;

  const existing = document.querySelector(".detail-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "detail-overlay";

  const pinned = r.injected_beliefs?.pinned_facts ?? [];
  const relevant = r.injected_beliefs?.relevant_beliefs ?? [];
  const questions = r.injected_beliefs?.open_questions ?? [];

  overlay.innerHTML = \`
    <div class="detail-modal">
      <h2>Injection Detail</h2>
      <div style="margin-bottom:1rem">
        <div style="font-size:.82rem;color:var(--muted);margin-bottom:.25rem">User Query</div>
        <div style="font-size:.875rem;line-height:1.5">\${esc(r.user_query)}</div>
      </div>
      <div style="margin-bottom:1rem;display:flex;gap:1rem;flex-wrap:wrap;font-size:.75rem;color:var(--muted)">
        <span>Request: <code style="color:var(--text)">\${esc(r.request_id)}</code></span>
        <span>\${fmtDateTime(r.created_at)}</span>
        <span style="color:\${r.injected ? 'var(--ok)' : '#d4a84b'};font-weight:500">\${r.injected ? "Beliefs were injected" : "Observation mode (not injected)"}</span>
      </div>
      \${r.expanded_query ? \`<div style="margin-bottom:1rem;font-size:.78rem;color:var(--muted)">Expanded query: <em>\${esc(r.expanded_query)}</em></div>\` : ""}

      \${pinned.length ? \`
        <div class="belief-group-title">Pinned Facts (\${pinned.length})</div>
        \${pinned.map(renderDetailBelief).join("")}
      \` : ""}

      \${relevant.length ? \`
        <div class="belief-group-title" style="margin-top:1rem">Relevant Beliefs (\${relevant.length})</div>
        \${relevant.map(renderDetailBelief).join("")}
      \` : ""}

      \${questions.length ? \`
        <div class="belief-group-title" style="margin-top:1rem">Open Questions (\${questions.length})</div>
        \${questions.map(renderDetailBelief).join("")}
      \` : ""}

      <div style="display:flex;justify-content:flex-end;margin-top:1.25rem;border-top:1px solid var(--border);padding-top:1rem">
        <button class="btn btn-primary" data-action="close-detail">Close</button>
      </div>
    </div>
  \`;

  document.body.appendChild(overlay);
}

function renderDetailBelief(b) {
  return \`
    <div class="detail-belief">
      <div class="db-name">\${esc(b.canonical_name)}</div>
      <div class="db-content">\${esc(b.content)}</div>
      \${b.why_it_matters ? \`<div class="db-why">\${esc(b.why_it_matters)}</div>\` : ""}
      <div class="db-meta">
        \${b.type} | \${b.epistemic_status} | confidence: \${Math.round((b.confidence ?? 1) * 100)}%
        \${b.pinned ? " | pinned" : ""}
        \${b.scope?.length ? \` | scope: \${esc(b.scope.join(", "))}\` : ""}
      </div>
    </div>
  \`;
}

function applyFilters() {
  filterStart = document.getElementById("filter-start")?.value ?? "";
  filterEnd = document.getElementById("filter-end")?.value ?? "";
  filterBelief = document.getElementById("filter-belief")?.value?.trim() ?? "";
  filterScope = document.getElementById("filter-scope")?.value?.trim() ?? ""; 
  page = 0;
  init();
}

function clearFilters() {
  filterStart = "";
  filterEnd = "";
  filterScope = "";
  filterBelief = "";
  page = 0;
  init();
}

function prevPage() { if (page > 0) { page--; init(); } }
function nextPage() { page++; init(); }

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function fmtDateTime(d) {
  try { return new Date(d).toLocaleString(undefined, { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }); }
  catch { return String(d ?? ""); }
}

function showTokenScreen(err) {
  app.innerHTML = \`<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem">
    <div style="width:100%;max-width:380px">
      <h1 style="font-size:1.1rem;margin-bottom:.375rem">Tenure</h1>
      <p style="color:var(--muted);font-size:.875rem;margin-bottom:1.5rem">Enter your API token.</p>
      \${err ? \`<div style="color:var(--danger);font-size:.8rem;margin-bottom:.75rem">\${esc(err)}</div>\` : ""}
      <input id="tok" type="password" placeholder="your-token-here" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:monospace;font-size:.9rem;padding:.75rem 1rem;outline:none;margin-bottom:.75rem">
      <button class="btn btn-primary" style="width:100%" data-action="token-submit">Continue</button>
    </div>
  </div>\`;
  document.getElementById("tok")?.focus();
}

function handleToken() {
  const v = document.getElementById("tok")?.value?.trim();
  if (!v) return;
  token = v;
  localStorage.setItem(STORAGE_KEY, token);
  init();
}

document.addEventListener("click", e => {
  const record = e.target.closest(".record");
  if (record && !e.target.closest("button, a")) {
    const id = record.dataset.id;
    if (id) { openDetail(id); return; }
  }

  const el = e.target.closest("[data-action]");
  if (!el) return;
  switch (el.dataset.action) {
    case "apply-filters": applyFilters(); break;
    case "clear-filters": clearFilters(); break;
    case "prev-page": prevPage(); break;
    case "next-page": nextPage(); break;
    case "close-detail": closeDetail(); break;
    case "token-submit": handleToken(); break;
  }

  if (e.target.classList.contains("detail-overlay")) {
    closeDetail();
    return;
  }
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && detailRecord) closeDetail();
  if (e.key === "Enter" && document.getElementById("tok")) handleToken();
});

if (window.__TENURE_SSO_USER__) {
  init();
} else {
  token ? init() : showTokenScreen();
}

async function loadTaxDashboard() {
  try {
    const res = await apiFetch("GET", "/admin/audit/orientation-tax?days=30");
    if (!res.ok) return;
    const d = await res.json();
    const el = document.getElementById("tax-dashboard");
    if (!el) return;
    el.innerHTML = \`
      <div class="section-title">Orientation Tax (last 30 days)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin-bottom:.5rem">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:.875rem 1rem">
          <div style="font-size:1.5rem;font-weight:600;color:var(--ok)">\${d.orientation_tax_prevented}</div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:.25rem">Re-explanations prevented</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:.875rem 1rem">
          <div style="font-size:1.5rem;font-weight:600;color:var(--text)">\${d.estimated_minutes_saved}<span style="font-size:.8rem;color:var(--muted)"> min</span></div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:.25rem">Estimated time saved</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:.875rem 1rem">
          <div style="font-size:1.5rem;font-weight:600;color:\${d.orientation_tax_paid > 0 ? '#d4a84b' : 'var(--text)'}">\${d.orientation_tax_paid}</div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:.25rem">Tax still paid</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:.875rem 1rem">
          \${d.tax_rate_trend_pct === null
            ? \`<div style="font-size:1.5rem;font-weight:600;color:var(--muted)">—</div>
              <div style="font-size:.72rem;color:var(--muted);margin-top:.25rem">Trend (not enough data)</div>\`
            : \`<div style="font-size:1.5rem;font-weight:600;color:\${d.tax_rate_trend_pct < 0 ? 'var(--ok)' : d.tax_rate_trend_pct === 0 ? 'var(--text)' : '#d4a84b'}">
                \${d.tax_rate_trend_pct > 0 ? '↑' : d.tax_rate_trend_pct < 0 ? '↓' : '→'} \${Math.abs(d.tax_rate_trend_pct)}<span style="font-size:.8rem;color:var(--muted)">%</span>
              </div>
              <div style="font-size:.72rem;color:var(--muted);margin-top:.25rem">Re-explanation trend</div>\`
          }
        </div>
      </div>
      \${d.total_injected_turns > 0 ? \`
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:.625rem 1rem;margin-top:.5rem">
          <div style="height:6px;background:var(--surface2);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:\${Math.min(d.coverage_rate_pct, 100)}%;background:var(--accent);border-radius:3px;transition:width .3s"></div>
          </div>
          <div style="font-size:.7rem;color:var(--muted);margin-top:.375rem">\${d.total_injected_turns} turns with beliefs injected</div>
        </div>
      \` : ""}
    \`;
  } catch {}
}
<\/script>
</body>
</html>`;
}
