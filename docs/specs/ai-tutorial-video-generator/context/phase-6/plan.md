# Phase 6 plan — Playwright execution runner & recording

## Module
`services/waydocs-ai/src/execution/executor.js` (new), exporting:
- `ExecutionError` (Error subclass, `.details.reason`)
- `executeTutorialPlan(rawPlan, run, options)` — top-level orchestration
- `verifyDesignatedAccount(page, designatedAccount)` — AC-007 partial check, exported for unit testing

## Integration points (all read, none rewritten)
- Phase 1 `validateTutorialPlan` (schema.js) — called first, before anything else.
- Phase 3 `assertRunGuardrails`, `assertStagingTarget`, `assertStepPermitted`, `GuardrailViolation`
  (guardrails.js) — `assertRunGuardrails` once pre-flight; `assertStagingTarget` re-checked per
  `goto` step; `assertStepPermitted` per step.
- Phase 5 `resolveCredential`, `assertCredentialsResolvable`, `isCredentialStep`, `redactSecret`,
  `CredentialResolutionError` (credentialStore.js) — `assertCredentialsResolvable` pre-flight,
  `resolveCredential` at moment of use inside the `type` step handler only.
- Phase 2 `updateRun` (runStore.js) — status/stage transitions; run record never receives a
  resolved secret value.

## New dependency
`playwright` (^1.63.0) added to `services/waydocs-ai/package.json`. Chromium browser binary
already available via `~/.cache/ms-playwright` (installed during this phase, from the public
Playwright CDN — not a project-specific/live target).

## Q-004 decision (recorded fully in contracts.md)
Adopt §19.1's signal ("unresolvable target = changed"), but re-planning itself requires an AI
planning pass that does not exist inside this runner (REQ-004: AI plans, Playwright executes
deterministically — this module is pure execution). Concrete behavior: on a Playwright action
timeout locating a step's `target`/`url`, abort the run immediately (no skip, no blind
continuation), mark `run.stage = "changed"`, `run.status = "failed"`, and record
`run.changed = { stepIndex, action, target, reason: "target_unresolved" }` as the machine-readable
signal a later re-planning trigger (Maintenance mode / Phase 10) consumes.

## AC-007 designated-account gap
Implement an explicit, operator-configured check (`options.designatedAccount = {
checkAfterStepIndex, expectedText }`) since neither Phase 1's schema nor any earlier phase
carries an account-identity field or a "login completed here" marker — nothing to auto-detect
from. Runner checks page text after the configured step index; on mismatch, aborts before any
further (possibly destructive) steps run. Automatic, config-free detection remains open — no
schema-level signal exists to key it off. Recorded as: closed for operators who configure it,
open for the automatic case.

## Recording
Playwright's built-in tracing (`context.tracing.start/stop`, screenshots+snapshots,
`trace.zip`) and video (`context.newContext({ recordVideo: { dir } })`, `.webm`) — no bespoke
pipeline. Output under `services/waydocs-ai/.media/<runId>/` (new dir, gitignored), overridable
via `WAYDOCS_AI_MEDIA_DIR` env var (mirrors existing `WAYDOCS_AI_RUNS_DIR`/
`WAYDOCS_AI_STAGING_ALLOWLIST` convention). Paths recorded in the run's `recording` field, never
the video/trace content itself in the run JSON.

## Tests (TDD, real local fixture only)
`services/waydocs-ai/test/fixtures/loginFixtureServer.js` — a plain Node `http` server on
`127.0.0.1:0` (ephemeral), a login form + a `/dashboard` page, tracking the last submitted
username server-side for assertions. No network, no external URL, ever.

`services/waydocs-ai/test/execution.executor.test.js`:
1. Pre-flight (no browser launch): invalid plan, `fixturesReset` false, `goto` URL off
   allowlist, missing `credentialRef` env var — all reject before touching Playwright.
2. Destructive step without `planApproved` — real (local, headless) browser, rejects via
   `assertStepPermitted`.
3. Full success path against the fixture server: `goto` + `type` (literal) + `type`
   (`credentialRef`) + `click`, asserts fixture server's own recorded state (not just "no
   throw"), asserts video/trace files exist on disk, asserts the run JSON file never contains
   the raw secret.
4. Q-004: an unresolvable `click` target aborts (short `actionTimeoutMs`, no sleep), `run.stage
   === "changed"`, and the step after it never executes (checked via the fixture server).
5. AC-007: a configured `designatedAccount.expectedText` mismatch aborts before the following
   step runs.
6. Unit test for `verifyDesignatedAccount` against a duck-typed fake `page`.

## Risk gate re-check
No new dimension reads "high" beyond the phase's own upfront 10/12 score. Locate confirmed all
four consumed contracts exist and match what this phase needs; the only genuinely new
information is that Playwright browser binaries require a one-time download, which is a build/
CI concern, not a correctness/safety one, and already priced into "new infra: 2". Proceeding to
Code under TDD.
