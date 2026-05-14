# Settings

Manage Tenure at `http://localhost:5757/admin`. Changes take effect immediately unless noted.

## Providers

Connect the upstream LLM providers Tenure routes requests to. Tenure supports two direct providers and any OpenAI-compatible endpoint.

**Anthropic**: paste your Anthropic API key. Supports prompt caching.

**OpenAI (or compatible endpoint)**: paste your API key and choose an endpoint type:

| Endpoint type          | When to use                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Generic OpenAI         | Standard OpenAI API or any compatible endpoint                                           |
| Bedrock Access Gateway | AWS Bedrock via BAG. Enables prompt caching, cutting input costs by up to 90%            |
| LiteLLM                | LiteLLM proxy. Caching hints are translated automatically where the upstream supports it |

For Bedrock Access Gateway and LiteLLM, a base URL is required. For Generic OpenAI it is optional: leave blank to use the default OpenAI endpoint.

See [providers.md](providers.md) for full setup details.

## Default Model

The model used for belief extraction and onboarding. Click **Browse** to load the available models from your configured provider. Models are grouped into three tiers:

- **Supported**: verified to produce reliable structured output for extraction
- **Unknown family**: unrecognized model, usable at your own risk
- **Below tier floor**: does not meet the minimum quality requirement, disabled

See [providers.md](providers.md) for the supported model list.

## Extraction

Tenure learns about you by extracting beliefs from your conversations. This
happens asynchronously after every response, so it never blocks your session.
Extraction can be controlled at three levels, from broadest to narrowest:

### Global toggle

The toggle in Settings pauses extraction everywhere. When off, Tenure still
injects your existing beliefs into every session, your world model stays
active, it just stops growing. Use this when you want a clean break, or while
you clean up your belief store before re-enabling.

### Session-level commands

You can pause and resume extraction from within any chat session without
touching Settings:

| Command               | Effect                                                     |
| --------------------- | ---------------------------------------------------------- |
| `!extract off`        | Pauses extraction for this session only                    |
| `!extract on`         | Resumes extraction for this session                        |
| `!extract global off` | Pauses extraction everywhere (same as the Settings toggle) |
| `!extract global on`  | Re-enables extraction everywhere                           |

When you send `!extract off`, Tenure responds with a confirmation. Your
existing beliefs are still injected into that session, the model still
knows your context, it just stops recording new things you say.

**On session boundaries**: `!extract off` persists until you explicitly send
`!extract on`, or until your client starts a session with a new session ID.
If your client reuses session IDs across conversations, the pause will carry
over. Send `!extract on` to re-enable when you're ready.

### What "paused" means in practice

Pausing extraction does not make Tenure forget anything. It does not clear
your world model or stop belief injection. The only thing that stops is the
extraction worker writing new beliefs from that session's exchanges. Think
of it as the difference between working with a colleague who remembers
everything you've told them, versus one who is also taking notes. Paused
means no new notes.

## Injection

Tenure injects relevant beliefs from your world model into each session as context. Injection can be controlled at the session or global level without touching Settings.

### Session-level commands

| Command              | Effect                                        |
| -------------------- | --------------------------------------------- |
| `!inject off`        | Pauses belief injection for this session only |
| `!inject on`         | Resumes belief injection for this session     |
| `!inject global off` | Disables belief injection everywhere          |
| `!inject global on`  | Re-enables belief injection everywhere        |

When you send `!inject off`, the model will receive no belief context for the remainder of that session. Extraction continues unless you also send `!extract off`. To get a fully clean session with no memory of past context and no new beliefs recorded, send both commands.

**On session boundaries**: like `!extract off`, injection pause persists until you explicitly send `!inject on`, or until your client starts a session with a new session ID.

## Scope

**Automatic scope detection**: when enabled, Tenure infers the domain from your first message each session and sets scope automatically. When disabled, scope is only set via explicit `!scope` commands or client metadata. In explicit-only mode, sessions without a declared scope surface only `user:universal` beliefs.

### Setting scope manually

You can set the active scope directly from any chat session:

| Command                            | Effect                                  |
| ---------------------------------- | --------------------------------------- |
| `!scope domain:code`               | Sets scope to a top-level domain        |
| `!scope domain:code/typescript`    | Sets scope to a technology sub-domain   |
| `!scope project:my-project`        | Sets scope to a named project           |
| `set scope domain:code/typescript` | Alternative syntax, identical behaviour |

Multiple scopes can be set at once by separating them with spaces or commas, for example `!scope domain:code/typescript domain:writing`.

**Scope format rules:**

- `domain:<slug>` -- a top-level domain (e.g. `domain:code`, `domain:writing`, `domain:music`)
- `domain:<slug>/<tech>` -- a technology or topic sub-domain (e.g. `domain:code/typescript`, `domain:code/python`)
- `project:<slug>` -- a specific named project (e.g. `project:my-app`)

When you set a sub-domain scope such as `domain:code/typescript`, Tenure automatically expands the hierarchy to include parent scopes, so you do not need to list them separately.

## Your Persona

The persona is a synthesized summary of who you are and how you work, injected into every session as standing context. It has two parts:

**Universal prelude**: applies to every session regardless of scope. Summarizes your communication style, working preferences, and expertise level drawn from onboarding answers and beliefs accumulated over time.

**Per-scope preludes**: domain-specific summaries that appear alongside the universal prelude when a scoped session is active. For example, a code scope prelude might describe your stack and conventions; a writing scope prelude might describe your voice and genre.

The persona is generated automatically from your onboarding answers and updated as your belief store grows. Click **Regenerate** to rebuild it from your current beliefs immediately: useful after a large import or a significant change to your world model.

## Advanced

These settings are hidden by default. Most users won't need to change them.

**Belief context token target**: how many tokens to budget for injected beliefs per request. Lower values mean less context per session; higher values inject more but increase cost and latency. Default: 400.

**Strict model tiers**: when enabled, only verified models can be selected as the default. Disable this if you are running a self-hosted or custom model that isn't in the supported list.

## API Token

Your bearer token for authenticating requests to Tenure. This is the token you paste into your client's API settings.

**Rotate token**: generates a new token immediately and invalidates the current one. Your active session will end. Copy the new token before dismissing the confirmation dialog: it is also saved to `~/.tenure/token` (Linux/macOS) or `%USERPROFILE%\.tenure\token` (Windows).

## Maintenance

**Run compaction now**: merges overlapping and redundant beliefs in your world model. Compaction runs automatically every 30 minutes. Trigger it manually after a large import or onboarding run to consolidate beliefs immediately.

## Backup & Restore

See [backup.md](backup.md) for full details.

**Export**: click **Preview** to see a count of what will be included (active beliefs, sessions, and whether a persona is present), then enter a passphrase and click **Export** to download an encrypted archive to your downloads folder.

**Import**: select a `.enc` archive file, enter the passphrase, and click **Import**. Two options are available:

- **Skip existing beliefs**: beliefs already in your world model with the same ID are left untouched. On by default.
- **Restore settings**: also restores provider credentials and configuration from the archive. On by default.
