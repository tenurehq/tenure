# Tenure for VS Code

> Persistent, cross-application AI memory. Fully local, fully private, and now completely automatic. **(BYOK) Bring your own key and use Tenure directly inside VS Code's native chat interface**, no Copilot subscription required.

## The workflow this unlocks

You spend an hour in OpenWebUI thinking through an architecture problem. You explore options, rule some out, and land on a direction. Then you open VS Code to start building.

Tenure is already there. It knows what you decided, what you rejected, and why. You do not re-explain anything. You just build.

This works because Tenure runs as a local proxy outside any single tool. OpenWebUI, LibreChat, Cline, Continue, Windsurf, and any OpenAI-compatible chat client connect through `localhost:5757`. The VS Code extension brings your IDE into the same memory layer, and because it registers as a native language-model provider, Tenure appears directly in Copilot Chat with no manual configuration.

## Zero-config installation

1. Install the extension from the VS Code marketplace.
2. When prompted, click **Set Up Tenure**.
3. The extension downloads and starts the Tenure Docker container, reads your API token from `~/.tenure/token`, and stores it securely in VS Code secrets.
4. The onboard wizard opens automatically. Connect your OpenAI or Anthropic API key and pick a default model.

That is it. Tenure is ready.

If Docker Desktop is not running, the extension will prompt you to start it. If port 5757 is occupied, it will warn you before proceeding.

## How it solves drift

Beyond cross-interface continuity, Tenure fixes the way AI coding sessions break through drift. A script gets renamed in `package.json`. A config file moves. A rule you wrote for Cline never makes it into the equivalent for Windsurf. The agent works from whatever it was last told, and what it was last told is increasingly wrong.

The deeper issue is duplication. Anything that copies information already in your code or config will go stale. Anything that points to that information tends to stay correct. Most `AGENTS.md` files are full of copies.

Tenure does not duplicate. It learns.

## What the extension does

- **Installs and manages Tenure automatically** via Docker.
- **Saves your API token** without manual copy-paste.
- **Registers as a native LM provider** in VS Code so Tenure models appear in the Copilot Chat picker.
- **Pushes workspace context** on every file switch - project name, active file, and language - so the proxy resolves the right project scope before your first message.
- **Auto-configures other extensions** when possible (for example, Continue) and shows copy-paste instructions for the rest.

### Native VS Code integration

Tenure registers as a first-class language-model provider inside VS Code. After you connect your own OpenAI or Anthropic API key during setup, Tenure models appear directly in the Copilot Chat model picker with no secondary panels or browser tabs. You get streaming completions, tool calling, and the full native chat experience, all routed through your local Tenure proxy so your cross-project memory is injected automatically.

## Project scope

Tenure resolves your project name from a `.tenure` file at your workspace root. Create one with just your project name:

```
my-project
```

If no `.tenure` file exists, Tenure falls back to your git remote name, then a stable slug derived from your workspace folder name. Scope resolution never fails silently.

Run **Tenure: Create .tenure File** from the command palette to scaffold one automatically using the name Tenure has already resolved for your project.

## Which clients work with Tenure?

Tenure works with any client where you control the base URL. The VS Code extension detects your setup and adapts:

| Client                       | Integration                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| VS Code Copilot Chat         | Native model picker integration. Use your own API key; no Copilot subscription needed. |
| Continue                     | One-click automatic configuration                                                      |
| Cline / Roo Code             | Notification with copyable URL and token                                               |
| Cursor / Windsurf            | Host-app detection with tailored instructions                                          |
| Any OpenAI-compatible client | Point to `http://localhost:5757/v1`                                                    |

Cursor Pro and the Claude Code VS Code extension route through their own backends by default. Claude Code can be configured to route through an external proxy using `claudeCode.disableLoginPrompt: true`.

## Commands

| Command                          | Description                                          |
| -------------------------------- | ---------------------------------------------------- |
| `Tenure: Set API Token`          | Store your Tenure token manually (usually automatic) |
| `Tenure: Sync Workspace State`   | Manually trigger a workspace sync                    |
| `Tenure: Open Beliefs Dashboard` | Open `localhost:5757/beliefs` in your browser        |
| `Tenure: Record Project Belief`  | Record a belief directly from the command palette    |
| `Tenure: Run Setup`              | Open the onboard wizard to add a provider or model   |

## Settings

| Setting          | Default                 | Description                     |
| ---------------- | ----------------------- | ------------------------------- |
| `tenure.baseUrl` | `http://localhost:5757` | URL of your local Tenure proxy  |
| `tenure.enabled` | `true`                  | Enable or disable the extension |

## Advanced: manual installation

If you prefer to run Docker commands yourself, you can still install Tenure manually. The extension will detect it and save your API token automatically on first connect.

**macOS / Linux:**

```bash
docker run --rm -v "$HOME/.tenure:/app/.tenure" tenureai/tenure:latest init
docker run -d -v "$HOME/.tenure:/app/.tenure" -p 5757:5757 tenureai/tenure:latest
```

**Windows (PowerShell):**

```powershell
docker run --rm -v "$env:USERPROFILE\.tenure:/app/.tenure" tenureai/tenure:latest init
docker run -d -v "$env:USERPROFILE\.tenure:/app/.tenure" -p 5757:5757 tenureai/tenure:latest
```

Your API token is saved to `~/.tenure/token` after the first command.

## Why not just use AGENTS.md or shared MCP memory?

`AGENTS.md` works until it drifts. The most common failure mode is stale paths, renamed scripts, and instructions nobody updated after a refactor. The file becomes a liability the more it tries to duplicate what is already in your config.

Shared MCP memory across tools is mostly experimental. Memory one tool writes and another reads only works if both are disciplined about when to write and when to retrieve. In practice that coordination is not there yet.

Tenure runs locally, outside any single tool, and uses a proxy layer that all your clients route through. The memory is written once and applied everywhere, without requiring each tool to implement the same retrieval discipline.

## Learn more

- [Quickstart](https://github.com/tenurehq/tenure#quick-start)
- [How beliefs work](https://github.com/tenurehq/tenure/blob/main/docs/beliefs.md)
- [Retrieval and scoping](https://github.com/tenurehq/tenure/blob/main/docs/retrieval.md)
- [Research paper](https://arxiv.org/abs/2605.11325)
