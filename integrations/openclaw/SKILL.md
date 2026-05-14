---
name: tenure
description: Gives your OpenClaw agent persistent local memory that learns how you think and speak. Beyond just remembering facts, Tenure adapts to your communication patterns, communication style, and depth calibration, knowing exactly how you want information delivered. It automatically tracks your stack decisions and what you’ve ruled out, fixing 'goldfish brain' without needing to maintain MEMORY.md. Your AI doesn't just remember your data; it remembers you.
version: 1.0.0
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "homepage": "https://github.com/jeffreyflynt/tenure",
        "requires": { "bins": ["docker"] },
        "primaryEnv": "TENURE_TOKEN",
        "envVars":
          [
            {
              "name": "TENURE_TOKEN",
              "required": false,
              "description": "Bearer token printed by Tenure on first start. Auto-populated during install.",
            },
          ],
        "install":
          [
            {
              "kind": "brew",
              "os": ["darwin"],
              "formula": "docker",
              "bins": ["docker"],
              "label": "Install Docker Desktop (macOS)",
            },
            {
              "kind": "download",
              "os": ["win32"],
              "url": "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
              "label": "Install Docker Desktop (Windows)",
            },
            {
              "kind": "download",
              "os": ["linux"],
              "url": "https://docs.docker.com/engine/install/",
              "label": "Install Docker Engine (Linux)",
            },
          ],
      },
  }
---

# Tenure — Memory That Actually Sticks

Every session starts from zero. You re-explain your stack, your preferences,
the decisions you made last week. Tenure fixes that.

Tenure sits between OpenClaw and your LLM provider and learns from your
conversations — your tools, your opinions, what you have ruled out and why.
It brings that context into every session automatically, without you
doing anything.

No cloud backend. No third-party API key. Everything stays on your machine.

If you maintain USER.md or MEMORY.md by hand, Tenure replaces both.

## When to activate this skill

Activate when the user says any of the following or close variations:

- "install Tenure"
- "set up memory"
- "remember my preferences"
- "I want persistent memory"
- "give me long-term memory"

## Installing Tenure

Run these steps in order. Tell the user what you are doing before each
step. Do not skip steps or combine them.

### Step 1 — Check Docker is running

Use exec to verify Docker is available and the daemon is running:

```bash
docker info
```

If this fails, tell the user to start Docker Desktop and try again
before continuing. Do not proceed until Docker is confirmed running.

### Step 2 — Check port 5757 is free

Use exec to check whether the port is available:

```bash
lsof -i :5757 2>/dev/null || echo "port-free"
```

On Linux if lsof is not available:

```bash
ss -tln 2>/dev/null | grep :5757 || echo "port-free"
```

On Windows:

```powershell
netstat -ano | findstr :5757
if ($LASTEXITCODE -ne 0) { Write-Host "port-free" }
```

If the port is in use, tell the user to free it or set TENURE_PORT to
a different value before continuing. They will need to substitute that
port everywhere localhost:5757 appears in the remaining steps.

### Step 3 — Initialize Tenure

Use exec to run the init command. This runs inside the container so
it works correctly on all platforms. It creates the config directory,
writes the compose file, and generates MongoDB credentials without
relying on any host shell tools.

On Linux and macOS:

```bash
mkdir -p "$HOME/.tenure"
docker run --rm \
  -v "$HOME/.tenure:/app/.tenure" \
  tenureai/tenure:latest init
```

On Windows:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.tenure" | Out-Null
docker run --rm `
  -v "$env:USERPROFILE\.tenure:/app/.tenure" `
  tenureai/tenure:latest init
```

This step is idempotent. Running it twice is safe. It checks before
writing and will not overwrite existing credentials or the compose file.

### Step 4 — Start Tenure

Use exec to start the containers. Docker pulls MongoDB automatically
if not already present:

On Linux and macOS:

```bash
docker compose -f "$HOME/.tenure/docker-compose.yml" \
  --env-file "$HOME/.tenure/.env" up -d
```

On Windows:

```powershell
docker compose -f "$env:USERPROFILE\.tenure\docker-compose.yml" `
  --env-file "$env:USERPROFILE\.tenure\.env" up -d
```

### Step 5 — Wait for Tenure to be ready

Use exec to poll the health endpoint. Wait up to 60 seconds:

On Linux and macOS:

```bash
TENURE_PORT="${TENURE_PORT:-5757}"
ATTEMPTS=0
until curl -sf "http://localhost:${TENURE_PORT}/healthz" >/dev/null 2>&1 \
  || [ $ATTEMPTS -ge 30 ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 2
done
if [ $ATTEMPTS -ge 30 ]; then
  echo "timeout"
else
  echo "ready"
fi
```

On Windows:

```powershell
$port = if ($env:TENURE_PORT) { $env:TENURE_PORT } else { "5757" }
$attempts = 0
$ready = $false
while ($attempts -lt 30) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$port/healthz" `
      -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  $attempts++
  Start-Sleep -Seconds 2
}
if (-not $ready) { Write-Host "timeout" } else { Write-Host "ready" }
```

If the result is "timeout", tell the user Tenure may still be
initializing and suggest checking logs:

```bash
docker compose -f "$HOME/.tenure/docker-compose.yml" logs tenure
```

### Step 6 — Read the token

Use exec to read the token from the running container:

```bash
docker compose -f "$HOME/.tenure/docker-compose.yml" \
  exec tenure node dist/index.js token
```

If the container is not yet running use the run variant instead:

```bash
docker compose -f "$HOME/.tenure/docker-compose.yml" \
  run --rm tenure node dist/index.js token
```

On Windows replace $HOME/.tenure with $env:USERPROFILE\.tenure in
both commands above.

Store the token value. You will use it in Step 7.
Do not display the token value in chat.

### Step 7 — Write the provider block

Use exec to apply the provider config atomically. Replace TOKEN with
the value read in Step 6:

```bash
TOKEN="<value from step 6>"

openclaw config patch --stdin << EOF
{
  models: {
    mode: "merge",
    providers: {
      tenure: {
        baseUrl: "http://localhost:5757/v1",
        apiKey: "$TOKEN",
        api: "openai-completions",
        request: { allowPrivateNetwork: true }
      }
    }
  }
}
EOF
```

No models array is needed. OpenClaw calls /v1/models automatically
and discovers whatever the user has configured in Tenure.

Then validate the config:

```bash
openclaw config validate
```

If validation fails, do not proceed. Show the user the error and
suggest running `openclaw doctor --fix`.

### Step 8 — Restart the gateway

Use exec to restart the gateway so the new provider is picked up:

```bash
openclaw gateway restart
```

### Step 9 — Confirm and hand off

Tell the user:

- Tenure is running at http://localhost:5757
- Their existing provider is still configured and will be used as
  fallback. The setup is fully reversible by removing the tenure
  block from models.providers.
- They should open http://localhost:5757/onboarding to connect a
  provider, pick a default model, and answer a few questions to seed
  their world model. Onboarding is optional but recommended for the
  first session.
- They can view their world model at http://localhost:5757/beliefs
  at any time.

If the user is on a mobile channel (WhatsApp or Telegram), note that
the localhost URLs will not open on their phone. Tell them to open
those URLs on the machine running OpenClaw's gateway.

## The !tenure slash command

When the user runs `!tenure` with no arguments, check status and
report back.

Check health:

```bash
curl -sf http://localhost:5757/healthz
```

If the response contains `"ok":true`, report Tenure is running.
If the request fails, report Tenure is not reachable and suggest:

```bash
docker compose -f "$HOME/.tenure/docker-compose.yml" logs tenure
```

Also show:

- Current provider config: `openclaw config get models.providers.tenure`
- Link to http://localhost:5757/beliefs to view the world model

When the user runs `!tenure onboarding`, tell them to open
http://localhost:5757/onboarding in their browser. On mobile channels
remind them to open it on the machine running OpenClaw's gateway.

When the user runs `!tenure update`:

```bash
docker compose -f "$HOME/.tenure/docker-compose.yml" pull
docker compose -f "$HOME/.tenure/docker-compose.yml" up -d
```

## Session commands

Tenure intercepts these commands directly in chat. No slash command setup
required — just send them as a message.

### Extraction

| Command               | Effect                                                     |
| --------------------- | ---------------------------------------------------------- |
| `!extract off`        | Pauses extraction for this session only                    |
| `!extract on`         | Resumes extraction for this session                        |
| `!extract global off` | Pauses extraction everywhere (same as the Settings toggle) |
| `!extract global on`  | Re-enables extraction everywhere                           |

Pausing extraction does not affect injection. Your existing beliefs are
still injected into every session — Tenure just stops recording new ones.

### Injection

| Command              | Effect                                                    |
| -------------------- | --------------------------------------------------------- |
| `!inject off`        | Pauses belief injection for this session only             |
| `!inject on`         | Resumes belief injection for this session                 |
| `!inject global off` | Disables injection everywhere — model receives no context |
| `!inject global on`  | Re-enables injection everywhere                           |

For a fully clean session with no memory in or out, send both
`!extract off` and `!inject off`.

### Scope

| Command                         | Effect                                |
| ------------------------------- | ------------------------------------- |
| `!scope domain:code`            | Sets scope to a top-level domain      |
| `!scope domain:code/typescript` | Sets scope to a technology sub-domain |
| `!scope project:myapp`          | Sets scope to a named project         |

Multiple scopes can be set at once: `!scope domain:code project:myapp`.
Scope determines which beliefs are surfaced. Sessions without an explicit
scope surface only universal beliefs.

## Notes for the agent

- Tenure runs entirely locally. Nothing leaves the user's machine.
- Docker image pulls are verified by digest. No additional checksum
  step is needed.
- The init command in Step 3 is idempotent. Running it twice is safe.
  It checks before writing and will not overwrite existing credentials
  or the compose file.
- Belief extraction runs asynchronously after every response and never
  blocks the session.
- The user can pause extraction per-session by typing `!extract off`
  directly in chat.
- Do not display the token value in chat at any point.
- models.mode: "merge" ensures existing provider config is preserved
  when writing the tenure block.
- The health endpoint is /healthz not /health.
- No models array is needed in the provider block. OpenClaw discovers
  available models from /v1/models automatically.
- The pause and resume commands call POST /admin/settings with
  extraction_enabled. Confirm this field name matches the admin
  routes before publishing to ClawHub.
