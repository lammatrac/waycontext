# Phase 5 plan — Credential handling & secrets resolution

## Spec slice recap

- Q-009 (L878-886, L964-969): `tutorial-plan.json` references a credential
  by name/env-var only, never a literal value (Phase 1 already built this:
  `type` step's `credentialRef`, mutually exclusive with `value`). This
  phase resolves that *name* to an actual secret *value* at execution
  time, from an env-var-backed secrets store (§19.1 default, adopted).
  Video-masking of the typed keystrokes is explicitly Phase 8's job, not
  this phase's.
- §10 Security (L598-609): three `NOTE [MISSING]` items — credential
  supply/storage/exposure (Q-009, this phase's job), video content
  exposure (Phase 8's job), and third-party LLM/TTS trust boundary
  (Phase 7's job). Only the first is in scope here.
- §6.2.6 L403: "Authentication with a test account... Credential handling
  unspecified — see Q-009." Confirms the credential is used for
  authenticating as a designated test account (ties to REQ-001).
- REQ-001 (L110-116): system input includes "a staging URL, a test
  account, and a natural-language request." Confirms test-account
  credentials are a first-class input, supplied by the operator, not
  invented by the AI pipeline.

## Contracts already committed (binding)

- Phase 1: `type` step schema — `credentialRef: z.string().optional()`,
  mutually exclusive with `value`, enforced via `superRefine`. No format
  constraint on the string itself at schema level — this phase is free to
  impose its own format/namespacing rule at resolution time without
  reopening Phase 1's schema.
- Phase 2: env-var config convention already established —
  `WAYDOCS_AI_RUNS_DIR`. Phase 3 continued it — `WAYDOCS_AI_STAGING_ALLOWLIST`.
  This phase follows the same convention: `WAYDOCS_AI_CREDENTIAL_<REF>`.
- Phase 3 (`services/waydocs-ai/src/safety/guardrails.js`): `GuardrailViolation`
  error-subclass-with-`.details` pattern is the established convention for
  this package's precondition/gate errors — this phase's
  `CredentialResolutionError` follows the same shape.
- Phase 3's "Known gap" note: AC-007's "designated test account" half is
  unimplemented; contracts.md speculates Phase 5 might close it. Decision
  (recorded below): **not closing it in this phase** — see "Explicitly out
  of scope" below for reasoning.

## Design

**Module:** `services/waydocs-ai/src/secrets/credentialStore.js` (new
directory, same package/convention as `safety/`, `outline/`,
`orchestrator/`).

**Mechanism:** env-var-backed secrets store, adopting §19.1's default
substance. Namespaced under a fixed prefix so a `credentialRef` can never
resolve to an arbitrary, unrelated environment variable (e.g. `PATH`,
`AWS_SECRET_ACCESS_KEY`) — only variables an operator explicitly created
under this prefix are reachable at all. This is the phase's one real
security-relevant design decision, beyond just "read `process.env`."

```js
export class CredentialResolutionError extends Error { /* .details */ }

export const CREDENTIAL_ENV_PREFIX = "WAYDOCS_AI_CREDENTIAL_";

export function isValidCredentialRef(ref) // ^[A-Z][A-Z0-9_]*$
export function credentialEnvVarName(credentialRef) // prefix + ref, throws if invalid ref format
export function createEnvCredentialStore(env = process.env) // { get(credentialRef) => string|undefined }
export function resolveCredential(credentialRef, { store = defaultEnvStore } = {}) // => string; throws CredentialResolutionError, never includes a value in error details
export function isCredentialStep(step) // step.action === "type" && typeof step.credentialRef === "string" -- convenience for Phase 6/8, mirrors guardrails.js's isDestructiveStep
export function assertCredentialsResolvable(plan, { store } = {}) // fail-fast precondition: every type-step credentialRef in the plan resolves; throws listing missing REF NAMES only, never values
export function redactSecret(text, secretValue) // defense-in-depth scrub helper for logs/narration text
```

**No-logging guarantee (the property Phase 6/8 depend on):**
- `resolveCredential`/`assertCredentialsResolvable` never call
  `console.*` or write to any file themselves.
- Every thrown error's `.details` carries only *names* (`credentialRef`,
  the derived `envVarName`) — both already non-secret (the ref is
  committed in `tutorial-plan.json` in Git; the env var name is derived
  deterministically from it) — never the resolved value, including on the
  "not found" path (nothing to leak; the point of failure is absence).
- The module exposes no way to enumerate or dump the whole credential
  store — no `listCredentials()`-style export — only look-up-by-name.
- `redactSecret` is provided so callers (Phase 6's step-execution
  logging, Phase 7's narration-generation prompt assembly) can scrub a
  known resolved value out of arbitrary text before it's logged, stored
  in a run record, or sent to an LLM — but enforcement of *calling* it at
  the right place is a caller responsibility this module cannot itself
  guarantee across process boundaries; documented as such in contracts.md.

**Explicitly out of scope (flagged, not silently dropped):**
- AC-007's "designated test account" identity check (Phase 3's known
  gap). Closing it needs *runtime* verification that the account actually
  authenticated during a live browser session matches the intended test
  account — that requires observing the browser/session state, which only
  Phase 6 (the actual runner) can do. This phase can resolve a name to a
  value and confirm the value *exists*, but cannot itself confirm what
  account a resolved credential logs into at runtime. Editing Phase 3's
  already-`done` `guardrails.js` to add an assertion this phase can't
  actually satisfy would be scope creep without closing the real gap.
  Recorded as still-open in contracts.md, owner reassigned to Phase 6.
- `.env` file loading. CLAUDE.md's secrets policy allows reading
  credentials from a project's `.env` when needed, and Node 20 (this
  package's declared `engines` floor) has built-in `--env-file` support —
  so local/dev use of a `.env` is already possible without this module
  doing any custom parsing. Building a bespoke loader here would be
  unrequested new infra for something the runtime already provides.
- Any real external secrets manager (Vault, AWS Secrets Manager, etc.).
  The `store` injection point in `resolveCredential`/
  `assertCredentialsResolvable` exists specifically so a later phase can
  swap in a different backend without changing the call signature Phase 6
  depends on — but building one is not this phase's job (§19.1's default
  is env-var-backed; nothing in this phase's spec slice asks for more).
- Any Phase 6 runner integration, Phase 8 masking/timing metadata. This
  phase only builds the resolution primitive; wiring it into step
  execution and recording is those phases' job.

## Files

- `services/waydocs-ai/src/secrets/credentialStore.js` (new)
- `services/waydocs-ai/test/secrets.credentialStore.test.js` (new)
- `docs/specs/ai-tutorial-video-generator/contracts.md` (append `## Phase 5`)

## Test plan (fake/dummy values only)

- `isValidCredentialRef`: accepts `TEST_ACCOUNT_PASSWORD`; rejects
  lowercase, empty, leading digit, non-identifier chars.
- `credentialEnvVarName`: prefixes correctly; throws `CredentialResolutionError`
  on an invalid ref.
- `createEnvCredentialStore` + `resolveCredential`: resolves a value from
  an injected fake env object (never real `process.env` in tests);
  throws with reason `credential_not_found` when unset/empty; throws with
  reason `invalid_credential_ref` on bad ref shape; confirms thrown
  error's `.details`/`.message` never contain the dummy secret value in
  the not-found path (nothing to contain) and, in a resolved-then-errored
  scenario elsewhere, is never included.
- `isCredentialStep`: true for a `type` step with `credentialRef` set,
  false for `value`-only `type`/`goto`/`click`.
- `assertCredentialsResolvable`: passes when every `credentialRef` in a
  fake plan resolves via a fake store; throws listing missing ref *names*
  (asserted not to contain any dummy value) when one is missing; passes
  trivially on a plan with no credentialRef steps.
- `redactSecret`: replaces all occurrences of a dummy secret in a string
  with a placeholder; no-op on empty/undefined secret; confirms original
  dummy value is absent from the output string.
