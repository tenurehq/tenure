# VS Code

The Tenure VS Code extension integrates Tenure directly into VS Code's native AI experience. By registering as a language model provider, Tenure powers chat, inline completions, code actions, and other AI features built into the editor, all routed through your own model provider rather than GitHub's infrastructure.

The extension also synchronizes workspace state with your Tenure server on every file switch, so every request is automatically scoped to the correct project before it reaches the model.

> **This extension requires a Tenure server.** It can either install Tenure locally via Docker or connect to an existing enterprise or self-hosted instance. It has no standalone value without a running server.

## Requirements

- **Local mode:** Docker Desktop (the extension can install Tenure automatically)
- **Enterprise mode:** A running Tenure server and a valid API token
- VS Code 1.80 or later
- A workspace folder open. The extension does not activate in single-file mode.

## First-time setup

The first time you activate the extension, it checks the server configured in `tenure.baseUrl`. If nothing is reachable and you have not yet configured a deployment, a **Configure Tenure** picker appears automatically:

| Option                       | What it does                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local (Docker)**           | Installs and starts Tenure in a local Docker container. The extension handles the entire setup.                                                          |
| **Enterprise / Self-hosted** | Prompts for your Tenure server base URL (e.g. `https://tenure.company.com:5757`) and API token, then stores them in VS Code settings and secret storage. |

If you dismissed the picker, you can reopen it at any time via **Tenure: Configure Deployment** in the command palette.

## No paid Copilot subscription required

Tenure uses VS Code's Language Model APIs to provide native AI features without requiring a paid GitHub Copilot subscription. You only need to be signed into GitHub. The free Copilot plan is sufficient.

Once signed in, Tenure becomes the active language model provider inside VS Code. Chat, inline completions, and code actions all route through your Tenure server rather than GitHub's infrastructure, which means your billing relationship is with your chosen model provider, not GitHub.

## Bring your own model provider

Tenure connects to whichever model provider your organization uses. Supported options include Anthropic, AWS Bedrock, local models (if your hardware supports it), and others. Tenure gates model selection to frontier-capable models, so you always get a model with enough capability to power the full VS Code AI feature set.

Because requests route through your provider rather than a third-party metered service, your costs are predictable and controlled by you.

## Automatic project awareness

Tenure knows which project you are working in before a request is sent.

The extension continuously synchronizes workspace state with your Tenure server, resolving project scope automatically on every file switch. Every chat message, completion, and code action is enriched with the correct project context without requiring manual selection or prompt engineering.

## Adding your token

If you are connecting to an enterprise server, you are prompted for a token during setup. You can also set or update it manually at any time:

1. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **Tenure: Set API Token**
3. Paste your token

The token is stored in VS Code's secret storage. You only need to do this once.

If no token is configured, the extension shows a warning on startup and the status bar displays **Tenure: Token Missing**. Clicking it opens the token prompt.

## Pointing a third-party AI client at Tenure

If you prefer to use a third-party client rather than the native LM provider, point it at your Tenure proxy endpoint:

```
<tenure.baseUrl>/v1
```

The default is `http://localhost:5757/v1`. If you selected **Enterprise / Self-hosted**, the URL will match the domain you entered. The exact base URL is shown in the onboarding panel when setup completes.

The extension handles scope regardless of which client you use. Compatible clients include Cline, Continue, Windsurf, Cursor, and others that accept a custom base URL. See the individual client pages for setup details.

## Project scope

Tenure resolves your project name from a `.tenure` file at your workspace root. Create one with just your project name:

```
my-project
```

If no `.tenure` file exists, Tenure falls back to your git remote name, then a stable slug derived from your workspace folder name. Scope resolution never fails silently.

Run **Tenure: Create .tenure File** from the command palette to scaffold one automatically using the name Tenure has already resolved for your project.

## Overriding scope manually

If the automatic resolution picks up the wrong project name, you can override it with a `.tenure` file in your workspace root:

```
my-project
```

This takes priority over all manifest-based resolution. You can also set scope directly from your chat session:

```
!scope project:my-project
```

## Status bar

The status bar item in the bottom-right shows the current sync state:

| Status                  | Meaning                                          |
| ----------------------- | ------------------------------------------------ |
| `Tenure: my-project`    | Synced, showing resolved project name            |
| `Tenure: Token Missing` | No token configured, click to set one            |
| `Tenure: Restricted`    | Workspace not trusted, file-based scope disabled |
| `Tenure: Disabled`      | Extension disabled in settings                   |

Clicking the status bar item when synced opens your Beliefs Dashboard at your configured `tenure.baseUrl`.

## Commands

| Command                                | Description                                       |
| -------------------------------------- | ------------------------------------------------- |
| `Tenure: Configure Deployment`         | Choose local Docker install or enterprise server  |
| `Tenure: Set API Token`                | Store your Tenure bearer token                    |
| `Tenure: Sync Workspace State`         | Trigger a manual sync                             |
| `Tenure: Open Beliefs Dashboard`       | Open your Tenure dashboard in a browser           |
| `Tenure: Record Project Belief`        | Record a belief directly from the command palette |
| `Tenure: Record Belief from Selection` | Record a belief from selected code                |
| `Tenure: Create .tenure File`          | Scaffold a .tenure file with your resolved name   |

## Settings

| Setting          | Default                 | Description                                |
| ---------------- | ----------------------- | ------------------------------------------ |
| `tenure.baseUrl` | `http://localhost:5757` | URL of your Tenure proxy (local or remote) |
| `tenure.enabled` | `true`                  | Enable or disable the extension            |

## Docker networking

If Tenure is running in Docker and your VS Code is on the host machine, the default `localhost:5757` should work. If you run into connection issues, check that the Tenure container is binding to `0.0.0.0` rather than `127.0.0.1`.

This section applies only to **local** deployments.

## Troubleshooting

**"Tenure isn't running" notification at startup**
If you already configured an enterprise server, verify that `tenure.baseUrl` is correct and the server is reachable. If you intended to run locally, choose **Set Up Tenure** or run **Tenure: Configure Deployment** to switch modes.

**Status bar shows "Token Missing" after setting the token**
Run **Tenure: Sync Workspace State** from the command palette to force a sync.

**Native LM features are not appearing**
Confirm the extension is enabled and a token is configured. The LM provider only registers after a successful connection to your Tenure server. Check the Output panel under **Tenure** for connection errors.

**Project name is wrong**
Add a `.tenure` file to your workspace root containing your project name, or run **Tenure: Create .tenure File** to scaffold one automatically. The file takes priority over all other resolution methods.

**Extension is not activating**
The extension requires a workspace folder to be open. It will not activate in single-file mode or when no folder is loaded.

**Sync fails silently**
Confirm that your Tenure server is reachable at the URL configured in `tenure.baseUrl`. The extension probes that exact address; if you changed it after initial setup, run **Tenure: Configure Deployment** again to update the URL and token.
