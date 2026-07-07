# Client Setup

Tenure works with any OpenAI-compatible or Anthorpic client. Point it at `http://localhost:5757/v1` with the appropriate Tenure access token and it routes through Tenure automatically.

> **Docker networking note:** If your client runs in Docker, `localhost` won't resolve to your host machine. Use `http://host.docker.internal:5757/v1` instead (Docker Desktop on Mac/Windows) or your host's LAN IP on Linux.

## Chat

Chat interfaces are where Tenure does its best work. Brainstorming, deciding, refining; the reasoning that happens here builds your belief store over time.

| Client                              | Integration     | Status      |
| ----------------------------------- | --------------- | ----------- |
| [Open WebUI](clients/open-webui.md) | Point and shoot | Supported   |
| [LibreChat](clients/librechat.md)   | Point and shoot | Coming soon |
| [Onyx](clients/onyx.md)             | Point and shoot | Coming soon |

**Point and shoot setup:** In your client's API settings, set the base URL to `http://localhost:5757/v1` and paste a **client token** generated from the Tenure UI. Select any model and start chatting.

## IDE

IDE clients receive a memory-informed context on every request. Your preferences, decisions, and project conventions are injected automatically without extra setup.

The [VS Code extension](clients/vscode.md) adds real-time workspace scope resolution, so Tenure knows which project you're working in before your first message is sent. It covers any IDE built on VS Code.

| Client                                | Integration      | Status      |
| ------------------------------------- | ---------------- | ----------- |
| [VS Code](clients/vscode.md)          | Native extension | Supported   |
| [Cursor](clients/cursor.md)           | Native extension | Supported   |
| [Windsurf](clients/windsurf.md)       | Native extension | Supported   |
| [Cline](clients/cline.md)             | Native extension | Supported   |
| [Continue](clients/continue.md)       | Native extension | Supported   |
| [Claude Code](clients/claude-code.md) | Point and shoot  | Coming soon |

**Point and shoot setup:** In your IDE's AI settings, replace the base URL with `http://localhost:5757/v1` and add a **client token** generated from the Tenure UI.

> The bootstrap token created on first install is for setup and admin access. External clients and IDEs need to use a client token created from the Tenure UI.

## Agents

Agent integrations run through Tenure with automatic per-agent memory isolation. Memory written in one agent never surfaces in another unless you explicitly design for shared scope.

This model applies to any agent framework that routes through Tenure. Some integrations are native plugins, while others can connect over Tenure's supported API surfaces.

| Client                          | Integration   | Status    |
| ------------------------------- | ------------- | --------- |
| [OpenClaw](clients/openclaw.md) | Native plugin | Supported |

## Manual mode

If you prefer to manage your belief store by hand, extraction can be disabled entirely. Tenure still injects whatever you have authored into every session.

To disable extraction globally: **Admin Panel > Settings > Extraction > Enabled: off**

To disable per-session, add a request header: `X-Tenure-No-Extract: true`

Or type `!extract off` directly in your chat session.
