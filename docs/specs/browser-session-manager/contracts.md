# Contracts — Browser Session Manager (BSM) MVP

Append-only. Each phase appends its own section when it completes —
interfaces, schema/data shapes, naming, and decisions later phases must
honor. Do not edit a prior phase's section; add a new dated note instead if
something needs correcting.

Spec: `tasks/context/browser-session-manager/spec.md`. Manifest:
`manifest.md` in this directory.

## Settled decisions

All approved by the user on 2026-10-28 (spec L6). Not open.

- **Q-001 = A** (L663-677): MVP ships `fresh_login` + `saved_state`, plus
  the human-only headed `browser-login` CLI (REQ-017, P6). No CDP attach.
- **Q-002 = A** (L679-694): `environment: production` is rejected at
  profile import with `environment_not_allowed`. Only `local`/`staging`.
- **Q-003 = A** (L696-710): secrets come only from env vars
  `WAYCONTEXT_BROWSER_SECRET_<NAME>`, read through `src/config.js`; the
  profile names the suffix; no other env var is resolvable.
- **Q-004 = A** (L712-728): saved state at
  `~/.local/state/waycontext/browser/<org>/<project>/<profile>/`
  (overridable by config), file mode `0600`, unencrypted; DB holds only an
  opaque `storage_ref`.
- **Q-005 = A** (L730-746): `playwright-core` as an optional dependency,
  lazily imported; Chromium installed explicitly via
  `npx playwright install chromium`.
- **Q-006 = A** (L748-765): profiles are YAML imported by the human-only
  `waycontext browser-profile import|remove` CLI into `browser_profiles`;
  not an operation.
- **Q-007 = A** (L767-780): `browser_navigate` and
  `browser_capture_screenshot` are in the MVP (P5).
- **Q-008 = A** (L782-798): browser tools are MCP and CLI only; HTTP
  `/v1/ops` refuses them — a deliberate, tested exception to the registry
  convention.
- **Migration number:** `0018` (`src/migrations/0018_browser_sessions.sql`,
  L434); highest existing is `0017_embed_hash.sql`.

- **REQ-015 navigation guard ownership** (user, 2026-10-28). P3 builds the
  guard inside the runtime adapter (main-frame navigations, redirects, script
  navigations, popups) and defines the `origin_blocked` result/error shape plus
  a callback/event through which blocked navigations are reported. The adapter
  does not write to the DB: P4 wires that callback to the audit writer. P2 does
  not implement any part of REQ-015. P5 only consumes the guard.

## Pending cross-phase decisions

Left open by the spec and load-bearing for more than one phase. The phase
that first hits a decision resolves it here, not silently in local code.

- **HTTP exclusion mechanism (P1, P4, P5).** Q-008 A is settled but not how
  an operation is marked as non-HTTP (e.g. an operation-level surface flag
  vs a name filter in `src/http.js`), nor the HTTP status/body for a
  refused call. P1 registers the first browser op, so P1 decides.
- **Audit `actor` and `correlation_id` source (P1, P4, P5, P6).** REQ-016
  (L299-301) requires `actor` = `mcp`/`cli`/`http`, but handlers receive
  only `ctx = { log }` with no surface info (L60). Decide how surface and
  correlation ID reach the handler, and the audit-writer API.
- **Profile YAML schema (P1, P2, P4, P6).** REQ-001 (L123-138) and REQ-011
  (L237-249) name the fields but not their shape: `login` field selectors
  and secret-name keys, `login_url_pattern` syntax, `verify` required
  selector/text assertion, optional identity assertion, and the "profile
  requests saving" flag (L186, L323).
- **Error / reason encoding (P1-P5).** How a thrown rejection carries its
  code (`session_not_found`, `origin_blocked`, `session_busy`,
  `auth_mode_mismatch`, ...) and how the § 6.2.3 `reason` values (L381-383)
  are represented, so tests and MCP `isError` output are consistent.
- **Runtime adapter interface (P3, P4, P5, P6).** CON-002 (L416-420)
  requires a substitutable adapter; its method surface and the fake used by
  unit tests are defined by P3 and consumed by later phases.
- **`storage_ref` format and artifact rows (P2, P4, P5, P6).** Opaque
  reference shape for `browser_session_artifacts.storage_ref` (L403), for
  both `storage_state` and `screenshot`, and how a ref resolves to a path.
- **Config key names and defaults (P1, P2, P4, P5).** § 8 (L438-441) names
  an idle timeout, a state/evidence directory and a `BROWSER_ENABLED` kill
  switch, but not the exact keys, the idle default, or whether the kill
  switch hides the tools from the catalogue or makes them refuse (L652
  "hides or disables").
- **Profile removal with live sessions (P1, P4).** § 9 (L457) requires live
  sessions be closed first; P1 builds `browser-profile remove` before
  sessions exist (P4). Decide the hook P4 provides and P1's interim
  behaviour.

## Phase sections

(Appended by each phase on completion.)

### P1 — Schema, profile store, policy core (done)

**Resolved pending decisions** (these supersede the matching bullets under "Pending cross-phase decisions"):

- **HTTP exclusion mechanism — RESOLVED.** An operation may declare `surfaces: ["mcp", "cli"]` (absent = all of
  `"mcp" | "cli" | "http"`). Every surface lists operations via `operationsFor(surface)` (`src/operations.js`).
  HTTP: `/v1/ops` catalogue and `/health.operations` use `operationsFor("http")`; `POST /v1/ops/<browser op>` returns
  **403** `{ error, code: "surface_not_allowed" }`. The `/mcp` route on the HTTP service is also unauthenticated, so
  `buildMcpServer({ surface: "http" })` registers no browser tools there; only stdio MCP (`surface: "mcp"`) and CLI have them.
  Every new browser op MUST set `surfaces: ["mcp", "cli"]`.
- **Audit actor / correlation source — RESOLVED.** Handler `ctx` is now `{ log, surface, correlationId }`.
  `surface` is `"mcp"` (stdio MCP), `"http"` (/mcp and /v1/ops), `"cli"` (CLI dispatch and the human-only commands);
  `correlationId` is a fresh `randomUUID()` per call, set by each surface. Handlers never choose either. Always pass `ctx` through.
- **Error / reason encoding — RESOLVED.** `src/browser/errors.js`: `class BrowserError extends Error { code }`, message is
  `"<code>"` or `"<code>: <detail>"`, so MCP `isError` text is `Error: <code>: ...`. `ERROR_CODES`: project_not_found,
  profile_not_found, invalid_profile, invalid_origin, origin_blocked, environment_not_allowed, auth_mode_mismatch,
  browser_disabled, surface_not_allowed, session_not_found, session_not_in_this_process, session_not_ready, session_busy.
  `REASONS` (returned in session results, never thrown): runtime_unavailable, secret_missing, state_missing, login_failed,
  verification_failed, state_expired, runtime_lost, idle_timeout. Branch on `.code`, never on message text.
- **Kill switch — RESOLVED (partial config).** `config.browserEnabled` from `BROWSER_ENABLED` (default on; `0` = off).
  Off => browser ops stay registered and visible but refuse with `browser_disabled` via `requireBrowserEnabled()`
  (`src/browser/ops.js`); every new browser op handler must call it first. Human CLI profile import/remove still work.
  Idle-timeout and state/evidence-dir config keys are NOT defined yet (P2/P4/P5).
- **Profile removal with live sessions — RESOLVED.** `removeProfile` calls the optional hook set via
  `registerProfileRemovalHook(fn)` (P4 registers it to tear down runtimes; note the CLI is a separate process from the MCP
  server that owns them), then sets every non-terminal session row (`status NOT IN ('CLOSED','FAILED','EXPIRED')`) of that
  project+profile to `CLOSED`, `closed_at = now()`, auditing each as `session_closed` (`data.cause = "profile_removed"`).
- **Profile YAML schema — RESOLVED** (see below).
- **Still pending:** runtime adapter interface (P3), `storage_ref` format (P2), idle-timeout/state-dir config keys.

**Migration** `src/migrations/0018_browser_sessions.sql` (forward-only; `.gitignore` now has `!src/migrations/*.sql`
because `*.sql` would otherwise hide new migrations). Tables, all `project_id INT REFERENCES projects(id) ON DELETE CASCADE`:
- `browser_profiles(id SERIAL PK, project_id, profile_id TEXT, environment, base_url, allowed_origins JSONB, auth_mode,
  definition JSONB, created_at, updated_at)`, `UNIQUE(project_id, profile_id)`.
- `browser_sessions(id TEXT PK, project_id, profile_id TEXT (no FK, the text id), status TEXT (no CHECK; P4 owns values),
  reason, auth_mode NOT NULL, identity JSONB, owner_runtime JSONB, purpose, created_at, last_verified_at, expires_at, closed_at)`.
- `browser_session_artifacts(id BIGSERIAL PK, session_id TEXT REFERENCES browser_sessions ON DELETE CASCADE,
  artifact_type CHECK IN ('storage_state','screenshot'), storage_ref TEXT, created_at)`.
- `browser_audit_events(id BIGSERIAL PK, session_id TEXT NULL (no FK), project_id, event_type, actor CHECK IN
  ('mcp','cli','http'), result, correlation_id, data JSONB DEFAULT '{}', created_at)`; trigger refuses UPDATE
  ("browser_audit_events is append-only"); rows go only via project cascade.

**Modules and signatures** (all `src/browser/`, ESM):
- `origin.js`: `normalizeOrigin(entry) -> string` (throws `invalid_origin` unless bare http(s) origin; no wildcard/path/query/
  hash/credentials); `isOriginAllowed(url, allowedOrigins) -> boolean` (exact scheme+host+port; false for unparseable/non-http(s)).
  P3 navigation guard and P5 must use this.
- `profileSchema.js`: `parseProfileYaml(yamlTextOrObject) -> definition`; `assertEnvironmentAllowed(env)` (throws
  `environment_not_allowed` unless local/staging); `assertAuthMode(profileRowOrDef, requestedMode)` (throws `auth_mode_mismatch`);
  consts `ENVIRONMENTS`, `AUTH_MODES`, `SECRET_ENV_PREFIX = "WAYCONTEXT_BROWSER_SECRET_"`.
- `profileStore.js`: `importProfile(projectName, yamlOrObj, {orgId?, ctx?}) -> {project, profile_id, environment, base_url,
  allowed_origins, auth_mode, replaced}`; `removeProfile(projectName, profileId, {orgId?, ctx?}) -> {removed, profile_id,
  sessions_closed}`; `getProfile(projectId, profileId) -> {id, project_id, profile_id, environment, base_url, allowed_origins,
  auth_mode, definition} | null` (runtime use only, never expose `definition` to agents); `listProfiles(projectName, {orgId?}) ->
  [{profile_id, environment, base_url, allowed_origins, auth_mode, has_saved_state}]`; `setSavedStateProbe(fn|null)` where
  `fn({orgId, project, projectId, profileId}) -> boolean|Promise<boolean>` (**P2 must register the real probe**; default false);
  `registerProfileRemovalHook(fn|null)` where `fn({projectId, profileId, ctx}) -> Promise<void>` (P4).
- `audit.js`: `writeAuditEvent({projectId, sessionId?, eventType, result, ctx, data?}, db = pool) -> row` (actor = `ctx.surface`,
  must be mcp|cli|http else throws; correlation = `ctx.correlationId` or generated; pass a client as `db` to join a transaction);
  `AUDIT_ACTORS`; `newCorrelationId()`. `data` must hold no secret content. P1 event types: `profile_imported`,
  `profile_removed`, `session_closed`. Result vocabulary so far: `ok`.
- `ops.js`: `requireBrowserEnabled(enabled = config.browserEnabled)`; `browserProfileListOp(args)`.

**Operation registration shape** (in `operations`): `{ name: "browser_profile_list", readOnly: true, surfaces: ["mcp","cli"],
description, input: { project }, cli: { args: ["project"], aliases: ["browser-profiles"], label }, handler }`. Returns the array
above; unknown project throws `project_not_found`. Output uses flat `auth_mode` (spec says `auth.mode`). CLI help: new section
"browser" in `SECTIONS`, `OP_HELP.browser_profile_list`, `MANUAL_COMMANDS` entry `browser-profile`; golden `test/fixtures/help.txt`
regenerated. New ops need `OP_HELP` entries and a help.txt regeneration.

**Human-only CLI:** `waycontext browser-profile import <project> <file.yaml>` / `remove <project> <profile_id>` (switch case in
`src/cli.js`, not an operation; ctx `{surface:"cli"}`; prints JSON; errors exit non-zero with `<code>: detail` on stderr).

**Profile YAML schema** (strict: unknown keys fail; errors never echo values):
```yaml
profile_id: staging-admin            # ^[a-z0-9][a-z0-9._-]{0,63}$, unique per project
environment: staging                 # local | staging; production -> environment_not_allowed
base_url: https://staging.example.test
allowed_origins: [https://staging.example.test]   # bare http(s) origins, >=1, normalized on import, no wildcards
auth:
  mode: fresh_login                  # | saved_state
  save_state: false                  # profile asks for post-login state to be saved (default false)
login:                               # required for fresh_login, optional otherwise
  url: https://staging.example.test/login
  url_pattern: /login                # pathname prefix (no glob/regex); defaults to login.url's pathname; used to detect a login redirect
  username_selector: "#user"         # CSS selectors
  password_selector: "#pass"
  submit_selector: "#submit"
  username_secret: STAGING_USER      # SUFFIX of WAYCONTEXT_BROWSER_SECRET_<NAME>; ^[A-Z][A-Z0-9_]*$, not the full var name
  password_secret: STAGING_PASS
verify:                              # always required
  url: https://staging.example.test/admin
  selector: "#wpadminbar"            # at least one of selector / text
  text: Dashboard
  identity_selector: "#me"           # optional: where the logged-in identity is read
```
base_url, login.url, verify.url must each be on an allowed origin (`invalid_profile`, message names the field). The stored
`definition` is this normalized object (allowed_origins normalized, `url_pattern` filled, `auth.save_state` defaulted).

**Notes for later phases:** P2 registers the saved-state probe and must keep secrets out of `data`; P3/P4 consume `isOriginAllowed`
and `BrowserError("origin_blocked")`; P4 writes `browser_sessions` rows itself and should set `auth_mode` from the profile and use
`assertAuthMode`/`assertEnvironmentAllowed`; every browser op must set `surfaces`, call `requireBrowserEnabled()`, and add `OP_HELP`.
The existing `only the four operations that write...` test pins non-read-only ops, so P4/P5 must update it.

### P2 — Secret provider and state store (done)

**Resolved pending decisions** (supersede the matching bullets): `storage_ref` format; config keys (state dir; idle timeout still P4's);
redaction mechanism; secret-provider API.

**Config** (`src/config.js`): `config.browserStateDir` from `BROWSER_STATE_DIR` (leading `~` expanded; default
`~/.local/state/waycontext/browser`) is the single root for saved state AND screenshot evidence (no separate evidence key;
P5 uses `writeEvidenceFile`). `browserSecretEnvName(name) -> "WAYCONTEXT_BROWSER_SECRET_<name>"`, `browserSecret(name) -> string|undefined`
(live `process.env` read, env/.env only, not the JSON config file, never recorded in `sources`). Idle-timeout key still undefined (P4).

**Error codes added** to `ERROR_CODES`: `invalid_secret_name`, `secret_missing`, `state_missing`, `invalid_storage_ref`, `invalid_state_dir`.
`secret_missing`/`state_missing` are also `REASONS`; P4 should catch these `.code`s and return them as the session `reason`.

**`src/browser/secrets.js`**: `resolveSecret(name) -> string` (name = bare suffix `^[A-Z][A-Z0-9_]*$`, not starting with the prefix, else
`invalid_secret_name`; unset/empty -> `secret_missing` naming the variable only; registers the value for redaction); `hasSecret(name)`;
`registerSensitive(value)` (ignores < 3 chars); `redact(text)`, `redactDeep(value)` (copy), `redactError(err)` (copy keeping `.code`,
message and stack redacted), `clearSensitive()` (tests), const `REDACTED = "[REDACTED]"`. Redaction is an in-process backstop over resolved
secrets plus registered values (`loadStorageState` registers cookie values). Call `resolveSecret` only when typing into the page.

**`src/browser/stateStore.js`** (scope = `{ orgId, project, profileId }`, `project` is the project NAME; opts `{ baseDir = config.browserStateDir,
forbiddenRoots = [] }`): `saveStorageState(scope, state, opts) -> storage_ref` (async); `loadStorageState(scope, {baseDir}) -> state` (sync;
`state_missing` if none; registers cookie values); `hasSavedState(scope, {baseDir}) -> boolean` (sync, never reads content);
`deleteSavedState(scope, {baseDir}) -> boolean`; `writeEvidenceFile(scope, sessionId, name, data, opts) -> storage_ref` (async);
`resolveStorageRef(ref, {baseDir}) -> absolute path` (pure; `invalid_storage_ref` on malformed/escaping refs); `defaultStateDir()`;
`recordArtifact({sessionId, artifactType, storageRef}, db = pool) -> row` (type must be storage_state|screenshot and match the ref kind);
`listArtifacts(sessionId, db)`.

**`storage_ref` format** (opaque, relative to the root so the root can move; each scope segment is `encodeURIComponent`-encoded, `""`/`.`/`..` rejected):
- `storage_state:<org>/<project>/<profile>/storage-state.json`
- `screenshot:<org>/<project>/<profile>/evidence/<sessionId>/<name>` (sessionId, name match `^[A-Za-z0-9._-]+$`)
Files are mode 0600, directories 0700, written atomically (temp 0600 + rename). The root is refused (`invalid_state_dir`) if inside this repo,
any ancestor holding `.git`, or any `forbiddenRoots` entry (symlinks resolved). P4 should pass the project's indexed `root_path` in `forbiddenRoots`.
Unencrypted, per Q-004.

**Probe wiring**: `src/browser/ops.js#installSavedStateProbe(opts?)` registers the real `setSavedStateProbe` and runs at module load, so
`browser_profile_list.has_saved_state` is real whenever ops.js is loaded (CLI and MCP). It checks file existence only.

**Notes for later phases**: P3 no impact. P4: use `loadStorageState`/`saveStorageState` + `recordArtifact`, map `secret_missing`/`state_missing`
to reasons, run every outgoing result/log/audit `data`/error message through `redact*` (REQ-005 end-to-end is AC-005, only provable there).
P5: store screenshots with `writeEvidenceFile`, return only the resolved path or ref. P6: `browser-login` saves via `saveStorageState` with the same scope keys
(org from `currentOrgId()`, project name). `sessionStorage` is not in storageState (spec L635).

### P3 — Browser runtime adapter (done)

**Resolved pending decisions:** runtime adapter interface (CON-002); REQ-015 guard shape (ownership per Settled decisions).

**Dependency (Q-005):** `optionalDependencies.playwright-core ^1.64.1`; imported only in `src/browser/playwrightAdapter.js`, lazily on the first
`createSession`. Chromium via `npx playwright install chromium`. `INSTALL_HINT = "npm install playwright-core && npx playwright install chromium"`.
No new config keys. Headless is the default; the tests pass no env.

**Error codes added** (in `ERROR_CODES`, thrown): `runtime_unavailable` (playwright-core not loadable OR Chromium binary missing; message ends with the
install command), `runtime_launch_failed` (any other launch failure, and any use of a closed session / failed navigation). P4 maps a thrown
`runtime_unavailable` to the session `reason` `runtime_unavailable` (FAILED), and `runtime_launch_failed` to `runtime_lost`/FAILED as it sees fit.

**Adapter interface** (`src/browser/adapter.js` documents it; `assertAdapterShape(adapter)`):
- `createSession({ sessionId, allowedOrigins: string[], storageState?: object, headed?: boolean, onBlocked?: (event)=>void, onClosed?: (reason)=>void }) -> Promise<RuntimeSession>`
- `close() -> Promise<void>` (closes all sessions and browser processes)
- RuntimeSession: `goto(url) -> {url, status}`, `url()`, `fill(selector, value)`, `click(selector)`, `exists(selector, {timeoutMs?}) -> boolean`,
  `textContent(selector) -> string|null`, `containsText(text) -> boolean`, `storageState() -> {cookies, origins}` (no sessionStorage),
  `screenshot() -> Buffer(PNG)`, `isAlive()`, `close()` (idempotent). `onClosed(reason)` fires with `"crashed"` or `"disconnected"` when the runtime dies under a live
  session (P4 maps it to `runtime_lost`); it does not fire for a normal `close()`.
- Factories: `createPlaywrightAdapter({ loader?, launchOptions?, actionTimeoutMs? })` (`loader` is a test seam for the lazy import); `createFakeAdapter({ pages })`.
- Isolation: one new BrowserContext per session, `serviceWorkers: "block"`, downloads off. Browsers are shared per mode (headless/headed) and closed when
  their last session closes. P4 should create one adapter instance per process and call `adapter.close()` on shutdown.
- The adapter takes no DB handle and never writes audit rows.

**Navigation guard / `origin_blocked`:** every main-frame document request (initial, redirect hop, script-driven, popup) is vetted with `isOriginAllowed`
and aborted before it reaches the network. Subframes and subresources are not restricted (spec § 10). A block produces, exactly once:
1. a callback `onBlocked(event)` with `event = { sessionId, url, origin, kind }`; `kind` in `"navigation" | "redirect" | "script" | "popup"` (`BLOCK_KINDS`);
   `url` is origin + path only (query/fragment stripped, never log more); a throwing callback is swallowed. P4 turns it into a `browser_audit_events` row
   (suggested `event_type: "origin_blocked"`, `result: "blocked"`, data = the event) -- the callback is synchronous, so write through a queue/promise.
2. a rejection of the in-flight `goto()` (and of `click()` when it triggers a block, after a short settle) with `BrowserError("origin_blocked", "<origin> is not an allowed origin (<kind>)")`,
   with `err.blocked` = the same event. Script/popup blocks that happen with no op in flight are reported via the callback only.
Helpers exported from `adapter.js`: `blockedEvent`, `originBlockedError`, `reportBlocked`, `BLOCK_KINDS`.
Behaviour notes: allowed same-origin redirects are followed by the adapter; the page lands on the final URL. A blocked script navigation leaves the page on Chromium's
`chrome-error://` page. Non-http(s) targets (`file:`, `data:`) are blocked as `navigation`.

**Fake adapter** (`src/browser/fakeAdapter.js`, `createFakeAdapter({ pages })`): `pages[url] = { redirect?, scriptNavigateTo?, popup?, selectors?: {sel: text}, text?, status? }`
(unlisted urls are plain 200 pages). It runs the real guard logic (initial url, each redirect hop, scripted navigation, popup) with the same events and errors.
Test hooks: `adapter.failNextLaunch(code)`, `adapter.openSessionCount()`, `adapter.sessions`, `session.simulateCrash()` (calls `onClosed("crashed")`), `session.options`
(records `headed`/`storageState`), `session.calls`, `session.pageCount()`. `screenshot()` returns a 1x1 PNG, `storageState()` returns empty cookies.

**Notes for later phases**
- P4: build the login flow from `fill`/`click`/`exists`/`containsText`/`textContent` (selectors come from the stored profile, never from agents, CON-004); seed `storageState` from
  `loadStorageState`; export with `storageState()` then `saveStorageState`. Redact errors before returning them. Create the adapter lazily so an absent Playwright affects only browser ops.
- P5: `goto` is the navigate primitive (pre-checks the origin too, so `origin_blocked` is thrown before any request); `screenshot()` returns a Buffer for `writeEvidenceFile`.
  A login redirect (EXPIRED) is not detected by the adapter: compare `url()` against the profile's `url_pattern`.
- P6: request the human-only headed mode with `createSession({ headed: true, ... })`; the same adapter/guard applies. It needs a display (no DISPLAY -> `runtime_launch_failed`).
- Tests: real-browser integration tests live in `test/browser.adapter.playwright.test.js` and skip with a printed reason when Chromium cannot launch.

### P4 — Session manager and lifecycle ops (done)

**Resolved pending decisions:** idle-timeout key and default; `expires_at` semantics; cross-host liveness; `login_failed` vs `verification_failed`; session
status/reason strings; session manager API; the removal hook and REQ-015 callback wiring (see below).

**Config** (`src/config.js`): `config.browserIdleTimeoutSeconds` from `BROWSER_IDLE_TIMEOUT_SECONDS`, **default 900** (15 min); `0` or less disables the timer.
No other new keys. `BROWSER_ENABLED` and `BROWSER_STATE_DIR` are unchanged.

**Status strings** (`SESSION_STATUSES`, `src/browser/sessionManager.js`): `CREATED STARTING AUTHENTICATING VERIFYING READY EXPIRED FAILED CLOSED`.
`AUTH_REQUIRED` is reserved, never written. Terminal: `FAILED`, `CLOSED` (the row can never leave them; every UPDATE is guarded). `EXPIRED` holds no runtime
and can still be closed. Live (owned by a process): CREATED..READY.
**Reason strings** (column `browser_sessions.reason`, only the closed `REASONS` set): `runtime_unavailable` (launch threw `runtime_unavailable`), `runtime_lost`
(adapter `runtime_launch_failed` on launch, crash/disconnect via `onClosed`, `isAlive()` false, dead owner), `secret_missing`, `state_missing`, `login_failed`,
`verification_failed`, `state_expired`, `idle_timeout` (set on a `CLOSED` row). A `CLOSED` row has `reason` null except for idle timeout.

**`login_failed` vs `verification_failed` boundary.** `login_failed` = the login interaction could not be carried out: the login page was unreachable or
blocked (`origin_blocked` during login, e.g. a redirect off the allowlist), a selector was missing or timed out, or the adapter threw while filling/clicking.
`verification_failed` = the login steps ran to completion but the REQ-011 checks failed (final URL off-allowlist or on `login_url_pattern`, status >= 400, required
selector/text absent), or the verify navigation itself threw/was blocked. A wrong password lands on the login page => `verification_failed`. For `saved_state`
a *completed but failed* verification is `EXPIRED`/`state_expired`; an error thrown while verifying (blocked origin, network) is `FAILED`/`verification_failed`.
A `fresh_login` profile always verifies after login; `identity.role` is the trimmed (max 80 chars) text of `verify.identity_selector` only when it exists and is non-empty.

**`expires_at` semantics.** It is an idle *lease*, not a hard session lifetime: `now() + idle timeout`, set on READY and refreshed when an acquired call
(`withSession`) ends. `status` does not refresh it. The owner process closes the session itself (`idle_timeout`) when the lease passes with no call; a *non-owner*
uses the lease as the only liveness signal for another host (below). Terminal/EXPIRED rows keep their last value.

**Ownership / liveness** (`owner_runtime` = `{ host, pid, boot_id }`, per-process `boot_id`, evaluated on `status`, `close` and `withSession` for non-terminal rows):
1. `boot_id` is this process: the runtime must exist and report `isAlive()`; otherwise `FAILED`/`runtime_lost`.
2. Same `host`, other process: `kill(pid, 0)` says dead => `FAILED`/`runtime_lost`; alive => throw `session_not_in_this_process`, row untouched. A reused pid reads as alive,
   which is the safe direction (never READY, never mutated).
3. Different `host`: pids cannot be probed. Lease (`expires_at`) lapsed (DB clock, `expires_at < now()`) => `FAILED`/`runtime_lost`; otherwise `session_not_in_this_process`.
`session_not_found` is returned for an id in another project (indistinguishable from unknown) and is audited under the caller's project.

**Module** `src/browser/sessionManager.js`:
`createSessionManager({ adapter?, adapterFactory?, stateDir?, idleTimeoutMs?, hostname?, pid?, bootId?, isPidAlive?, verifyWaitMs? }) -> manager`. The adapter is created
lazily (`adapterFactory`, default `createPlaywrightAdapter()`), one per manager; `ops.js` keeps one manager per process: `getSessionManager()`,
`setSessionManager(m|null)` (tests), `shutdownBrowserSessions(ctx?)` (no-op if nothing started). Manager methods (all `ctx = { log, surface, correlationId }`, optional `orgId`):
- `start({ project, profileId, purpose, authMode?, ctx }) -> { session_id, status, reason?, auth_mode, environment, identity: {verified, role?}, last_verified_at }`
  (FAILED/EXPIRED are returned, not thrown). Throws `project_not_found`, `profile_not_found`, `environment_not_allowed`, `auth_mode_mismatch`, and `invalid_state_dir`
  (state save refused: the row is left `FAILED` with no reason, no READY is ever reported, the runtime is released).
- `status({ project, sessionId, ctx }) -> start's shape + { created_at, expires_at }`. Throws `session_not_found`, `session_not_in_this_process`. Not a locked operation.
- `close({ project, sessionId, ctx }) -> { session_id, status }`: `"CLOSED"` (idempotent, also from EXPIRED); a session already `FAILED` returns `status: "FAILED"` (terminal, nothing to release).
  Throws `session_not_found`, `session_not_in_this_process`, `session_busy` (a call is in flight).
- `withSession({ project, sessionId, tool, ctx }, fn) -> fn's result` (P5): see notes. Throws `session_not_found`, `session_not_in_this_process`, `session_not_ready`, `session_busy`.
- `closeProfileSessions({ projectId, profileId, ctx })` (registered as the P1 removal hook in `ops.js`; only reaches this process's runtimes), `shutdown({ ctx })` (closes every live session with
  `cause: "process_shutdown"`, then `adapter.close()`), `getAdapter()` (P6), `liveCount()`, `owner()`.
Wiring: `cli.js` calls `shutdownBrowserSessions` after every operation and on the error path; `src/server.js` (stdio MCP) calls it on SIGINT/SIGTERM and stdin end. Consequence: a session started
by a one-shot CLI command ends with that process; `browser-start` then `browser-status` from the shell shows `CLOSED`. A READY session is usable only through a long-lived process (stdio MCP).

**Operations** (`src/operations.js`, handlers in `src/browser/ops.js`; `surfaces: ["mcp","cli"]`, `requireBrowserEnabled()` first, results `redactDeep`, errors `redactError`):
- `browser_session_start` (readOnly false): `{ project, profile_id, purpose (1..200), auth_mode? ("fresh_login"|"saved_state") }`, CLI `browser_session_start <project> <profile_id> <purpose> [auth_mode]`, alias `browser-start`.
- `browser_session_status` (readOnly true): `{ project, session_id }`, alias `browser-status`.
- `browser_session_close` (readOnly false): `{ project, session_id }`, alias `browser-close`.
`OP_HELP` entries added, `test/fixtures/help.txt` regenerated, "only N ops write" test now lists `browser_session_close` and `browser_session_start`.

**Audit events** (`browser_audit_events`; `actor` = `ctx.surface`, `correlation_id` = `ctx.correlationId`, background events get a fresh id; `data` is `redactDeep`'d, never holds a secret):
- `session_transition` (result `ok`/`failed`/`expired`): `data { from, to, reason?, cause? }`, one per transition (CREATED has `from` absent). Transitions to `CLOSED` use `session_closed` instead (`data.cause`: `close`, `idle_timeout`, `process_shutdown`, `profile_removed`; P1 uses the same event for removal).
  `cause` on FAILED/EXPIRED: `verification_failed`, `owner_gone`, `runtime_died`, `login_redirect`, or the error code.
- `tool_call`: result `ok` or `rejected`; `data { tool, code? }` (start also adds `profile_id`, `auth_mode`). Rejected calls with an unknown/other-project session carry `session_id` null.
- `state_save` (result `ok`): `data { storage_ref }` (opaque ref only).
- `origin_blocked` (result `blocked`): `data` = the adapter's blocked event `{ sessionId, url (origin+path), origin, kind }`.

**Notes for P5.** To act on a READY session: `manager = getSessionManager()` (from `src/browser/ops.js`), then
`await manager.withSession({ project, sessionId, tool: "browser_navigate", ctx }, async ({ runtime, session, profile, scope, expire }) => ...)`. It takes the per-session busy lock (a second caller gets `session_busy`
immediately; no queue), suspends the idle timer for the duration and re-arms it after, writes the `tool_call` audit row (ok or rejected with the thrown `code`) and refreshes `expires_at`. `runtime` is the adapter RuntimeSession
(`goto`, `url`, `screenshot`...); `profile` is the stored profile row (use `profile.definition.login.url_pattern`; never expose `definition`); `scope = { orgId, project, profileId }` for `writeEvidenceFile`;
`expire()` moves READY -> EXPIRED/`state_expired` and releases the runtime (call it on a login redirect or 401, then return the EXPIRED outcome). Guard blocks are already audited by the manager's `onBlocked` wiring (`origin_blocked` rows), so P5 should
only let the `origin_blocked` error propagate. Redaction boundary: every op handler goes through `guarded()` in `ops.js` (kill switch, `redactDeep` on output, `redactError` on errors); P5 handlers must use the same helper pattern
(export/reuse it) and pass the project `root_path` (`forbiddenRoots`) to `writeEvidenceFile` (read it with `getProject`). Session statuses other than READY give `session_not_ready`.
**Notes for P6.** `browser-login` runs in its own process and does not use the manager's sessions: build `const adapter = await getSessionManager().getAdapter()` (or `createPlaywrightAdapter()`), `createSession({ sessionId, allowedOrigins: profile.allowed_origins, headed: true, onBlocked })`,
let the human log in, vet with the same verify checks (`REQ-011`; copy `verify()` logic or export it), then `saveStorageState({ orgId, project, profileId }, await session.storageState(), { forbiddenRoots: [root_path] })` and call
`adapter.close()`. State is keyed by profile id and each profile has exactly one auth mode, so P6 saves under the id of a `saved_state` profile; a `fresh_login` profile with `save_state` saves under its own id and is not consumed by a different profile.
Write `state_save` audit rows with `ctx.surface = "cli"`. A headed run needs a display (`runtime_launch_failed` otherwise).

**Tests added:** `test/browser.sessionManager.test.js` (fake adapter, 34), `test/browser.sessionOps.test.js` (7), `test/browser.sessionManager.playwright.test.js` (real Chromium + local form-login fixture, 7; skips with a printed reason without Chromium).
`test/browser.adapter.playwright.test.js` leak test now only counts this process's child browsers (parallel files made it flaky).

### P5 — Navigate and screenshot ops (done)

**Operations** (`src/operations.js`, handlers `browserNavigateOp`/`browserCaptureScreenshotOp` in `src/browser/ops.js`; `surfaces: ["mcp","cli"]`, `readOnly: false`, kill switch via `guarded()`, results `redactDeep`, errors `redactError`; HTTP refuses them):
- `browser_navigate` input `{ project, session_id, url }` (CLI `browser_navigate <project> <session_id> <url>`, alias `browser-navigate`) -> `{ final_url, http_status, status: "READY" }`, or `{ final_url, http_status, status: "EXPIRED", reason: "state_expired" }` when the final URL is the profile's login page or the status is 401 (the manager's `expire()` is called: READY -> EXPIRED, runtime released, `session_transition` audit with `cause: "login_redirect"`).
- `browser_capture_screenshot` input `{ project, session_id, full_page? }` (CLI `browser_capture_screenshot <project> <session_id> [full_page]`, accepts `true`/`false`, alias `browser-screenshot`) -> `{ path, storage_ref, width, height, captured_at }`. Never image bytes. `full_page` default false (viewport, 1280x720 in Chromium); no other viewport option.
- Errors thrown (`.code`): `origin_blocked` (session stays READY; audited by P4's `onBlocked` wiring, plus a `tool_call` row with result `rejected`), `session_not_ready`, `session_busy`, `session_not_found` (other project), `session_not_in_this_process`, `browser_disabled`, `runtime_launch_failed` (navigation failure other than a block, e.g. an unreachable host). No new error codes or reasons.

**EXPIRED detection:** `status === 401` OR final URL on the login origin with pathname starting with `definition.login.url_pattern` (profile without a `login` block never detects by URL). Navigating deliberately to the login page also expires the session (spec REQ-014). Only navigate detects it; screenshot does not.

**Evidence layout:** `<BROWSER_STATE_DIR>/<org>/<project>/<profile>/evidence/<sessionId>/screenshot-<YYYY-MM-DDTHHMMSSZ>-<6 hex>.png` (file 0600, dirs 0700), via `writeEvidenceFile` with `forbiddenRoots: [project.root_path]`. One `browser_session_artifacts` row per shot: `artifact_type 'screenshot'`, `storage_ref 'screenshot:<org>/<project>/<profile>/evidence/<sessionId>/<name>'`. `path` is `resolveStorageRef(ref)`. Width/height are read from the PNG header.

**Changed shared code:** `withSession` callback now also gets `stateDir` and `rootPath`; adapter `RuntimeSession.screenshot({ fullPage? })` (fake records `["screenshot", opts]` in `calls`); Playwright `goto` waits for Chromium's chrome-error page to land after a block so the next navigation is not interrupted. `OP_HELP` entries and `help.txt` regenerated; writers list in `test/operations.test.js` now includes both ops.

**Tests:** `test/browser.navigateOps.test.js` (8), `test/browser.navigateOps.playwright.test.js` (1, skips without Chromium).

**Notes for P6:** nothing P5 changes affects `browser-login`; evidence/state share `BROWSER_STATE_DIR`. A session is only usable inside the process that started it, so the ops are meaningful over stdio MCP (the one-shot CLI closes the session at exit). Browser ops cover P1-P5; remaining browser verification for P6 needs a display.

### P6 — Human-only browser-login CLI (done)

**CLI:** `waycontext browser-login <project> <profile_id> [--timeout=<seconds>]` (default 600). A `case "browser-login"` in `src/cli.js` plus a `MANUAL_COMMANDS` entry (section `browser`); NOT in `src/operations.js`, so it is absent from MCP, HTTP and the ops catalogue (tested). Engine: `src/browser/loginCapture.js` `captureLogin({ project, profileId, adapter, waitForDone, timeoutMs?, stateDir?, orgId?, verifyWaitMs?, ctx })` -> `{ profile_id, storage_ref, verified: true, identity }`; `ctx.surface` defaults to `cli`. The CLI prints that JSON on stdout.

**Flow:** profile must exist, environment local/staging, `auth_mode` `saved_state` (a `fresh_login` profile -> `auth_mode_mismatch`, because state is keyed by profile id and consumed only by that profile's own mode). Opens `adapter.createSession({ headed: true, allowedOrigins: profile.allowed_origins, onBlocked, onClosed })` (adapter from `getSessionManager().getAdapter()`, closed by the CLI shutdown), goes to `login.url` (falls back to `base_url` if the profile has no `login` block), waits, runs REQ-011 via the now-exported `verifyAuthenticated(runtime, def, {waitMs})` (same function the session manager uses), then `saveStorageState({ orgId: currentOrgId(), project: name, profileId }, state, { forbiddenRoots: [root_path] })`. The tool never types or resolves a secret; the human does.

**Completion signal (settled):** the human presses Enter on the CLI's stdin (`promptForEnter`, prompt on stderr). The signal is the injected `waitForDone({ session })`, so tests use no TTY. No polling verification (it would navigate the human's page away). Bounded by `--timeout` (default 600s). Also ends the wait: stdin EOF/Ctrl-D (including already-closed stdin) -> `login_cancelled`; the human closing the browser window or a crash -> `login_cancelled`. A failed verification is final (no re-prompt): re-run the command.

**Exit codes / errors:** 0 success; 1 for any thrown error (existing CLI error path, message starts with the code). New `ERROR_CODES`: `verification_failed` (thrown; verification did not pass, nothing saved), `login_timeout`, `login_cancelled`. Others reused: `project_not_found`, `profile_not_found`, `environment_not_allowed`, `auth_mode_mismatch`, `origin_blocked` (login page redirected off allowlist), `invalid_state_dir`, `runtime_launch_failed` (no display), `runtime_unavailable`.

**Audit** (`browser_audit_events`, `actor` `cli`, one `correlation_id` per run, `session_id` null, data redacted): `manual_login_started` (`ok`, `{profile_id}`); `origin_blocked` (`blocked`, the adapter event) for any guarded navigation; `state_save` (`ok`, `{storage_ref}`) only after verification passed; `manual_login_finished` (`ok` `{profile_id}` or `failed` `{code}`); early rejections (profile missing, wrong mode, environment) write one `tool_call` row, result `rejected`, `data {tool:"browser_login", code}`.

**State written:** `storage_state:<org>/<project>/<profile>/storage-state.json` under `BROWSER_STATE_DIR`, file 0600, dir 0700, via P2 `saveStorageState`; nothing is saved on any failure path. No `browser_session_artifacts` row (no session row exists for a login capture). The next `saved_state` start for that profile loads it (verified end to end in-process in `test/browser.login.playwright.test.js`).

**Shared changes:** `verifyAuthenticated` exported from `src/browser/sessionManager.js` (manager behaviour unchanged); `test/fixtures/help.txt` regenerated. Tests: `test/browser.login.test.js` (15), `test/browser.login.playwright.test.js` (3, headed if DISPLAY/WAYLAND_DISPLAY works, else headless fallback printed, else skip). Suite: 1014 tests, 1013 pass, 0 fail, 1 skipped.

## Review fixes (2026-10-28)

Supersedes the matching statements in the phase sections above (those are kept as written).

- **Login-page rule (one function).** `isLoginPage(profileOrDef, url)` in `src/browser/profileSchema.js` is the only login-page test; `verifyAuthenticated` and `browser_navigate` both use it. It requires the url's origin to equal `login.url`'s origin and matches `login.url_pattern` on path-segment boundaries: pathname equal to the pattern or starting with `pattern + "/"` (a trailing slash on the pattern is ignored; `/login` never matches `/login-success`). Root decision: the default is still derived from `login.url`'s path, and the pattern `/` matches only the root path `/` itself (any query string), never every page. Behaviour change: verification no longer fails on a `/login` path of a *different* allowed origin.
- **Adapter `onClosed` reasons.** Now `"crashed"`, `"disconnected"` or `"page_closed"` (new). A main page closed by anything other than the adapter's own `close()` (the human closing the window or tab) is a death: `isAlive()` becomes false and `onClosed("page_closed")` fires; when the page closed because the browser went away it is reported as `"disconnected"`. The session manager maps every reason to `FAILED`/`runtime_lost`; `browser-login` maps every reason to `login_cancelled`. `close()` releases the shared browser exactly once, whether or not the session died first.
- **Redaction of cookie values.** Resolved secrets are still registered process-wide (>= 3 chars). Cookie values are registered only when `isSensitiveCookieValue(v)`: length >= 16, or length >= 8 mixing letters and digits (so `staging`, `admin`, `true`, `en-US` are never redacted). They go into a per-session scope, `createSensitiveScope() -> { add, addCookies, dispose }`, disposed when the session is torn down (`browser-login`: when the command ends); a value another scope or a secret still holds stays registered. `loadStorageState(scope, { baseDir, sensitive? })` registers into `sensitive` when given (the manager always passes its session scope), else process-wide with the same filter. `redact()` caches its longest-first order and rebuilds it only when the set changes.
- **`close()` on a row made terminal elsewhere** (e.g. `browser-profile remove` in another process): if this process still holds a live runtime entry for the session, it is torn down regardless of the row's status.
- **Profile removal deletes the saved state.** `removeProfile(project, profileId, { orgId?, ctx?, stateDir? })` deletes `storage-state.json` for that scope (`deleteSavedState`) after deleting the row; screenshot evidence is kept (nothing here says evidence goes with the profile). `profile_removed` audit data gains `saved_state_deleted: boolean`. A re-import of the same id reports `has_saved_state: false`.
- **Teardown during start.** If a teardown (profile removal hook, shutdown) runs while `start()` awaits the adapter or `createSession`, `start()` closes the runtime it then receives and returns the torn-down row's view (e.g. `CLOSED`); nothing is left running.
- **Timer limits.** `MAX_TIMER_MS = 2^31-1` (exported from `sessionManager.js`). The idle timer delay is clamped to it (the `expires_at` lease keeps the configured value). `browser-login --timeout` is validated: above `MAX_LOGIN_TIMEOUT_SECONDS` (2147483 s) the CLI exits 1 with `--timeout must be between 1 and 2147483 seconds`; `captureLogin({ timeoutMs })` throws the new `ERROR_CODES` entry `invalid_argument` before any browser opens.
- **Cross-host lease always exists (no migration).** `expires_at` is set at row creation to `now() + OWNER_LEASE_MS` (5 min; `createSessionManager({ ownerLeaseMs })` overrides it). While no idle lease applies (before READY, and for the whole session when the idle timeout is `0`), the owner refreshes it every `ownerLeaseMs / 3` with a heartbeat timer, stopped at teardown. With the idle timeout enabled, READY and each acquired call still set `now() + idle timeout`, as before. So a non-owner host can reclaim any live row whose owner stopped refreshing: lapsed lease => `FAILED`/`runtime_lost`. `expires_at` is therefore non-null on every row created after this change.
- **Cleanup.** `requireProject(name, orgId?) -> { project, orgId }` is exported once from `profileStore.js` and reused by the session manager and `browser-login`; `withSession` reuses the org id resolved by its lookup; the `secret_missing` and `invalid_secret_name` messages build the variable name with `browserSecretEnvName`.
