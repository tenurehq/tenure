# Changelog

All notable changes to Tenure will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.31] - 2026-07-15

### Changed

- **Core server dependencies updated** (`package.json`, `package-lock.json`): Upgraded Fastify to 5.10.0, `@fastify/helmet` to 13.1.0, `@fastify/static` to 10.1.0, and `@fastify/websocket` to 11.3.0. Related Fastify plugins and transitive dependencies were refreshed accordingly.

- **Database dependencies updated** (`package.json`, `package-lock.json`): Upgraded the MongoDB driver to 7.5.0 and MongoDB Client-Side Field Level Encryption support to 7.2.0, along with associated native module and connection dependencies.

- **Utility and scheduling dependencies updated** (`package.json`, `package-lock.json`): Upgraded `jsonrepair` to 3.15.0 and `toad-scheduler` to 4.1.0, while pinning updated dependency versions for reproducible installs.

- **OpenClaw integration updated** (`integrations/openclaw/package.json`, `integrations/openclaw/package-lock.json`): Upgraded OpenClaw from 2026.6.8 to the 2026.7.1-compatible release range and refreshed its AI provider SDKs, browser automation, Telegram, filesystem safety, archive, networking, parsing, and runtime dependencies.

- **OpenClaw Node.js requirements tightened** (`integrations/openclaw/package-lock.json`): Updated the supported Node.js engine range to require Node.js 22.22.3, 24.15.0, or 25.9.0 and later within their respective major versions.

- **OpenClaw plugin version bumped** (`integrations/openclaw/package.json`): Incremented `@tenureai/openclaw-plugin` from 1.0.16 to 1.0.17.

---

## [1.0.30] - 2026-07-07

### Added

- **Typed access token system for clients and agents** (`src/auth/tokenService.ts`, `src/routes/tokens.ts`, `src/types/token.ts`, `src/db/collections.ts`, `src/db/indexes.ts`, `src/server.ts`): Introduced token kinds for `root`, `client`, and `agent`, with capability-based authorization, per-token metadata, optional project scope restrictions, revocation support, and persisted token hashing. Admin APIs now support generating and managing client and agent tokens, and request handling now attaches token identity and capability context across the app.

- **Token management UI in admin dashboard** (`src/routes/admin-ui.ts`): Added Access Tokens management to the admin UI with separate flows for client and agent tokens, capability selection, optional project scope restriction, optional expiry, one-time token display, copy support, and revocation actions.

- **Project-scope token enforcement helpers** (`src/server.ts`, `src/helpers/scopeAccess.ts`, `src/routes/beliefs.ts`, `src/routes/chat.ts`, `src/routes/messages.ts`, `src/routes/beliefs-ws.ts`): Added helpers that validate requested project scopes against token-authorized scopes and applied them across chat, messages, beliefs APIs, import flows, and belief WebSocket operations.

- **Token attribution in audit and extraction flows** (`src/audit/injectionAuditLogger.ts`, `src/types/injectionAudit.ts`, `src/types/job.ts`, `src/jobs/queue.ts`, `src/routes/shared/sideEffects.ts`, `src/extraction/beliefWriter.ts`): Added token ID, token name, and token kind to injection audit records, extraction jobs, and persisted beliefs so downstream actions can be traced back to the calling integration token.

### Changed

- **Authentication model shifted from bearer/PATs and team auth to access-token governance** (`src/server.ts`, `src/routes/admin.ts`, `src/config/runtime.ts`, `src/config/appConfig.ts`): Replaced the prior root token plus PAT flow with token-service validation and capability checks. Root-token-only admin access is now enforced centrally, while non-root tokens are limited by route type and declared capabilities.

- **Bootstrap token behavior and docs updated** (`docs/quickstart.md`, `docs/clients.md`, `docs/clients/open-webui.md`, `docs/clients/vscode.md`, `docs/settings.md`, `README.md`): Documentation now distinguishes bootstrap tokens from client and agent tokens. External clients and IDEs must use client tokens generated from the Tenure UI, while bootstrap tokens are reserved for setup and admin access.

- **Credential and config storage hardened** (`src/config/encryption.ts`, `src/config/appConfig.ts`, `src/app.ts`): API tokens are now stored encrypted in config, token files are written in encrypted form, and belief encryption keys are derived from `master.key` when no legacy `belief.key` file exists.

- **Context assembly simplified** (`src/context/contextBuilder.ts`, `src/context/systemPromptBuilder.ts`, `src/context/beliefsReader.ts`): Removed org summary and team belief injection paths from context building and system prompt construction, leaving persona, pinned facts, relevant beliefs, and open questions as the primary injected memory surfaces.

- **IDE and sidecar scope behavior tightened** (`src/extraction/worker.ts`, `src/sidecar/idePrompt.ts`, `src/sidecar/prompt.ts`, `src/helpers/scopeDetector.ts`): Scope generation is now more restrictive, project scopes are enforced from resolved workspace context, and sidecar guidance no longer permits inventing new scope labels in these flows.

- **Belief and runtime schemas simplified** (`src/types/belief.ts`, `src/config/runtime.ts`, `src/backup/types.ts`): Removed team/org visibility fields, compaction note persistence, memory mode settings, managed history token cap, and several team-specific runtime fields from active schemas and export/import payloads.

### Removed

- **Team and SCIM administration surfaces** (`src/routes/scim.ts`, `src/routes/team-admin-ui.ts`, `src/routes/admin-setup.ts`, `src/config/teamResolution.ts`): Removed SCIM routes, team admin UI, admin setup wizard, team resolution config, and associated team membership and SCIM collection/index handling.

- **Telemetry dependencies and bootstrap** (`src/telemetry.ts`, `package.json`, `package-lock.json`, `src/index.ts`): Removed OpenTelemetry startup and related dependency tree from the application package set.

- **Enterprise and teams documentation set** (`docs/teams/auth-guide.md`, `docs/teams/backup.md`, `docs/teams/deployment.md`, `docs/teams/idp-integration.md`, `docs/teams/observability.md`, `docs/roadmap.md`): Deleted the dedicated teams, SCIM, backup, IdP integration, observability, and roadmap docs from the repository.

### Fixed

- **Belief encryption verification target** (`src/app.ts`): Updated encryption verification to inspect stored ciphertext in the `beliefs` collection instead of a temporary check collection, making the verification path match real storage behavior.

- **Import and backup compatibility with the new data model** (`src/backup/exporter.ts`, `src/backup/importer.ts`, `src/backup/types.ts`, `src/routes/backup.ts`): Removed compaction-log export/import handling and aligned exported runtime and belief fields with the simplified schema.

---

## [1.0.29] - 2026-07-01

### Changed

- **Belief merger conflict resolution** (`src/extraction/merger.ts`): Refactored content conflict logic to distinguish three outcomes: when incoming confidence is significantly higher the belief is now flagged for user review (`FLAGGED_CONFLICT`); when incoming confidence is significantly lower it is skipped as low-confidence (`SKIPPED_LOW_CONFIDENCE`); and when the margin falls within the conflict threshold the belief is also skipped with a reason indicating the margin is insufficient without an explicit supersede signal.

- **Reflective mode extraction** (`src/extraction/worker.ts`): Added an early return for `reflective` extraction mode so that no suggestions are persisted, no orientation tax is handled, and no sidecars are processed. Parse errors for sidecars now also re-throw when the parse status is `parsed`.

- **Compaction deduplication and atomicity** (`src/jobs/compactionRunner.ts`): Added a pre-insert duplicate check to detect when a merged belief already exists under the same canonical name. When a duplicate is found, the original beliefs are superseded into the existing document instead of creating a redundant merge. The insert of the merged belief is now wrapped in a try/catch so that if insertion fails, the previously retired beliefs are rolled back to active status and the retirement log entry is removed.

- **js-yaml dependency** (`package-lock.json`): Bumped `js-yaml` from 3.14.2 to 3.15.0.

- **Test suite formatting** (`src/eval/session-retrieval.eval.test.ts`): Applied consistent code style across the evaluation test file, including trailing comma cleanup, formatting adjustments, and removal of extraneous `gcp-metadata` entry from the lockfile.

---

## [1.0.28] - 2026-06-18

### Added

- **Team mode and multi-tenant resolution** (`src/config/runtime.ts`, `src/server.ts`, `src/db/collections.ts`, `src/db/indexes.ts`, `src/routes/scim.ts`, `docs/teams/deployment.md`): Introduced `TENURE_MODE=teams` with configurable resolution strategies (`static`, `header`, `scim_group`, `manual`, `disabled`). Added `team_resolution_strategy`, `default_team_id`, `default_org_id`, `team_header_name`, `org_header_name`, `scim_group_mappings`, and `scim_token` to runtime config. Added `team_memberships` collection with unique `user_id` index and `team_id/org_id` index. Team and org IDs now propagate through request lifecycle, extraction jobs, compaction, and context assembly.

- **Team Admin UI** (`src/routes/team-admin-ui.ts`): Built `/admin/team` interface allowing admins to select a resolution strategy, configure custom header names, generate and rotate SCIM tokens, map SCIM groups to teams/orgs, and manually assign individual users to teams.

- **Organization summary in setup wizard** (`src/routes/admin-setup.ts`): Moved org summary synthesis from the general team admin UI into the initial setup wizard behind `requireRootToken` guard. Added `POST /admin/setup/org-summary`, `showOrgSetup`, `submitOrgSetup`, and `skipOrg` flows so only the IT admin holding the root token can create the governance prelude.

- **Native Anthropic tool-use events** (`src/providers/anthropic.ts`, `src/providers/types.ts`, `src/routes/messages.ts`): Replaced OpenAI-style `tool_call_delta` translation with provider-native `tool_use_start` and `tool_use_delta` stream events. `AnthropicCallResponse` now carries `toolUses` with native `tool_use` shape instead of normalized `toolCalls`.

- **Tenant context propagation** (`src/routes/chat.ts`, `src/routes/messages.ts`, `src/routes/shared/sideEffects.ts`, `src/jobs/queue.ts`, `src/jobs/compactionRunner.ts`, `src/helpers/scopeDetector.ts`, `src/types/job.ts`): Threaded `teamId` and `orgId` through chat and messages routes, extraction job enqueueing, belief compaction, scope detection, and side effects.

### Changed

- **StreamEvent type** (`src/providers/types.ts`): Replaced monolithic interface with a discriminated union supporting `content_delta`, `text_block_start`, `tool_call_delta`, `tool_use_start`, `tool_use_delta`, and `stream_end`.

- **Messages route Anthropic handling** (`src/routes/messages.ts`): Refactored streaming and non-streaming response builders to accept native `AnthropicToolUseOutputBlock[]` directly, eliminating the OpenAI-format round-trip of stringifying and re-parsing tool arguments.

- **SCIM token resolution** (`src/routes/scim.ts`, `src/server.ts`, `src/routes/scim.test.ts`): Changed from resolving `TENURE_SCIM_TOKEN` once at module load to dynamic resolution via `deps.getToken()`, which checks runtime config first and falls back to the environment variable.

- **Admin setup dependencies** (`src/server.ts`, `src/routes/admin-setup.ts`): Extended `AdminSetupDeps` to require `db` and `providers` so the setup wizard can synthesize org summaries. Applied `requireRootToken` `preHandler` to `/admin/setup` and `/admin/setup/org-summary`.

### Fixed

- **Streaming event type narrowing** (`src/routes/chat.ts`): Guarded `event.delta` access behind an `event.type === "content_delta"` check for safe union-type narrowing.

---

## [1.0.27] - 2026-06-17

### Added

- **Project Resume generation** (`src/context/projectResume.js`, `src/app.ts`, `src/server.ts`, `src/routes/resume.js`, `integrations/vscode/src/extension.ts`, `integrations/vscode/src/beliefsViewProvider.ts`): Introduced `ProjectResumeService` and a new `POST /v1/resume/generate` endpoint that synthesizes a project snapshot containing active files, recent beliefs, audit queries, inferred next steps, open questions, title, summary, and confidence score . The VS Code extension adds a "Generate Project Resume" button to the beliefs panel and renders the result in a dedicated webview panel via `buildResumeHtml` .

- **File edit tracking** (`src/db/collections.ts`, `src/db/indexes.ts`, `src/routes/beliefs-ws.ts`, `integrations/vscode/src/beliefsViewProvider.ts`): Extended `FileMetaDoc` with `last_edited_at` and `project_scope` fields to record when files are modified . Added the `file_edited` WebSocket message type so the VS Code extension can push edit events to the server, which upserts the corresponding `file_meta` record . Added a `file_meta_project_edits` partial index on `user_id`, `project_scope`, and `last_edited_at` to support efficient per-project lookups of recently edited files .

### Changed

- **VS Code beliefs panel UI** (`integrations/vscode/src/beliefsViewProvider.ts`): Added a "Generate Project Resume" button bar, displayed when the categorized state view is active .

- **Extension command helpers** (`integrations/vscode/src/extension.ts`): Added `requireProjectContext` to centralize validation of authentication token, workspace sync, and resolved project scope before executing project-level commands such as resume generation .

---

## [1.0.26] - 2026-06-13

### Changed

- **Dependency updates** (`package.json`, `package-lock.json`): Bumped `@anthropic-ai/sdk` from `0.95.2` to `0.104.1`. Upgraded `mongodb` from `7.2.0` to `7.3.0`. Updated all OpenTelemetry packages to pinned versions (`auto-instrumentations-node` to `0.77.0`, `exporter-trace-otlp-proto` to `0.219.0`, `instrumentation-dns` to `0.62.0`, `instrumentation-mongodb` to `0.72.0`, `instrumentation-net` to `0.63.0`, `sdk-node` to `0.219.0`). Pinned `ua-parser-js` to `2.0.10` and `tsx` (dev) to `4.22.4`. All OpenTelemetry version constraints were changed from range specifiers (`^`) to exact pins.

### Added

- **`systeminformation` dependency** (`package-lock.json`): Added `systeminformation` `5.31.7`, a cross-platform system/hardware information library.

### Removed

- **`get-tsconfig` and `resolve-pkg-maps` dev dependencies** (`package-lock.json`): Dropped both transitive dev dependencies, which were previously pulled in by `tsx`. The updated `tsx` `4.22.4` no longer requires them.

---

## [1.0.25] - 2026-06-10

### Added

- **Memory mode configuration** (`src/config/runtime.ts`, `src/extraction/worker.ts`, `src/routes/chat.ts`, `src/routes/messages.ts`, `src/routes/admin-ui.ts`): Introduced a `memory_mode` setting supporting four modes: `autonomous` (default), `inject_only`, `curated`, and `reflective`. Autonomous extracts and merges beliefs automatically; `inject_only` disables extraction outside of imports or onboarding; `curated` queues new beliefs as pending suggestions for approval; and `reflective` extracts but never injects beliefs into sessions. The admin UI includes a dedicated memory mode selector.
- **Curated belief suggestions** (`src/types/belief.ts`, `src/db/collections.ts`, `src/db/indexes.ts`, `src/extraction/worker.ts`, `src/routes/beliefs.ts`, `src/routes/beliefs-ui.ts`): Added the `BeliefSuggestion` type and a new `belief_suggestions` collection with supporting indexes. In `curated` mode, the extraction worker persists proposed beliefs as pending suggestions rather than merging them directly. Added API endpoints to list, approve, and reject suggestions (`GET /v1/beliefs/suggestions`, `POST .../approve`, `POST .../reject`), along with a pending suggestions panel in the beliefs UI.
- **Belief visibility and team/org scoping** (`src/types/belief.ts`, `src/extraction/beliefWriter.ts`, `src/context/beliefsReader.ts`, `src/routes/beliefs.ts`, `src/routes/beliefs-ui.ts`): Extended beliefs with `visibility` (`private`, `team`, `org`), `team_id`, and `org_id` fields. `BeliefsReader` gained `findTeamOrgByCanonical` to resolve canonical names against team or organization scope. The beliefs list endpoint now includes team-visible beliefs for team-authenticated requests, and the beliefs UI renders team working agreements as read-only cards.
- **Organization-aware compaction** (`src/jobs/compactionRunner.ts`, `src/server.ts`): `BeliefCompactionRunner.run` now accepts an optional `orgSummary`. When provided, the deduplication prompt receives an `org_standards` block so the LLM can flag beliefs that contradict organizational policy as org violations. Non-user-edited beliefs flagged as org violations are automatically superseded.
- **Organization summary direct lookup** (`src/context/orgSummary.ts`, `src/app.ts`, `src/db/indexes.ts`): Replaced the previous `OrgSummaryService` and `OrgSummaryMongoCache` with a streamlined `OrgSummaryDirect` lookup backed by the `org_summaries` collection. Added `synthesizeOrgSummary` as a standalone LLM utility for summary generation. Added collection indexes on `org_id` (unique) and `updated_at`.
- **Team administration UI route** (`src/server.ts`): Registered `registerTeamAdminUiRoute` to provide team-scoped administration capabilities.

### Changed

- **Application bootstrap wiring** (`src/app.ts`, `src/server.ts`), Updated bootstrap to use `OrgSummaryDirect` instead of the prior cache/service pair. Changed `ServerDeps` and beliefs route registrations to reference the `OrgSummaryLookup` interface and pass the `belief_suggestions` collection to route handlers.
- **Extraction job context propagation** (`src/extraction/merger.ts`, `src/extraction/worker.ts`): `MergeInput` now accepts optional `teamId` and `orgId`, which the extraction worker passes from the job payload through to belief creation.
- **Admin UI advanced settings** (`src/routes/admin-ui.ts`): Removed the session history token cap and compaction mode controls from the advanced settings panel. Restored `save-advanced`, `save-memory-mode`, and `rotate-token` click handlers.
- **Onboarding provider setup** (`src/routes/onboarding.ts`): Corrected provider flavor placeholder references to use `FLAVORS[0]` for the default hint and URL placeholder.

---

## [1.0.24] - 2026-06-09

### Added

- **Team and organization belief visibility** (`src/types/belief.ts`, `src/context/beliefsReader.ts`, `src/db/indexes.ts`): Introduced `visibility` (`org`, `team`, `private`), `team_id`, and `org_id` fields to beliefs. Added `listTeamBeliefs` and `listOrgBeliefs` methods on `BeliefsReader` to query shared team and organization beliefs with appropriate sorting.
- **Organization summary cache and service** (`src/app.ts`, `src/context/contextBuilder.ts`, `src/db/indexes.ts`): Added `OrgSummaryMongoCache` backed by a new `org_summary_cache` collection and `OrgSummaryService`, both wired into the application bootstrap. Includes indexes on `generated_at` and `beliefs_hash`.
- **Team-mode context injection** (`src/context/contextBuilder.ts`, `src/context/systemPromptBuilder.ts`, `src/server.ts`): When request membership resolves to a team and org (`teamMode`), `ContextBuilder` fetches team beliefs and an organization summary. `buildSystemPrompt` injects `<org_summary>` and `<team_beliefs>` blocks into the system prompt, treated as durable and active constraints respectively.
- **Per-request team resolution** (`src/server.ts`): Added `resolveMembership` with strategies `static`, `header`, `scim_group`, `manual`, and `disabled`. Reads `TENURE_DEFAULT_TEAM_ID`/`TENURE_DEFAULT_ORG_ID` or request headers (`x-team-id`/`x-org-id`) and sets `req.tenureTeamId`/`req.tenureOrgId` for proxy-authenticated and PAT-authenticated requests.
- **IDE-mode user belief cap** (`src/context/contextBuilder.ts`): When `teamMode` and `ideMode` are both active, user-specific beliefs are capped separately via `maxUserBeliefs` rather than consuming the full `maxBeliefs` budget.
- **SCIM Group provisioning** (`src/routes/scim.ts`, `src/db/indexes.ts`): Implemented full SCIM v2 Group endpoints: list (with `displayName`/`externalId` filtering), get by ID, create, replace (PUT), patch members (add, remove, replace), and delete. Added `scim_groups` collection with unique `displayName`, sparse `externalId`, and `members.value` indexes.
- **SCIM user idempotency and filtering** (`src/routes/scim.ts`): POST `/scim/v2/Users` now returns the existing record with `200` when matched by `userName` or `externalId`, instead of `409`. GET `/scim/v2/Users` now supports filtering by `externalId`.
- **SCIM membership cleanup** (`src/routes/scim.ts`): Deleting a SCIM user now automatically removes the user from all `scim_groups` member arrays.

### Changed

- **Context budget defaults** (`src/context/contextBuilder.ts`): `ContextBudget` and `DEFAULT_BUDGET` expanded with `maxTeamBeliefs` (5), `maxUserBeliefs` (3), and `maxOrgSummaryChars` (600).
- **Context builder dependencies** (`src/context/contextBuilder.ts`, `src/context/beliefsAndContext.test.ts`, `src/app.ts`): `ContextBuilder` now requires an `OrgSummaryLookup` as a constructor argument. Updated all route registrations and test stubs (`NULL_ORG_SUMMARY`) accordingly.
- **Belief unique index** (`src/db/indexes.ts`): The `user_canonical_unique_active` partial unique index now includes `team_id` and `org_id` in the key to support multi-tenant uniqueness.
- **SCIM user revocation query** (`src/routes/scim.ts`): Token revocation during SCIM user deactivation now queries for `revoked_at: null` instead of using `$exists: false`.
- **Admin token schema** (`src/routes/admin.ts`): New API tokens explicitly set `revoked_at: null` on creation.
- **Admin setup cleanup** (`src/routes/admin-setup.ts`): Removed an unreachable duplicate `else if (token)` branch.

---

## [1.0.23] - 2026-06-07

### Added

- **Teams mode (`TENURE_MODE=teams`)** (`src/config/bootstrap.ts`, `src/config/appConfig.ts`, `src/index.ts`, `src/app.ts`): New deployment mode for multi-user enterprise deployments. When set, requires `MONGODB_URI`, `TENURE_USER_ID`, and `TENURE_MASTER_KEY_PATH` to be supplied via environment variables rather than generated config files. Config file generation and token rotation are disabled. The `token` subcommand exits immediately with an error in this mode.
- **OIDC proxy header authentication** (`src/server.ts`): When `OIDC_PROXY_HEADER` is set, the server trusts the specified header as the authenticated user ID, enabling SSO via a reverse proxy (e.g. OAuth2 Proxy). Proxy-authenticated requests bypass token checks entirely.
- **Personal access tokens (PAT)** (`src/routes/admin.ts`, `src/routes/admin-ui.ts`, `src/db/collections.ts`, `src/db/indexes.ts`): Users can now generate named `tpat_`-prefixed tokens from the Admin UI for use with VS Code, OpenWebUI, or CI. Tokens are SHA-256 hashed at rest. PAT-authenticated requests are scoped to a specific set of allowed paths (`/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/v1/ws/beliefs`). Full CRUD UI (generate, list, revoke) shown in teams mode in place of the existing token rotation UI.
- **`ApiTokenDoc` and `ScimUserDoc` collection interfaces** (`src/db/collections.ts`): Two new MongoDB collection types. `api_tokens` has a unique index on `token_hash` (with partial filter for non-revoked tokens) and a compound index on `user_id`/`created_at`. `scim_users` has unique index on `userName` and an index on `externalId`.
- **SCIM route registration** (`src/server.ts`): `registerScimRoutes` from the new `src/routes/scim.ts` is wired in at server startup with a `ScimDeps` object.
- **`tenureUserId` and `tenureAuthMethod` on Fastify request** (`src/server.ts`): All routes now read `req.tenureUserId` instead of a hardcoded `deps.userId`, enabling per-request user identity. Auth method is one of `proxy`, `root`, or `pat`.
- **Root token restricted in teams mode** (`src/server.ts`): The root API token can only access bootstrap-related paths (provider config, onboarding, model listing) in teams mode. All other paths return `403` directing users to authenticate via SSO.
- **OpenTelemetry tracing** (`src/index.ts`, `src/server.ts`): `src/telemetry.ts` is imported at process startup. Compaction and extraction sweep jobs are now wrapped in OTel spans. Auth errors and span attributes (`user.id`) are recorded on the active span. Full OTel SDK stack added as dependencies (`@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, OTLP exporters, gRPC transport, etc.).
- **`actor_id` field on error logs** (`src/types/error.ts`, `src/errors/logger.ts`): All error log entries now include an `actor_id` field alongside `user_id`, populated from the request's authenticated user ID.
- **MongoDB TLS support** (`src/app.ts`): When `MONGODB_TLS_CA_FILE` is set, the CA file path is passed to all MongoClient instances including the CSFLE encryption client.
- **`TENURE_BELIEF_KEY_PATH` env override** (`src/config/beliefEncryptionMasterKey.ts`): The belief master key path can now be overridden directly via environment variable, bypassing the `TENURE_HOME`-based path resolution.
- **`TENURE_BACKUP_EXPORTS_ENABLED` / `TENURE_BACKUP_IMPORTS_ENABLED` flags** (`src/routes/backup.ts`): Backup export and import endpoints can be independently disabled at the deployment level, returning `403` when disabled.
- **`TENURE_DISABLE_JOBS` flag** (`src/server.ts`): Both the compaction and extraction sweep background jobs can be disabled by setting this env var to `"true"`, useful for read-only or worker-separated deployments.
- **Multi-user compaction** (`src/server.ts`): The compaction job now queries recently active session `userId`s from the last 30 days and runs compaction for each, rather than only for the single hardcoded `deps.userId`.
- **SSO auto-init in UI pages** (`src/routes/admin-ui.ts`, `src/routes/beliefs-ui.ts`, `src/routes/onboarding.ts`): When `req.tenureUserId` is set (proxy auth), a `window.__TENURE_SSO_USER__` script block is injected and the page calls `init()` directly, bypassing the token screen.
- **`TENURE_API_TOKEN` env var for token seeding** (`src/config/appConfig.ts`): If set, this value is used as the API token instead of generating a random one.
- **`DEPLOY_MODE` constant exported** (`src/config/bootstrap.ts`): Derived from `TENURE_MODE`, available for use throughout the codebase.

### Changed

- **`userId` removed from `deps` on all route registrations** (`src/routes/chat.ts`, `src/routes/messages.ts`, `src/routes/admin.ts`, `src/routes/audit.ts`, `src/routes/backup.ts`, `src/routes/beliefs.ts`, `src/routes/beliefs-ws.ts`, `src/routes/persona.ts`, `src/routes/workspace.ts`, `src/routes/onboarding.ts`): All routes now resolve user identity from `req.tenureUserId` at request time rather than receiving it as a static dep at registration time.
- **`beliefChangeStream` user ID sourced from document** (`src/db/beliefChangeStream.ts`): Change stream broadcasts now use `doc.user_id` from the fetched belief document rather than the `userId` passed at startup, supporting multi-user change broadcasting. The `userId` parameter removed from `startBeliefChangeStream`.
- **`delete` event handling removed from belief change stream** (`src/db/beliefChangeStream.ts`): The `operationType === "delete"` broadcast case has been removed.
- **`createDraftStore` refactored to a factory** (`src/routes/onboarding.ts`): Now returns a function `(userId: string) => DraftStore` rather than accepting `userId` at construction time, allowing per-request draft store instances.
- **Onboarding HTML token injection hardened** (`src/routes/onboarding.ts`): Token JS now safely escapes `<` characters in the embedded token string.
- **Onboarding extraction `max_tokens` raised** from 4,000 to 8,000 (`src/routes/onboarding.ts`).
- **Onboarding "draft not found" error message** changed from em-dash to comma for consistency (`src/routes/onboarding.ts`).
- **Compaction and sweep jobs wrapped in OTel spans** (`src/server.ts`): Both background jobs record exceptions and set span error status on failure.
- **VS Code extension docs updated for enterprise/local split** (`docs/clients/vscode.md`): Requirements, first-time setup flow, token instructions, proxy URL reference, status bar link, settings table, Docker networking note, and troubleshooting section all updated to reflect local vs. enterprise modes. New `Tenure: Configure Deployment` command documented.
- **OpenClaw docs: hardcoded localhost URL generalized** (`docs/clients/openclaw.md`).
- **`package.json`**: Added `@opentelemetry/api`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/instrumentation-dns`, `@opentelemetry/instrumentation-mongodb`, `@opentelemetry/instrumentation-net`, `@opentelemetry/sdk-node`, `install`, and `npm` as direct dependencies.

---

## [1.0.22] - 2026-06-05

### Added

- **`searchMergeCandidates` method on `BeliefsReader`** (`src/context/beliefsReader.ts`): New Atlas Search method for ingestion-time deduplication. Unlike `searchText()`, it does not exclude `open_question` or `expertise` subtypes, and it filters tightly to the incoming belief's type, subtype, scope, and agent. Used as a fallback in `BeliefMerger` when the primary writer-side lookup finds no match.
- **Atlas Search fallback in `BeliefMerger`** (`src/extraction/merger.ts`): When the writer-side lookup produces no existing match for an incoming belief, the merger now calls `searchMergeCandidates` via an optional `BeliefsReader` dependency. The fuzzy candidate is accepted unless both the incoming belief and the candidate specify conflicting `active_file` origins. When a fuzzy match is found, the incoming belief's `canonical_name` is added to `candidateAliases` so it is preserved as an alias on the merged record.
- **`BeliefsReader` wired into `ExtractionWorker`** (`src/extraction/worker.ts`): A `BeliefsReader` instance is now constructed alongside `BeliefWriter` and passed to `BeliefMerger`, enabling the new Atlas Search fallback.
- **`deepScanIntervalMs` field on `CompactionTypeConfig`** (`src/jobs/compactionRunner.ts`): All four belief types (`preference`, `expertise`, `entity`, `decision`) now carry a `deepScanIntervalMs` of 7 days, controlling how often a full-scope deep compaction run is triggered independently of the regular cooldown.
- **Two-tier compaction scheduling: shallow and deep** (`src/jobs/compactionRunner.ts`): `findQualifyingPartitions` now returns a `depth` (`'shallow' | 'deep'`) and an explicit `threshold` per partition. A partition qualifies for a `deep` run once `deepScanIntervalMs` has elapsed since the last deep scan; it qualifies for a `shallow` run once the regular `cooldownMs` has elapsed. Legacy log entries without a `scan_depth` field are treated as deep to prevent immediate re-triggering.
- **`clusterByTermOverlap` method** (`src/jobs/compactionRunner.ts`): Shallow compaction now pre-filters candidates using transitive (2-hop+) term clustering via a union-find structure. Beliefs sharing a token from their `canonical_name` or `aliases` are grouped together; only groups of two or more enter the LLM call. This prevents the model from receiving unrelated beliefs and ensures lexically bridged candidates (A↔B↔C where A and C share no direct term) are kept in the same cluster.
- **`scan_depth` field on `CompactionLogEntry`** (`src/jobs/compactionRunner.ts`): Compaction log records now carry a `'shallow' | 'deep'` scan depth, enabling the scheduler to distinguish run types when computing cooldowns.
- **`stripInnerFences` and `extractFirstJsonObject` helpers** (`src/sidecar/splitter.ts`): Two new parsing utilities handle common model output edge cases — stripping markdown fences wrapping the inner JSON object, and extracting the first well-balanced JSON object by brace depth when `END_SIDECAR` is absent.
- **`belief_updates`, `entity_updates`, and `resolved_open_questions` fields added to standard sidecar prompt example output** (`src/sidecar/prompt.ts`): The JSON example block in the standard sidecar prompt now includes these previously-missing fields, aligning the example with the fields the prompt path actually emits.

### Changed

- **`buildBaseFilters` and `buildSearchStage` / `runSearchPipeline` extracted from `searchText`** (`src/context/beliefsReader.ts`): The inline filter construction and Atlas Search pipeline assembly in `searchText()` have been refactored into three private helpers (`buildBaseFilters`, `buildSearchStage`, `runSearchPipeline`), reused by both `searchText` and the new `searchMergeCandidates`.
- **`SIDECAR_FENCE_RE` regex made global** (`src/sidecar/splitter.ts`): The fence-unwrapping regex now uses the `g` flag so all fenced blocks in a response are unwrapped, not just the first.
- **`splitSidecar` now strips inner fences and extracts balanced JSON before returning** (`src/sidecar/splitter.ts`): After locating the sidecar region, the raw content is passed through `stripInnerFences`; if `END_SIDECAR` is absent, `extractFirstJsonObject` is applied to prevent trailing prose from poisoning `JSON.parse`. An empty raw region now returns `parseStatus: 'needs_repair'` rather than falling through as `parsed`.
- **`parseSidecar` now strips inner fences before parsing** (`src/sidecar/splitter.ts`): Applies `stripInnerFences` on the raw string before `JSON.parse`, making the parser resilient to fenced JSON passed directly.
- **`extractJson` no longer truncates to 32,000 characters** (`src/jobs/compactionRunner.ts`): The hard 32k slice has been removed; the method now strips fences and extracts the first JSON object without truncating the input.
- **`SidecarPayload` interface pruned** (`src/sidecar/splitter.ts`): `topic_shift`, `topic_label`, and `possible_alias_candidates` fields removed — these were never populated by either the standard or IDE prompt paths.
- **`possible_alias_candidates` removed from IDE sidecar prompt example** (`src/sidecar/idePrompt.ts`): The field is no longer included in the example JSON output block.
- **Quote style normalised to single quotes throughout** (`src/jobs/compactionRunner.ts`, `src/sidecar/splitter.ts`, `src/sidecar/prompt.ts`, `src/sidecar/idePrompt.ts`): Double-quoted string literals and trailing commas in object/array literals updated to match the single-quote style used elsewhere in the codebase.

---

## [1.0.21] - 2026-06-04

### Added

- **Tool call passthrough in streaming** (`src/providers/openai.ts`): The OpenAI adapter's `callStream()` method now buffers and yields `tool_call_delta` events as tool call chunks arrive over the SSE stream. Accumulated tool calls are included on the final `stream_end` event.
- **Tool call passthrough in non-streaming responses** (`src/providers/openai.ts`): `call()` now surfaces `tool_calls` from the OpenAI response message, returning them in an optional `toolCalls` field on the provider response.
- **`tool_calls` forwarded in chat route response** (`src/routes/chat.ts`): When the provider response includes tool calls, they are now included in the `message` payload of the `/chat/completions` response.
- **`stream_end` event emitted by `callStream()`** (`src/providers/openai.ts`): The streaming path now always yields a terminal `stream_end` event carrying the final model name, finish reason, and token usage.
- **SSE buffer flush for final partial line** (`src/providers/openai.ts`): Any data remaining in the SSE line buffer after the stream ends is now yielded, preventing loss of a final chunk that arrives without a trailing newline.

### Changed

- **`content_block_start` deferred until first content delta** (`src/routes/messages.ts`): The initial `content_block_start` SSE event for a text block is no longer emitted eagerly at stream open; it is now emitted lazily on the first `content_delta`. Block indices start at `0` instead of `1`, and an `activeBlockIndex` cursor tracks whichever block is currently open to ensure correct `content_block_stop` sequencing.
- **`buildSystemPrompt` errors now caught with raw fallback** (`src/routes/messages.ts`): System prompt construction is wrapped in a `try/catch`; if it throws, the route logs the error and falls back to the raw incoming system text rather than propagating the exception.
- **Last-message content extraction fixed** (`src/routes/messages.ts`): The final message in the request body is now read as `message.content` instead of casting the whole message object to a string, preventing a serialisation bug for structured message objects.
- **`test.afterEach` changed to `test.afterEach.always`** (`src/providers/openai.test.ts`): Sinon stubs are now restored even when a test fails, preventing stub leakage between serial tests.

---

## [1.0.20]

### Removed

- **`fileTier` helper function removed** (`src/routes/beliefs-ws.ts`): The unused `fileTier` function, which ranked beliefs by file proximity (same file, same directory, or other), has been deleted.
- **`isUniversalOnly` helper function removed** (`src/routes/beliefs-ws.ts`): The unused helper that checked whether a scope array contained only `"user:universal"` has been deleted.
- **`TurnSignal` type import removed** (`src/sidecar/splitter.ts`): The `import type { TurnSignal }` from `"../history/manager.js"` has been removed, as `TurnSignal` is no longer referenced in the splitter module.

---

## [1.0.19]

### Added

- **Orientation tax dashboard on audit page**: The top of `/audit` now shows a four-metric panel for the last 30 days: re-explanations prevented, estimated time saved, tax still paid, and a re-explanation trend indicator. A coverage-rate progress bar appears when there is injection data to show.
- **`/admin/audit/orientation-tax` endpoint**: Returns aggregated orientation tax stats for a configurable window (up to 365 days), including first-half/second-half split for trend calculation.
- **`/admin/audit/scopes` endpoint**: Returns a sorted, deduplicated list of all scopes that have appeared in your audit history, used to populate the new scope filter dropdown.
- **Belief injection history on the World Model dashboard**: Each belief card now has an "Injections" button that opens a paginated modal showing every conversation the belief was surfaced in, including the triggering query, date, scope, and agent. Links directly to the full audit trail filtered to that belief.
- **Orientation tax closed-loop handler** (`ExtractionWorker`): When `orientation_tax` is true on an extracted turn, the worker stamps the injection audit record, applies an extra reinforcement bump to any beliefs the user just re-explained, and writes a scoped `orientation_tax_events` record for compaction prioritization.
- **Orientation-tax-aware compaction scheduling** (`BeliefCompactionRunner`): Scopes with orientation tax events in the last 7 days receive a 40% reduced compaction threshold, causing Tenure to compact and resolve beliefs in those scopes sooner.
- **`orientation_tax_events` collection with TTL index**: Events expire after 30 days. Indexed by `user_id`, `scopes`, and `created_at` for efficient compaction and dashboard queries.
- **`audit_orientation_tax` index on `injection_audit`**: Compound index on `(user_id, orientation_tax, created_at)` for efficient dashboard aggregation.

### Changed

- **`turn_signal` replaced by `orientation_tax: boolean`** across the extraction pipeline: `TurnSignal` enum type, `VALID_TURN_SIGNALS` validator set, `turnSignal` field on `MergeReport`, `tryReadTurnSignal` function in `splitter.ts`, and all sidecar prompt templates have been removed or replaced. The extraction schema now emits `"orientation_tax": false` by default instead of `"turn_signal": "substantive"`.
- **Sidecar prompt updated for both standard and IDE prompts** (`prompt.ts`, `idePrompt.ts`): The `TURN SIGNAL` section has been replaced with an `ORIENTATION TAX` section with clearer true/false criteria and examples.
- **Scope filter on audit page changed to a dropdown**: The free-text scope input has been replaced with a `<select>` element populated from `/admin/audit/scopes`, listing only scopes that have actually appeared in your audit history.
- **Belief change stream reads from the encrypted collection** (`beliefChangeStream.ts`): On insert and update events, the stream now fetches the document from the encrypted collection by `_id` rather than reading `fullDocument` directly from the change event, ensuring belief content broadcast to clients is always in its decrypted form.
- **`startBeliefChangeStream` now accepts an `encryptedCol` parameter** (`server.ts`): Both the plain and encrypted collections are passed at startup.

### Removed

- **`TurnSignal` type and `turn_signal` field**: Removed from `types.ts`, `merger.ts`, `splitter.ts`, `validator.ts`, and both sidecar prompt templates.
- **`tryReadTurnSignal` function** (`splitter.ts`): No longer needed now that the extraction schema uses a boolean `orientation_tax` flag.
- **`turnSignal` field on `MergeReport`** (`merger.ts`): Removed along with its population from extraction results.

---

## [1.0.18] - 2026-05-31

### Added

- **Injection audit logging** (`src/routes/chat.ts`): A new optional `injectionAudit` field on `ChatDeps` accepts an `InjectionAuditLogger` instance. When configured and beliefs are present in the context (`beliefCtx.beliefCount > 0`), the chat route fires a non-blocking audit log entry per request recording the user ID, session ID, request ID, user query, expanded query, scope, agent ID, injection state, and the full belief context.
- **Audit nav link in Beliefs UI** (`src/routes/beliefs-ui.ts`): A new "Audit" navigation link pointing to `/audit` has been added to the nav bar between "Settings" and "Onboarding".
- **`InternalLLMCaller` type imported in beliefs route** (`src/routes/beliefs.ts`): The beliefs import route now casts the adapter to `InternalLLMCaller` before invoking the LLM, aligning with the new internal call signature.
- **`expandRelationParticipants` method on `BeliefsReader`** (`src/context/beliefsReader.ts`): New async method that, given a set of scored beliefs, finds all `relation`-typed beliefs among them, collects their `participants` IDs, and fetches the corresponding participant beliefs from MongoDB. Applies standard active-belief filters (`resolved_at: null`, `superseded_by: null`, excludes `open_question`), optional scope restriction, and agent isolation via the existing `mergeFilter` helper. IDs already present in `excludeIds` are skipped to avoid returning duplicates.

- **Relation participant expansion in `ContextBuilder.build`** (`src/context/contextBuilder.ts`): After the primary BM25 search, `expandRelationParticipants` is now called on the raw search results to fetch beliefs that are participants of any returned `relation` beliefs. The expanded participants are merged into `allRelevant` with a `_searchScore` of `0`, included in `searchScores`, and subject to the same cap and projection logic as directly-retrieved beliefs. Both the pinned ID set and the direct search result IDs are passed as `excludeIds` to prevent duplication.

- **`rawPinnedFacts`, `rawRelevantBeliefs`, and `rawOpenQuestions` fields on `BuiltContext`** (`src/context/contextBuilder.ts`): The `BuiltContext` interface now exposes the raw `Belief[]` arrays for pinned facts, relevant beliefs, and open questions in addition to their JSON-serialized counterparts. These are populated from `cappedPinned`, `cappedRelevant`, and `questions` respectively.

- **`EMPTY_CONTEXT` exported from `contextBuilder.ts`** (`src/context/contextBuilder.ts`): A fully populated `EMPTY_CONTEXT` constant (including the new `rawPinnedFacts`, `rawRelevantBeliefs`, and `rawOpenQuestions` empty arrays) is now exported from the module, replacing the previously inline-defined constant in `chat.ts`.

- **Early return guard in `BeliefsReader.searchText`** (`src/context/beliefsReader.ts`): A `if (limit <= 0) return []` guard is added before the aggregation pipeline is constructed, short-circuiting the Atlas Search call entirely when the budget allows zero results.

- **`expandRelationParticipants` stub in context builder test fixture** (`src/context/beliefsAndContext.test.ts`): The `makeReader` helper now includes a `sinon.stub().resolves([])` for `expandRelationParticipants` so the stub satisfies the updated `BeliefsReader` interface.

### Changed

- **`turnId` renamed to `requestId` throughout chat route** (`src/routes/chat.ts`): The per-request UUID previously named `turnId` is now `requestId` at all call sites, including SSE frame IDs (`chatcmpl-${requestId}`), error log fields, streaming context, `tenure` response envelope, and side effects input. The `tenure` response envelope field is correspondingly renamed from `turn_id` to `request_id`.
- **`HistoryManager` removed from `ChatDeps` and all chat route wiring** (`src/routes/chat.ts`, `src/routes/chat-integration.test.ts`): The `history` field has been removed from `ChatDeps`. Turn persistence (`appendTurn`, `getCompactedWindow`) is no longer called from the chat route or its side effects. All test fixtures that previously passed `history: new HistoryManager(db)` have been updated accordingly.
- **`runSideEffects` and `buildSystemPrompt` extracted to shared modules** (`src/routes/chat.ts`): Both functions, along with their associated interfaces (`SideEffectInput`, `BuildSystemPromptArgs`) and helpers (`readSidecarFlags`, `tryReadTurnSignal`, `extractLatestUserText`), have been removed from `chat.ts` and are now imported from `./shared/sideEffects.js` and `../context/systemPromptBuilder.js` respectively. `EMPTY_CONTEXT` is now imported from `../context/contextBuilder.js`.
- **`ProviderAdapter` replaced with `OpenAIAdapter` as the concrete adapter type** (`src/routes/chat.ts`, `src/routes/chat-integration.test.ts`): The chat route and all test helpers now use `OpenAIAdapter` as the adapter type instead of the generic `ProviderAdapter` interface. `NormalizedResponse` is no longer imported; the response type is now inferred as `Awaited<ReturnType<OpenAIAdapter["call"]>>`, and the `provider` field has been dropped from stub responses.
- **Provider adapter call signature updated to positional arguments** (`src/routes/chat.ts`, `src/routes/beliefs.ts`, `src/routes/onboarding.ts`): All `adapter.call(...)` and `adapter.callStream(...)` invocations have been updated from a single `NormalizedRequest` object to positional arguments `(model, systemPrompt, messages, body, [abortSignal])`, matching the new `InternalLLMCaller` / `OpenAIAdapter` interface. An `adapterBody` object is now assembled from `passThrough`, `temperature`, and `max_tokens` before the call.
- **`context.build` is now always called** (`src/routes/chat.ts`): The `injectionEnabled` guard around `deps.context.build(...)` has been removed. Context is always assembled; the `injectionEnabled` flag is instead applied when passing `beliefCtx` to `buildSystemPrompt` (substituting `EMPTY_CONTEXT` when injection is off). This eliminates the prior `Promise.all` wrapper.
- **`activePackage` removed from chat route and streaming context** (`src/routes/chat.ts`): The `activePackage` local variable and the corresponding `StreamingCtx` field have been removed. Side effects and IDE workspace context resolution no longer reference `activePackage`.
- **`injectionEnabled` removed from `StreamingCtx`** (`src/routes/chat.ts`): The field is no longer threaded into the streaming context or passed to `runSideEffects`.
- **`turnSignal` removed from side effects** (`src/routes/chat.ts`): `tryReadTurnSignal` is no longer called in either the streaming or non-streaming paths. The `turnSignal` field is no longer passed to `runSideEffects`.
- **`tool_calls` removed from non-streaming assistant message** (`src/routes/chat.ts`): The conditional spread of `providerResp.toolCalls` onto the assistant message in the non-streaming response has been removed.
- **`tool_call_delta` SSE forwarding removed from streaming path** (`src/routes/chat.ts`): The `tool_call_delta` event handling block in `handleStreamingResponse` has been removed. The streaming loop now only processes `stream_end` (to capture resolved model, finish reason, and usage) and content delta events.
- **Streaming event loop simplified** (`src/routes/chat.ts`): `stream_end` is now handled first with a `continue`, and all remaining events are treated as content deltas directly, removing the previous `event.type === "content_delta" && event.delta` guard.
- **Streaming `abortSignal` passed directly to `callStream`** (`src/routes/chat.ts`): The `abortableReq` intermediate object is gone. The abort signal is now passed as a direct positional argument to `adapter.callStream(...)`.
- **`subscribe` message handling disabled in WebSocket beliefs route** (`src/routes/beliefs-ws.ts`): The `currentScope` variable and the `subscribe` case in the message switch have been commented out, effectively disabling scope-scoped subscription filtering.
- **Onboarding adapter calls updated to `InternalLLMCaller` signature** (`src/routes/onboarding.ts`): Both the model-validation probe call and the onboarding extraction call now cast the adapter to `InternalLLMCaller` and use positional arguments.
- **`searchText` in `ContextBuilder` skips the search when `maxBeliefs` is zero** (`src/context/contextBuilder.ts`): The search is now gated on both `expandedQuery` being truthy and `this.budget.maxBeliefs > 0`, avoiding a redundant Atlas Search round trip when the budget is exhausted.

- **`searchResultIds` set now built from `allRelevant`** (`src/context/contextBuilder.ts`): The set used to distinguish pinned from search-retrieved beliefs when selecting a projection function is now derived from the full `allRelevant` array (direct results plus relation expansions) rather than only `rawSearchResults`.

- **`PersonaSummaryService` adapter type updated to `InternalLLMCaller`** (`src/context/personaSummary.ts`): The `adapter` factory in `PersonaGeneratorDeps` now returns `InternalLLMCaller` instead of `ProviderAdapter`, and the `adapter.call(...)` invocation is updated to use positional arguments `(modelId, systemPrompt, messages, options)` matching the new internal call signature.

### Removed

- **History-related integration tests removed** (`src/routes/chat-integration.test.ts`): The test cases have been deleted as turn persistence is no longer part of the chat route's responsibility.
- **`tryReadTurnSignal` function removed** (`src/routes/chat.ts`): No longer needed after turn signal tracking was moved out of the chat route.
- **`readSidecarFlags` and `SidecarFlags` removed from chat route** (`src/routes/chat.ts`): Moved to the shared side effects module.
- **`EMPTY_CONTEXT` constant removed from chat route** (`src/routes/chat.ts`): Now imported from `contextBuilder.js`.
- **`extractLatestUserText` removed from chat route** (`src/routes/chat.ts`): Moved to shared helpers.
- **`buildSystemPrompt` and `BuildSystemPromptArgs` removed from chat route** (`src/routes/chat.ts`): Extracted to `src/context/systemPromptBuilder.ts`.
- **`runSideEffects` and `SideEffectInput` removed from chat route** (`src/routes/chat.ts`): Extracted to `src/routes/shared/sideEffects.ts`.
- **`src/context/beliefsReaderVector.ts` deleted**: The `BeliefsReaderVector` class, `ollamaEmbed` function, `beliefEmbedText` helper, `VectorSearchOptions` interface, and associated Ollama/vector search constants (`OLLAMA_BASE_URL`, `EMBED_MODEL`, `VECTOR_DIMENSIONS`, `VECTOR_INDEX_NAME`) have been removed entirely. Ollama-based vector search is no longer part of the belief retrieval pipeline.

---

## [1.0.17] - 2026-05-22

### Added

- **Streaming tool call deltas in Anthropic adapter** (`src/providers/anthropic.ts`): The Anthropic streaming path now yields `tool_call_delta` events as tool use blocks begin and accumulate argument chunks. Each `content_block_start` of type `tool_use` emits an initial delta with the tool ID and name; subsequent `input_json_delta` events stream partial JSON arguments. Final tool calls are also extracted from the completed message and attached to the `stream_end` event.
- **Streaming tool call deltas in OpenAI adapter** (`src/providers/openai.ts`): The streaming path now yields `tool_call_delta` events for each tool call chunk, surfacing index, ID, name, and argument fragments inline alongside existing content deltas.
- **`tool_call_delta` event type on `StreamEvent`** (`src/providers/types.ts`): The `StreamEvent` union now includes `"tool_call_delta"` as a valid type, with optional fields `toolCallIndex`, `toolCallId`, `toolCallName`, `toolCallArguments`, and a `toolCalls` array on `stream_end`.
- **SSE forwarding of tool call deltas in chat route** (`src/routes/chat.ts`): `handleStreamingResponse` now handles `tool_call_delta` events and writes them as `chat.completion.chunk` SSE frames with a `tool_calls` delta, matching the OpenAI streaming wire format.
- **`passThrough` spread in OpenAI adapter requests** (`src/providers/openai.ts`): Both the non-streaming `call` and streaming `callStream` paths now spread `req.passThrough` into the request body, allowing callers to inject arbitrary provider-specific parameters.

### Changed

- **`composeRequest` refactored to use `result` variable** (`src/providers/openai.ts`): The `switch` statement now assigns to a local `result` variable before returning, making the control flow more explicit and consistent.
- **Log message formatting in `toContentBlock`** (`src/providers/anthropic.ts`): Two `console.warn` strings with long interpolations have been reformatted across multiple lines for readability.

---

## [1.0.16] - 2026-05-22

### Added

- **`abortSignal` on `NormalizedRequest`** (`src/providers/types.ts`): Requests can now carry an `AbortSignal` that is combined with the existing 120-second timeout via `AbortSignal.any(...)`, allowing callers to cancel in-flight provider calls early.
- **Client-disconnect abort in streaming** (`src/routes/chat.ts`): An `AbortController` now tracks HTTP connection closure during streaming responses. The heartbeat, stream loop, and post-stream side effects all check `abortController.signal.aborted` instead of a bare boolean flag, ensuring a clean early exit when the client disconnects.
- **SSE `id:` line in `writeSSE`** (`src/routes/chat.ts`): Server-sent events now emit an `id:` line when the event object carries a string `id` field, improving client-side reconnection support.

### Changed

- **OpenAI adapter abort handling** (`src/providers/openai.ts`): Both the non-streaming `call` and streaming `callStream` paths now pass a combined `AbortSignal.any([timeout, req.abortSignal])` when `req.abortSignal` is present, propagating caller cancellation through to the upstream fetch.
- **Message role types expanded** (`src/providers/types.ts`, `src/routes/chat.ts`): `Message.role` now accepts `"developer"` and `"function"` in addition to the existing values. The chat route conversation filter and mapping are updated to pass these roles along with `tool_call_id` and `tool_calls` through to the provider.
- **WebSocket beliefs endpoint moved** (`src/routes/beliefs-ws.ts`): Route changed from `/v1/beliefs/ws` to `/v1/ws/beliefs`.
- **Admin route auth enforced** (`src/server.ts`): The `onRequest` auth hook now also applies to `/admin/*` paths (excluding `/admin/` itself), which previously required authentication only for `/v1/*` routes.
- **`tool_call_id` and `tool_calls` forwarded in chat messages** (`src/routes/chat.ts`): These fields are now conditionally spread onto outgoing `Message` objects so tool-call round-trips are preserved end-to-end.

---

## [1.0.15] - 2026-05-21

### Added

- **Beliefs sidebar** (`integrations/vscode/src/beliefsViewProvider.ts`): New Activity Bar panel ("Active Beliefs") that displays live beliefs for the current project via a WebSocket connection. Only visible when a token is configured.
- **`Tenure: Record Project Belief` command**: Opens the beliefs sidebar form to record a belief directly from the command palette.
- **`Tenure: Record Belief from Selection` command**: Same as above, also accessible via the editor right-click context menu when text is selected.
- **WebSocket beliefs route** (`src/routes/beliefs-ws.ts`): Server-side WebSocket endpoint powering real-time belief updates to the sidebar, backed by a MongoDB change stream (`src/db/beliefChangeStream.ts`).

### Changed

- **VS Code extension bumped to `1.0.15`**.
- **Project scope resolution simplified**: The manifest-walking approach (scanning for `package.json`, `Cargo.toml`, `go.mod`, etc.) has been replaced. Project name is now resolved from a plain-text `.tenure` file at the workspace root (just your project name on a single line), with git remote and folder-slug as fallbacks. The file watcher now only watches `.tenure` instead of all manifest files.
- **`tenureConfig.ts` simplified**: `.tenure` is now parsed as plain text rather than JSON. The `TenureProjectConfig` interface is removed.
- **`active_package` field removed** from `WorkspaceState`, workspace route, and `WorkspaceStateCache` — superseded by the simplified scope model.
- **`WorkspaceSync` gains result caching**: `cachedProjectName` and `cachedGitRemote` fields avoid redundant resolution on each sync. Cache is invalidated on `.tenure` file changes.
- **`@fastify/websocket` registered** in `server.ts` to support the new WebSocket route.
- **OpenClaw publish workflow**: Tag prefix changed from `v*` to `openclaw-v*`; publish target updated from `tenurehq/tenure@main` to `@tenureai/openclaw-plugin@<version>`.
- **VS Code test runner pinned** to VS Code `1.121.0`; `@vscode/test-cli` downgraded to `0.0.11`.

### Removed

- **`packageResolver.ts`** and its test suite deleted — manifest-based project resolution is no longer used.

---

## [1.0.14] - 2026-05-19

### Added

- **VS Code extension** (`integrations/vscode`): New native extension that syncs workspace context to the Tenure proxy on every file switch. Includes manifest-based project resolution (supports `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `.sln`, and others), git remote fallback, a `.tenure` config override, a status-bar indicator, and secure token storage. Ships with full test coverage (`packageResolver`, `tenureConfig`, `workspaceSync` suites).
- **Workspace state cache** (`src/workspace/stateCache.ts`): MongoDB-backed store for IDE-pushed workspace state (project name, active package, active file, language, git remote).
- **IDE scope resolver** (`src/workspace/scopeResolver.ts`): Derives project and language scope from cached workspace state or system-prompt heuristics. Tested against MongoDB Memory Server.
- **IDE extraction mode** (`src/extraction/worker.ts`, `src/jobs/queue.ts`, `src/types/job.ts`): Extraction jobs now carry an `extraction_mode` (`"standard"` | `"ide"`) and a `workspace_context` block. IDE-mode extractions enforce project scope and inject active-package aliases automatically.
- **IDE sidecar prompt** (`src/sidecar/idePrompt.ts`): Dedicated sidecar instruction builder for IDE turns, separate from the standard chat path.
- **Workspace route** (`src/routes/workspace.ts`): New endpoint for the VS Code extension to push workspace state.
- **`onboarding_drafts` collection** (`src/db/collections.ts`, `src/db/indexes.ts`): Persists onboarding draft state with a 7-day TTL and per-user index.
- **`ide_extraction_enabled` runtime config flag**: Toggles IDE-specific extraction; included in backup export/import.
- **`provenance_hint` on extraction signals** (`src/extraction/types.ts`): Accepts `"demonstrated"` or `"config_artifact"` to tag the origin of a belief.
- **Demonstrated-belief promotion logic** (`src/extraction/merger.ts`): Beliefs tagged as demonstrated or config-derived are promoted after 3 occurrences within a 24-hour window.
- **Scope badges on the Beliefs UI** (`src/routes/beliefs-ui.ts`): Scope tags now render as colored inline badges.
- **Richer error cards in Admin UI** (`src/routes/admin-ui.ts`): Error log entries now display provider, model, session ID, and turn ID alongside severity, stage, and timestamp.
- **Docs**: New `docs/clients/openclaw.md` and `docs/clients/vscode.md` client guides; `docs/clients.md` expanded into a structured chat/IDE/agent table with Docker networking notes.

### Changed

- **README rewritten**: Condensed and reorganized around concrete failure scenarios ("old decisions resurface," "ruled-out approaches keep coming back"), with a shorter quick-start and a "Private by design" section.
- **GitHub org renamed** (`jeffreyflynt` → `tenurehq`): All repository URLs, publish workflow references, and `package.json` fields updated.
- **Publish workflow**: `npm version` replaced with a direct `jq` edit to avoid git tag side-effects.
- **`x-tenure-ide` header detection** (`src/routes/chat.ts`): Chat route reads this header to switch into IDE mode and route to the IDE sidecar prompt.
- **Anthropic provider `max_tokens` cap raised** (`src/providers/anthropic.ts`): Now defaults to 120,000 if not specified by the caller.
- **Beliefs route `max_tokens` raised** to 8,000; compaction runner `max_tokens` raised to 5,000.
- **Admin error log projection** (`src/routes/admin.ts`): Now includes `turn_id`, `passthrough_succeeded`, `exception_type`, and `stack_trace` fields.
- **`.gitignore`**: Added `.vscode-test` and `.vscode` entries.

---

## [1.0.13] - 2026-05-19

### Added

- **Agent isolation (`agent_id`) across the belief system**: Beliefs, sessions, extraction jobs, contradictions, and compaction now track an `agent_id` field, enabling per-agent belief partitioning. All readers, writers, and queries filter by agent identity so that beliefs belonging to one agent do not leak into another's context.
- **`belief_contradictions` collection and detection pipeline**: The compaction runner now detects contradicting beliefs within a scope and persists them as `BeliefContradiction` documents with `pending`/`resolved` status. Dedicated indexes (`contradictions_agent_scope_status`, `contradictions_pending_recent`) support efficient querying.
- **`enriched` change kind for belief updates**: A new `"enriched"` signal allows the sidecar to append minor attributes to an existing entity without replacing its content. The merger calls the new `BeliefWriter.enrichContent` method, and the validator accepts `"enriched"` as a valid change kind.
- **`enrichContent` method on `BeliefWriter`**: Appends content to an existing belief, records the change in `change_log`, and returns success status.
- **`findByCanonicalNames` method on `BeliefsReader`**: Batch lookup of beliefs by canonical name with scope and agent filtering.
- **Sidecar prompt: belief enrichment guidance**: Explicit rules and examples for when to emit an `"enriched"` signal versus creating a new belief or superseding.
- **Expanded model support in `tiers.ts`**: Added detection and floor definitions for Bedrock GPT-OSS 120B, Bedrock Mistral Large 3 (675B), and Qwen3-235B-A22B-2507. GPT-4.1-mini and GPT-4.1-nano version extraction added.
- **`status` field on `SupportedFamilySummary`**: Each supported family now reports whether it is `"verified"` or `"community"`.
- **Repository metadata in OpenClaw plugin `package.json`**: Added `repository` field pointing to the GitHub repo with directory context.
- **`resolveScope` helper in chat route**: Extracted scope resolution logic into a dedicated async function with clear priority: agent identity wins unconditionally, then session-persisted scope, then first-turn auto-detection.

### Changed

- **OpenClaw plugin version bumped to `1.0.13`**: Both `openclaw.plugin.json` and `package.json` updated from `1.0.0` to `1.0.13`.
- **OpenClaw plugin session-agent map removed**: The in-memory `sessionAgentMap` with its bounded LRU eviction has been removed. Agent identity is now resolved directly from the context object on `session_start` and `resolveTransportTurnState`, eliminating the `before_tool_call` listener entirely.
- **OpenClaw plugin seeding moved to `session_start`**: `maybeSeedAgent` is now called eagerly during `session_start` for non-main agents instead of being deferred.
- **`--name tenure` removed from publish workflow**: The `--name` flag has been dropped from both the live and dry-run `openclaw plugin publish` commands.
- **Compaction runner refactored for agent-aware partitions**: `findQualifyingScopes` renamed to `findQualifyingPartitions`, grouping by both `scope` and `agent_id`. The `compact` method builds agent-isolation filters and handles `$or` collisions between type and agent filters.
- **Compaction LLM prompts updated**: Both `DEDUP_COMPACTION_PROMPT` and `PREFERENCE_COMPACTION_PROMPT` now instruct the model to detect and return contradictions alongside merges. `max_tokens` raised from 2000 to 20000.
- **`BeliefsReader` methods accept `agentId` parameter**: `listAlwaysOn`, `listPinnedFacts`, `listByScope`, `searchText`, `listPinnedOpenQuestions`, and `countActive` all support optional agent filtering via a new `mergeFilter` helper that safely combines `$or` clauses.
- **`ContextBuilder.build` accepts `agentId`**: Agent identity is threaded through to all belief reader calls and Atlas Search filters.
- **Atlas Search index updated to version 2**: `agent_id` added as a `token` field in the beliefs search index mapping. Agent isolation in text search uses a compound `should` clause with `minimumShouldMatch: 1`.
- **`BeliefMerger.merge` accepts `agentId`**: Passed through to `processSignal`, `insertNewBelief`, and `insertOpenQuestion` so all created beliefs inherit the correct agent.
- **Extraction job queue includes `agent_id`**: `EnqueueParams` accepts `agentId`, written to the job document for downstream use by the worker.
- **Session model includes `agentId` field**: `Session`, `SessionPatch`, and backup export/import types now carry `agentId`.
- **Belief type includes `agent_id` field**: The core `Belief` interface now requires `agent_id: string | null`.
- **`ExtractionJob` type includes `agent_id`**: Optional `agent_id` field added to the job interface.
- **Chat route passes `agentId` to context build, side effects, and streaming context**: The resolved agent ID flows end-to-end through injection, extraction enqueue, and streaming.
- **`readSidecarFlags` simplified**: `topicLabel` removed from `SidecarFlags`; topics array in side effects defaults to empty.
- **README model table expanded**: Added GPT-4.1-mini, Bedrock Nova 2/Premier (Nova Lite excluded), Bedrock GPT-OSS 120B (20B excluded), Bedrock Mistral Large 3, and Qwen3-235B-A22B-2507. Added a "floors" explanatory note.
- **Onboarding extraction `max_tokens` raised**: Bumped from 2000 to 4000.
- **Sidecar prompt example revised**: Replaced `prefers_direct_answers` example with an `expertise` subtype example (`javascript_react_expertise`). Removed `topic_shift` and `topic_label` fields from the example output.
- **`extractGptVersion` extended**: Now recognizes `gpt-4.1`, `gpt-4.1-mini`, and `gpt-4.1-nano` model IDs with appropriate version numbers.
- **`openai-o-series` regex broadened**: Detection pattern changed from `/^o[3-9]/i` to `/^o[3-9]\d*/i` to match multi-digit o-series models.
- **`bedrock-nova-pro` detection broadened**: Now matches `nova-pro`, `nova-premier`, and `nova-2` patterns.
- **Expertise synthesis now inherits `agent_id`**: New expertise beliefs copy agent identity from the existing expertise belief or the first source belief.

### Removed

- **`topic_label` from sidecar output schema**: The field is no longer extracted or used for topic tracking.
- **`topic_shift` from sidecar output schema**: Removed alongside `topic_label`.
- **`expandScopeHierarchy` import from chat route**: No longer used after scope resolution refactor.
- **In-memory `sessionAgentMap` from OpenClaw plugin**: Replaced by direct context reads.

---

## [1.0.12] - 2026-05-18

### Changed

- **`publish-openclaw-plugin.yml`**: Automate version updates to package.json.

---

## [1.0.11] - 2026-05-18

### Changed

- **`package.json`**: Install missing dependencies `@typescript/native-preview` & `tsx`.

---

## [1.0.10] - 2026-05-18

### Changed

- **`publish-openclaw-plugin.yml`**: Publish on new tags instead of release.

---

## [1.0.9] - 2026-05-18

### Added

- **`*.tgz` added to `.gitignore`** .
- **Type export added to OpenClaw plugin `package.json`**: The `exports` map now includes a `types` condition pointing to `./dist/index.d.ts`, and a top-level `types` field has been added alongside it.
- **Source maps enabled in `tsconfig.json`**: `sourceMap` flipped from `false` to `true`.

### Changed

- **`SKILL.md` metadata block converted from JSON to YAML**: The embedded `openclaw` metadata object has been reformatted from inline JSON to clean YAML. `curl` has also been added as a required binary alongside `docker`, and the Windows and Linux install entries have been removed.
- **`resolveToken` simplified**: The multi-step fallback chain (token file, `.env` file, `TENURE_TOKEN` env var) has been removed. The function now throws an explicit error if no token is provided in config, directing the user to run `!tenure onboarding`.
- **AVA `extensions` config changed from object to array**: The `extensions` field in `package.json` test config has been corrected from `{ "ts": "module" }` to `["ts"]`.
- **`tsconfig.json` excludes tightened**: Test files (`**/*.test.ts`), fixtures (`**/__fixtures__/**`), and mocks (`**/__mocks__/**`) are now explicitly excluded from the TypeScript build.

### Removed

- **`resolveToken` env var fallback tests removed**: The `resolveToken falls back to TENURE_TOKEN env var` and `resolveToken returns empty string when nothing available` test cases have been dropped, reflecting the simplified token resolution logic.

---

## [1.0.8] - 2026-05-18

### Changed

- **OpenClaw plugin dev dependencies pinned to exact versions**: `@types/node` bumped to `25.6.0`, `ava` to `8.0.0`, `openclaw` to `^2026.5.18`, and `typescript` to `6.0.3`.
- **`openclaw` dependency tree updated**: Bumped internal packages including `@agentclientprotocol/sdk` to `0.21.1`, `@earendil-works/pi-*` packages to `0.75.1`, `@google/genai` to `2.3.0`, `@clack/core` to `1.3.1`, `@clack/prompts` to `1.4.0`, `kysely` to `0.29.1`, `openai` to `6.38.0`, `openclaw` to `2026.5.18`, `undici` to `8.3.0`, `tokenjuice` to `0.7.1`, `ws` to `8.20.1`, and `typescript` to `6.0.3`.
- **Proxy dependencies replaced in `openclaw`**: `proxy-agent`, `global-agent`, `pac-proxy-agent`, `pac-resolver`, and related transitive packages removed. Replaced with the lighter `@openclaw/proxyline@0.3.3`, `http-proxy-agent@7.0.2`, and `https-proxy-agent@7.0.6`.
- **`sharp@0.34.5` added as an optional dependency** to `openclaw`, along with its full platform-specific binary set.
- **`quickjs-wasi@2.2.0` promoted** from a peer dependency to a direct dependency of `openclaw`.
- **`brace-expansion` bumped** from `5.0.5` to `5.0.6` in the root `package-lock.json`.
- **Removed packages**: `uuid`, `extract-zip`, `cli-highlight`, `serialize-error`, `global-agent`, `proxy-agent`, `pac-proxy-agent`, `pac-resolver`, `degenerator`, `ast-types`, `escodegen`, `estraverse`, and several other transitive dependencies removed as part of the proxy and tooling cleanup.

---

## [1.0.7] - 2026-05-18

### Added

- **OpenClaw plugin integration (`integrations/openclaw/`)**: New first-class integration package `@tenureai/openclaw-plugin` with a GitHub Actions publish workflow, `openclaw.plugin.json` manifest, `package.json`, TypeScript source, and a full test suite. The plugin registers a Tenure provider in OpenClaw, handles per-agent session isolation via `x-agent-id` headers, seeds beliefs from `USER.md` and `MEMORY.md` on first encounter, and suppresses extraction and injection during agent bootstrapping.
- **`POST /v1/beliefs` endpoint**: New route for manually creating beliefs from the UI or API, with full validation of type, epistemic status, scope, and canonical name. Returns `409` on canonical name conflict.
- **`GET /v1/commands` endpoint**: New route returning the full list of Tenure chat commands with their effects and scopes.
- **`!session` command**: New `matchSessionCommand` and `tryInterceptSessionCommand` helpers allow the OpenClaw plugin to bind a session key and agent ID on each turn, with full test coverage.
- **`buildOpenClawExtractionSystemPrompt`**: Dedicated extraction system prompt for OpenClaw workspace file ingestion, with agent-scoped scope assignment rules and template-filtering guidance.
- **`New Belief` button in beliefs UI**: Inline creation modal with fields for type, canonical name, content, why it matters, scope, and aliases.
- **Aliases displayed in belief cards**: Alias badges now render below belief content in the UI.
- **Aliases editable in the edit modal**: The edit modal now includes a comma-separated aliases field.
- **`x-tenure-bootstrapping` header support**: Extraction and injection are suppressed when the OpenClaw agent is mid-bootstrap.
- **`docker-compose.yml` user field**: `user: "${UID:-1000}:${GID:-1000}"` added to the `tenure` service.

### Changed

- **`chown` moved after `init` exit in `entrypoint.sh`**: The `chown -R tenure:tenure` call now runs only on the normal startup path, not during `init`, avoiding a permission error when the mount is owned by the host user.
- **Agent scope pinning**: When `x-agent-id` is present on a request, the session scope is set directly from the agent identity rather than going through first-turn auto-detection.
- **`listPinnedFacts` query tightened**: The `$or: [{ user_edited: true }, { scope: { $in: scope } }]` branch has been removed; pinned facts now require scope match. `user_edited` beliefs no longer surface cross-scope.
- **`BeliefMerger` passes scope to `findByAliasOrCanonical`**: Deduplication during extraction is now scope-aware, preventing cross-scope canonical name collisions from blocking new beliefs.
- **`BeliefWriter.findByCanonicalName` and `findByAliasOrCanonical` accept optional `scope` filter**.
- **Sidecar prompt revised**: Scope assignment rules condensed to three priority rules, `user:universal` narrowed to direct communication-style statements, example beliefs updated, and the `epistemic_status` and `topic_label` instructions moved inline before the closing `SIDECAR_END`.
- **Import and onboarding extraction prompts updated**: `resolves_open_question`, expanded `TYPES` list, `CONFIDENCE` block with explicit thresholds, and revised `ALIASES` guidance added to both `buildImportExtractionSystemPrompt` and the onboarding extraction prompt.
- **`retrieval.cases.json` fixture updated**: `user-edited-cross-scope-surfaces` test case now asserts the belief is excluded (`mustExclude`) rather than included, reflecting the scope isolation fix. `maxBeliefs` budget case corrected from `3` to `2`.
- **`seeded_agent:` and `seed_attempted_at:` keys allowlisted** in `PUT /admin/config/:key` without requiring an explicit entry in the safe key set.
- **`SKILL.md` replaced**: The monolithic `integrations/openclaw/SKILL.md` has been removed and replaced with `integrations/openclaw/skills/tenure/SKILL.md`, rewritten with updated install steps (token now read from `~/.tenure/token`), a revised onboarding flow using the probe-models and validate-model endpoints, and expanded agent notes.
- **`BeliefsDeps` now requires `beliefWriter`**: Wired through from `server.ts` using a new `BeliefWriter` instance.

### Fixed

- **`saveEdit` in beliefs UI**: `aliasesRaw` variable was referenced before being declared; the assignment has been hoisted.

---

## [1.0.6] - 2026-05-15

### Changed

- **`docker-compose.yml`**: Add missing creds.

---

## [1.0.5] - 2026-05-15

### Added

- **`!inject` commands documented in settings.md**: The Injection section has been added to `settings.md`, covering all four `!inject` commands (`!inject off`, `!inject on`, `!inject global off`, `!inject global on`), their effects, and the interaction with `!extract off` for fully clean sessions.
- **Scope command documentation in settings.md**: A "Setting scope manually" subsection has been added under Scope, documenting the `!scope` and `set scope` command syntax, multi-scope usage, all valid scope format rules, and the automatic hierarchy expansion behaviour.
- **`entrypoint.sh` `init` mode**: The entrypoint script now supports an `init` subcommand that writes the bundled `docker-compose.yml` to `TENURE_HOME`, generates a random MongoDB password, and writes a `.env` file with credentials. Both writes are skipped if the target files already exist.
- **`TENURE_HOME` environment variable support in `entrypoint.sh`**: The entrypoint now reads `TENURE_HOME` from the environment, defaulting to `/app/.tenure`, instead of hardcoding the path.
- **`docker-compose.yml` copied into container image**: The Dockerfile now copies `docker-compose.yml` into `/app/docker-compose.yml` so it is available for the `init` entrypoint path.

### Changed

- **README rewritten**: The README has been substantially revised with updated framing, a condensed problem statement, an expanded "Why This Is Different" section, a new "Trust and Ownership" section, and a streamlined structure throughout. The title has been shortened to remove the explicit client name list.
- **`settings.md` Advanced section trimmed**: The `History token cap` setting and `History compaction mode` table have been removed from the Advanced section.

## [1.0.4] - 2026-05-14

### Added

- **Animated loading indicator on onboarding submission**: The "Extracting beliefs..." text is now replaced with a three-dot bounce animation and the Tenure logo while the onboarding completion request is in flight.
- **Tenure logo on onboarding error state**: The logo is now shown above the extraction failure and zero-beliefs error messages.
- **`extractJsonBlock` consolidated into shared module**: `onboarding.ts` now imports `extractJsonBlock` from `src/extraction/extractJson.ts` instead of maintaining a local copy.

### Changed

- **`extractJsonBlock` hardened**: Now handles trailing commas via `stripTrailingCommas`, normalizes Unicode curly quotes and smart apostrophes via `normalizeQuotes`, and uses a brace-depth-tracking `extractOutermostObject` instead of a simple regex match. Multiple fallback parse attempts are made before returning `null`.
- **`tenure` metadata field removed from chat completion responses**: The `tenure` envelope (`session_id`, `turn_id`, `scope`, `parse_status`, `degraded`, `context`) is no longer included in non-streaming chat completion responses. Tests updated accordingly.
- **`injectionEnabled` now suppresses injection for IDE clients**: IDE clients detected via `ua-parser-js` now have injection disabled by default, matching the existing extraction suppression behaviour.
- **Compacted history no longer injected into conversation messages**: `renderCompacted` is no longer called on the hot path; compacted turns are not prepended to the outgoing message array.
- **`EMPTY_RENDERED` import removed from `chat.ts`**: No longer needed after the compacted history removal.
- **Static assets copied into dist image**: `COPY src/static ./dist/static` added to the Dockerfile so static files are available at runtime.

### Removed

- **`parse_status` and `degraded` assertions removed from pipeline and chat integration tests**: Tests no longer assert on `tenure.parse_status` or `tenure.degraded` since the metadata field has been dropped from responses.

---

## [1.0.3] - 2026-05-13

### Added

- **`host.docker.internal` extra host mapping**: Added `host.docker.internal:host-gateway` to the Docker Compose service and install scripts (`install.sh`, `install.ps1`), allowing the container to reach services running on the Docker host.
- **`POST /admin/maintenance/compact` endpoint**: New admin route that triggers a belief compaction run manually. Returns `{ ok: true }` on success or a 500 with an error message on failure.
- **`compactionRunner` and `userId` on `AdminDeps`**: The admin router now accepts a `BeliefCompactionRunner` instance and a `userId`, wired through from `ServerDeps` in `server.ts`.

### Changed

- **Port binding made public in install scripts**: The `tenure` service port binding in both `install.sh` and `install.ps1` has been changed from `127.0.0.1:${TENURE_PORT:-5757}:5757` to `${TENURE_PORT:-5757}:5757`, allowing the service to bind on all interfaces rather than localhost only.

---

## [1.0.2] - 2026-05-12

### Added

- **`entrypoint.sh` support**: A dedicated entrypoint script is now copied into the container image and set as the `ENTRYPOINT`, replacing the previous approach of running directly as the `tenure` user via `USER`.
- **`gosu` dependency in runtime image**: Installed in the runtime stage to support controlled user switching from the entrypoint script.
- **`ca-certificates` in crypt stage**: Added alongside `curl` for more reliable TLS handling during the crypt library download.

### Changed

- **Base image changed from Alpine to Debian Slim**: All build stages (`crypt`, `deps`, `build`) now use `node:25-bookworm-slim` instead of `node:25-alpine`, aligning all stages with the existing runtime stage.
- **`npm ci` now runs with scripts enabled**: The `--ignore-scripts` flag has been removed from the `deps` stage.
- **`tenure` system user hardened**: The user is now created with `--no-create-home` and `--shell /usr/sbin/nologin` to reduce the attack surface.
- **Docker Compose service renamed**: The service previously named `proxy` has been renamed to `tenure` in both `install.sh` and `install.ps1`.
- **`getBeliefMasterKeyPath` now accepts `TENURE_HOME`**: The call in `app.ts` now passes `process.env.TENURE_HOME` to allow the belief master key path to be configured via environment variable.

---

## [1.0.1] - 2026-05-12

### Added

- **`!inject` command**: Belief injection can now be paused and resumed per-session with `!inject off` / `!inject on`, or globally with `!inject global off` / `!inject global on`, mirroring the existing `!extract` command surface.
- **`injection_enabled` runtime config flag**: Global injection toggle added to `RuntimeConfig` with a default of `true`. Exposed in the admin UI alongside the existing extraction toggle.
- **`injectionPaused` session field**: Sessions now track injection pause state independently from extraction pause state. Both flags compose with their respective global flags.
- **`clientCategory` on extraction jobs**: The parsed client category from the `User-Agent` header is now recorded on extraction job payloads for logging and analytics.
- **`ua-parser-js` dependency**: Added for structured User-Agent parsing. IDE clients detected this way suppress extraction by default.
- **`X-Tenure-No-Extract` header**: Per-request extraction suppression without touching session or global state.
- **File attachment support in Anthropic adapter**: `file` content parts with data URLs are now translated to Anthropic `document` blocks with MIME type validation. Unsupported types degrade gracefully to a text placeholder.
- **Tool call support in OpenAI adapter**: Streaming and non-streaming paths now accumulate and surface tool call deltas in `stream_end` and non-streaming responses.
- **Adaptive extraction sweep**: The background sweep job now backs off exponentially (up to 5 minutes) when consistently finding no work, and resets to the 1-minute base interval when work is found.
- **`!extract` command**: Per-session and global extraction control directly from the chat client, without opening Settings.
- **`_id` field added to Atlas Search index mappings**: Enables `mustNot` exclusion of specific belief IDs at the Atlas Search layer rather than in a downstream `$match` stage, improving query efficiency.

### Changed

- **Context assembly**: `context.build()` is now skipped entirely when injection is paused, avoiding unnecessary MongoDB and vector search round trips.
- **System prompt construction**: Persona framing, pinned facts, relevant beliefs, and open questions are omitted from the system prompt when injection is off. Extraction instructions are omitted when extraction is off.
- **Pinned belief deduplication**: Pinned belief IDs are now passed as `excludeIds` directly into `searchText` so deduplication happens at the Atlas Search layer rather than in application code after the fact.
- **`extractLatestUserMessage` renamed to `extractLatestUserText`**: Now handles `ContentPart[]` message content in addition to plain strings.
- **`mergeSystemPrompt` in OpenAI adapter**: Now safely extracts text from `ContentPart[]` system message content instead of coercing to `"[object Object]"`.
- **`max_tokens` default in Anthropic adapter**: Raised from `4096` to `8192`.
- **`openai` package removed as a dependency**: The direct `openai` npm package has been dropped.
- **`@aws-sdk/client-bedrock-runtime` removed**: Dependency fully removed from `package-lock.json` and `package.json`.
- **Scope prompt simplified**: Scope assignment instructions condensed to a four-rule priority list instead of a multi-bullet explanation.
- **`epistemic_status` prompt clarified**: Inline rules in the sidecar prompt now make the three states unambiguous and explicitly note that corrections are always `active`.
- **`CONFIDENCE` block added to sidecar prompt**: Explicit thresholds (0.9-1.0 / 0.75-0.89 / 0.5-0.74 / omit) now appear inline in the extraction prompt.
- **`WORLD STATE` type mapping clarified in sidecar prompt**: Explicit rules for when to emit `entity`, `decision`, or both.
- **`SOURCE RULE` block expanded in sidecar prompt**: Pasted reference material is now explicitly excluded from extraction with examples.
- **Anthropic adapter `listModels`**: Auth failures now surface as thrown errors rather than silently returning an empty list.
- **OpenAI adapter `listModels`**: 401 responses now throw a `ProviderError` rather than returning an empty list. Added a 10-second timeout.
- **OpenAI adapter `call` and `stream`**: Both paths now apply a 120-second `AbortSignal.timeout`. Non-present `model` field now throws an explicit error.
- **`PersonaSummaryService.regenerate` removed**: Callers use `invalidate` + `get` directly. In-flight deduplication added to prevent concurrent regeneration for the same user.
- **`listAlwaysOn` removed from `BeliefsReader` interface**: All call sites updated.
- **`scope_auto_detect` and `injection_enabled` added to the safe admin config key set**: Both keys are now accepted by the `PUT /admin/config/:key` route.
- **`scopePrelude` assertions removed from eval test cases**: Scope prelude checks removed from both BM25 and vector eval runners.
- **`content` field removed from Atlas Search index**: `lucene.english` analyzer on `content` dropped from the search index definition.
- **Jobs index key extended**: Pending jobs index now includes `created_at` as a tertiary sort key.
- **`beliefs` route `redactForClient`**: Now includes `scope` and `aliases` fields in the client-facing belief representation.
- **Error forwarding in server error handler**: A safe-list of error message patterns (auth failures, rate limits, missing model/provider) are now forwarded to the client verbatim instead of being replaced with `"internal server error"`.
- **Extraction sweep job**: Refactored from `SimpleIntervalJob` with a fixed 1-minute interval to an adaptive scheduler with exponential backoff.
- **`tslib` moved to devDependencies**: No longer a runtime dependency.
- **All runtime and dev dependencies pinned to exact versions** (carried forward from 1.0.1, now reflected in `package-lock.json`).

### Fixed

- **`PersonaSummaryService`**: Hash check now occurs before the LLM call, and a re-check after the LLM call prevents a race where two concurrent regenerations both write. In-flight deduplication prevents redundant parallel calls for the same user.
- **`install.sh` retry URL**: Now points to the correct raw GitHub URL instead of a placeholder domain.
- **`ipaddr.js`**: Bumped from `2.3.0` to `2.4.0`.
- **`pino`**: Downgraded from `10.3.1` to `9.14.0`; `pino-abstract-transport` correspondingly downgraded from `3.0.0` to `2.0.0`; `thread-stream` from `4.0.0` to `3.1.0`.
