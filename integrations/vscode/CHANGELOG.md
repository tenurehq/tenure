# Changelog

All notable changes to Tenure will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

Here's the changelog entry based on the patch:

---

## [1.0.22]

### Changed

- **`tsx` updated to `4.22.4`** (`package-lock.json`): Dev dependency bumped from `4.22.2`.
- **`esbuild` platform packages updated to `0.28.1`** (`package-lock.json`): All `@esbuild/*` platform-specific packages (aix-ppc64, android-arm, android-arm64, android-x64, darwin-arm64, darwin-x64, freebsd-arm64, freebsd-x64, linux-arm, linux-arm64, linux-ia32, linux-loong64, linux-mips64el, linux-ppc64, and others) bumped from `0.28.0` to `0.28.1`.
- **Build tooling migrated from `tsup` to `tsdown`** (`package.json`, `package-lock.json`): The VS Code extension's build scripts now use `tsdown` instead of `tsup`. The `build` script is simplified to a bare `tsdown` call, and `build:test` is updated with `tsdown`-compatible flags. The `tsup` dev dependency is replaced with `tsdown@^0.22.2`. The `tsdown` package replaces `tsup`'s dependency set with a new set including `rolldown`, `unconfig-core`, `hookable`, `empathic`, and others, and raises the minimum Node.js requirement to `^22.18.0 || >=24.0.0`.
- **`typescript` no longer marked as a peer-only dependency** (`package-lock.json`): The `peer` flag was removed from the `typescript` entry, making it a standard dev dependency.
- **`tslib@2.8.1` added** (`package-lock.json`): New transitive dev dependency introduced alongside the `tsdown` migration.
- **`ufo` replaced by `unconfig-core@7.5.0`** (`package-lock.json`): The `ufo` package is removed and `unconfig-core` (with dependencies `@quansync/fs` and `quansync`) takes its place as part of the `tsdown` dependency tree.

---

### Changed

- **README restructured**: Restructured to align with the website and Github.

---

## [1.0.21]

### Added

- **`tenure.configureDeployment` command** (`package.json`): New command lets users choose between a local Docker install or an enterprise server deployment.

### Changed

- **README restructured and expanded**: Added a dedicated "BYOK. Your models. Your memory." section explaining provider support (OpenAI, Anthropic, AWS Bedrock, local models, and OpenAI-compatible endpoints). Moved the client compatibility table earlier in the doc. Updated onboarding copy to be provider-agnostic.
- **"Tenure: Run Setup" renamed to "Tenure: Configure Deployment"** (`package.json`): Command title updated to reflect broader deployment options.
- **"Create .tenure File" added to commands table** (README): Previously undocumented command now appears in the reference table.
- **Docs links updated to `tenureai.dev`** (README): Quickstart, beliefs, and retrieval links now point to the new docs site instead of GitHub.
- **Trailing commas removed across TypeScript source files**: Minor style cleanup across `beliefsViewProvider.ts`, `extension.ts`, `installer.ts`, and related files.

---

## [1.0.20]

### Added

- **VSCodium host environment support** (`hostEnvironment.ts`): `"vscodium"` added as a named `HostApp` variant, detected when the app name contains `"vscodium"`. Previously, VSCodium would fall through to `"unknown"`.
- **VSCodium client detection** (`clientIntegrations.ts`): `DetectedClients` now includes a `vsCodium` flag, set by checking whether the running app name contains `"vscodium"`.
- **VSCodium entry in connected clients panel** (`clientStatusPanel.ts`): When VSCodium is detected, a `"VSCodium (this editor)"` row is added to the client status panel with `connectionType: "lm_provider"` and no action required.

### Changed

- **`isNativeVSCode` check broadened to include VSCodium** (`extension.ts`): The flag that gates native LM provider registration now evaluates true for both `"vscode"` and `"vscodium"` host environments, enabling the `TenureLmProvider` to register in VSCodium as it does in VS Code.

---

## [1.0.19]

### Added

- **Categorized beliefs sidebar**: The beliefs panel now groups beliefs into three sections -- **This File**, **Project**, and **Universal** -- rather than showing a flat list. The active filename is displayed as a section label when file-level beliefs are present.
- **Injection and Extraction toggles**: The sidebar now shows toggle switches for Belief Injection and Belief Extraction. Changes take effect immediately and are reflected across all connected clients.
- **Scope selector in Record Belief form**: When manually recording a belief, you can now choose whether to scope it to the current file, the project, or universally, via a segmented button control.
- **`fetch_categorized_beliefs` WebSocket message**: The extension now sends a single `fetch_categorized_beliefs` request instead of the previous separate `fetch_beliefs` / `fetch_file_beliefs` pair. The server responds with a `beliefs_categorized` message containing pre-separated file, project, and universal arrays.
- **`set_toggle` and `fetch_toggles` WebSocket messages**: New client messages allow the sidebar to read and write injection/extraction toggle state directly over the WebSocket connection.
- **`toggles_state` server message handling**: The webview now listens for `toggles_state` messages and updates the toggle checkboxes in real time when the state changes from any source.

### Changed

- **`pushState` replaced by `pushCategorizedState`** (`beliefsViewProvider.ts`): The internal method that posts beliefs to the webview now sends a `categorized_state` message with `file`, `project`, and `universal` arrays plus a `totalActive` count, instead of a flat `state` message with a single `beliefs` array. Legacy `state` messages are still handled in the webview for backward compatibility.
- **`fetch_file_beliefs` removed from client and server**: All file-belief fetching is now handled through `fetch_categorized_beliefs`. The old `fetch_file_beliefs` handler has been removed from the WebSocket route.
- **`fetch_beliefs` removed from client and server**: Replaced entirely by `fetch_categorized_beliefs`.
- **Active file now tracked on `updateFileBeliefs`** (`beliefsViewProvider.ts`): `currentActiveFile` is set at the point a file-switch is detected, ensuring the correct file context is used when categorizing beliefs client-side after incremental updates.
- **Client-side categorization on incremental updates**: When a `belief_upserted`, `belief_superseded`, `record_ack`, or `patch_ack` message arrives, beliefs are now re-categorized locally using `categorizeBeliefsClientSide` before pushing to the webview, keeping sections consistent without a round-trip.
- **`.tenure` file prompt changed to preview mode** (`workspaceSync.ts`): The prompt now offers to open a preview of the file content in an unsaved editor rather than writing the file to disk immediately. The prompt is also gated on the workspace having a detectable git remote or existing Tenure config.
- **Scope filter on audit page changed to a dropdown** (`audit-ui.ts`): The free-text scope filter input has been replaced with a `<select>` populated from `/admin/audit/scopes`, listing only scopes that have actually appeared in your audit history.
- **Pinned belief border color updated**: Pinned cards now use `var(--vscode-foreground)` for the left border accent instead of `var(--vscode-charts-green)`.
- **Record Belief form resets scope selection on close**: Closing or submitting the form resets the scope selector back to "Project".

### Removed

- **`beliefs_snapshot` WebSocket message**: Superseded by `beliefs_categorized`. The server no longer emits `beliefs_snapshot` in response to any client message.
- **`fetch_beliefs` and `fetch_file_beliefs` client/server message types**: Removed from both the TypeScript types and the WebSocket handler switch.
- **`pushState` method** (`beliefsViewProvider.ts`): Replaced by `pushCategorizedState`.
- **`tryReadTurnSignal` function** (`splitter.ts`): Removed along with the `turn_signal` field. The extraction schema now uses `orientation_tax: boolean` in place of the previous `turn_signal` enum.

---

## [1.0.18] - 2026-05-22

### Added

- **`languageModelChatProvider` registration** (`extension.ts`): The extension now registers a `TenureLmProvider` as a native VS Code language model chat provider under the `"tenure"` vendor, visible only when a token is configured. Registration is skipped in non-VS Code host environments (e.g. Cursor).
- **`OnboardingPanel`** (`extension.ts`): New `tenure.runOnboarding` command opens a dedicated setup panel that walks through Docker installation, provider connection, model selection, and initial belief seeding.
- **`tenure.startInstall` command** (`extension.ts`): Triggers automated Tenure installation via `ensureTenureRunning`, with a live status bar indicator showing progress. On success, the LM provider and beliefs view are refreshed automatically.
- **`tenure.handleClientAction` command** (`extension.ts`): Handles per-client setup actions dispatched from the sidebar — copying the base URL or token, auto-configuring Continue, or opening provider docs.
- **Automatic token detection on startup** (`extension.ts`): If Tenure is already healthy but no token is stored, the extension now reads the token from `~/.tenure/token` and saves it automatically rather than prompting the user.
- **Automatic image update on version change** (`extension.ts`): On activation, if the stored `tenure.lastSeenVersion` differs from the current extension version, `updateTenureImage` is called to pull the latest Docker image and reconnect.
- **Window focus reconnect** (`extension.ts`): `onDidChangeWindowState` now calls `ensureConnected` when the window regains focus, recovering stale WebSocket connections after sleep or switching away.
- **Onboarding prompt in sidebar** (`beliefsViewProvider.ts`): A new `onboarding_prompt` state renders a styled banner in the beliefs panel prompting the user to set up a provider, with a button that triggers `tenure.runOnboarding`.
- **Connected clients panel in sidebar** (`beliefsViewProvider.ts`): A collapsible "Connected clients" section now appears below beliefs, showing each detected client (e.g. Continue) with a status dot and a contextual action link (Set up / Copy URL / Copy token / View docs).
- **`onboardingMode` flag on `TenureBeliefsViewProvider`** (`beliefsViewProvider.ts`): Suppresses the "disconnected" state while the onboarding prompt is active so the two states don't clobber each other.
- **`resetAndReconnect` method** (`beliefsViewProvider.ts`): Clears onboarding mode and reconnect backoff, then immediately re-establishes the WebSocket used after successful installation or token save.
- **`updateClientStatus` method** (`beliefsViewProvider.ts`): Accepts an array of `ClientRow` objects and pushes a `client_status` message to the webview to update the clients panel live.
- **`showOnboardingPrompt` method** (`beliefsViewProvider.ts`): Posts an `onboarding_prompt` message to the webview and sets `onboardingMode`.
- **`checkAndPromptOnboarding`** (`workspaceSync.ts`): After each successful workspace sync, checks `/admin/providers` and `/admin/config` to detect whether a provider and model are configured. Prompts the user with a notification and optional "Set up Tenure" action if either is missing. Prompt is shown at most once per session and respects a persistent `tenure.onboardingNudgeDismissed` dismissal flag.
- **`checkAndPromptTenureFile`** (`workspaceSync.ts`): On first sync in a workspace without a `.tenure` file, offers to create one pre-populated with the inferred project name and commented-out `context` fields. Opens the created file in the editor immediately.
- **`openOnboarding`, `clientAction`, and `openInstall` webview message handlers** (`beliefsViewProvider.ts`): The sidebar now handles these message types from the webview script and dispatches to the corresponding VS Code commands.
- **Walkthrough opens on install** (`package.json`): `openOnInstall: true` added to the setup walkthrough so new users are guided through setup automatically on first install.

### Changed

- **Minimum VS Code engine bumped to `^1.110.0`** (`package.json`): Up from `^1.85.0`; `@types/vscode` updated to match.
- **Extension version bumped to `1.0.17`** (`package.json`).
- **Walkthrough simplified to a single step** (`package.json`): The four-step walkthrough (set token, point client, understand scope, view beliefs) has been replaced with a single "Set up Tenure" step that opens the onboarding panel.
- **`tenure.recordBeliefFromSelection` command removed** (`package.json`, `extension.ts`): Replaced by `tenure.runOnboarding`. The editor right-click context menu entry and command registration have been removed.
- **Sidebar panel renamed from "Active Beliefs" to "Tenure"** (`package.json`): The `when` condition gating visibility on `tenure.tokenConfigured` has also been removed so the panel is always visible.
- **WebSocket URL updated to `/v1/ws/beliefs`** (`beliefsViewProvider.ts`): Matches the server-side route rename from `/v1/beliefs/ws`.
- **Socket connection no longer requires a token to open** (`beliefsViewProvider.ts`): Token check moved inside the `open` event handler; a missing token now posts `no_token` to the webview and schedules a reconnect instead of aborting before opening.
- **`beliefs_snapshot` always updates the view** (`beliefsViewProvider.ts`): The guard that suppressed empty snapshots has been removed; an empty `beliefs_snapshot` now clears the list.
- **"Record Belief" bar hidden until connected** (`beliefsViewProvider.ts`): The bar is now `display:none` by default and is only shown when a `state` message arrives, preventing the button from appearing in disconnected or onboarding states.
- **`disconnected` state message updated** (`beliefsViewProvider.ts`): Copy changed from "Tenure proxy is unreachable" to "Tenure isn't running", with an inline "Set up Tenure" link that dispatches `openInstall`.
- **`no_token` state added to webview** (`beliefsViewProvider.ts`): Renders "Not configured / Set your Tenure token to get started" when the WebSocket closes without a stored token.
- **`pushState` called only when `currentScope` is set on `ready`** (`beliefsViewProvider.ts`): Prevents a premature push before scope is resolved.
- **`ensureConnected` called after `pushState` on `ready`** (`beliefsViewProvider.ts`): Ensures the socket is open whenever the webview reports ready with a known scope.
- **`lastSyncedState` no longer persisted to `workspaceState`** (`workspaceSync.ts`): State is now held only in memory, removing stale-cache issues across sessions.
- **`fileMeta` stat guarded to `file:` scheme** (`workspaceSync.ts`): `vscode.workspace.fs.stat` is now skipped for non-file URIs to avoid errors on virtual documents.
- **`onDidChangeActiveTextEditor` handler guarded to `file:` scheme** (`extension.ts`): File belief fetches are skipped for non-file editors (output panels, diffs, etc.).
- **`lmProvider` passed into `WorkspaceSync`** (`workspaceSync.ts`, `extension.ts`): Allows `checkAndPromptOnboarding` to call `lmProvider.refresh()` after confirming a provider and model are configured.

### Removed

- **`tenure.recordBeliefFromSelection` command and context menu entry**: Replaced by the onboarding flow.
- **Workspace state persistence for `tenure.lastSyncedState`**: Sync state is now ephemeral per session.
- **JSDoc comments on `pushState` and `buildShell`** (`beliefsViewProvider.ts`): Removed as no longer necessary.
