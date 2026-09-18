# Phase 3 plan — Staging / destructive-action safety guardrails

## Scope (this phase's spec slice)

REQ-014 (staging-only, fixture/seed data, no real customer data), REQ-015
(avoid destructive actions during exploration/recording), AC-007 (run must
not execute against a non-staging target/account), EDGE-002 (the "Delete
property" tutorial is a legitimate destructive workflow — REQ-015 must not
be a blanket ban), §10 Security, Q-003 (destructive-action enforcement +
prod detection — owned by this phase), Q-008 guardrail half (fixture/seed
reset is a *precondition* this phase enforces; the reset hook's
implementation is Phase 10's).

## Q-003 decision (adopting § 19.1's proposed resolution as-is)

Two independent mechanisms, both implemented as pure, synchronous
precondition/gate functions with no side effects — deliberately dependency-
free so Phase 6 (not yet built) can call them without needing to already
have Playwright, an approval store, or a reset-hook implementation wired
up:

1. **Staging-URL allowlist**, checked against every `goto` step's URL in
   the plan (not just a single "run target," since the run record's
   `target` field per Phase 2's contract is a free-text description of
   *what* to document, not a URL — the only URLs a plan actually visits
   are its `goto` steps). Hostname-based allowlist match (exact or
   `*.suffix` wildcard), sourced from an explicit `allowlist` array or the
   `WAYDOCS_AI_STAGING_ALLOWLIST` env var (comma-separated), mirroring
   `runStore.js`'s `WAYDOCS_AI_RUNS_DIR` convention. A URL that fails to
   parse, or that doesn't match any allowlist entry, is refused — fails
   closed, not open (no allowlist configured => nothing is staging =>
   nothing runs).

2. **Destructive-step permission gated on plan approval.** A step is
   classified "destructive" via a keyword pattern over its `target`/
   `value`/`narration` text (delete/remove/destroy/cancel/refund/publish/
   pay/charge/purchase/checkout/order — covers REQ-015's own examples plus
   EDGE-002's "Delete property"). A destructive step is only permitted to
   execute when the caller asserts `planApproved: true` — this phase does
   NOT read Phase 9's approval-gate stage string itself (Phase 9 doesn't
   exist yet, and hard-coding its stage vocabulary here would be exactly
   the kind of premature coupling CLAUDE.md's phase-implementer process
   warns against). Phase 6 is responsible for translating whatever Phase 9
   ships (a `run.stage === "approved"`-shaped check per Q-006) into this
   boolean at call time.

## Q-008 guardrail-precondition decision

This phase owns the *precondition check*, not the reset mechanism. A new
run-record field `fixturesReset` (boolean, absent/false by default) is
defined as part of this phase's contract — Phase 10's reset-hook
implementation is expected to call
`updateRun(id, { fixturesReset: true, fixturesResetAt: <ISO8601> })` after
a successful reset. This phase's gate function refuses to proceed unless
`run.fixturesReset === true`. This makes Q-008's "run-level repeatability,
not plan-level idempotency" promise checkable *before* Phase 6 drives a
browser, without this phase needing to know anything about how the reset
actually happens.

## Files

- `services/waydocs-ai/src/safety/guardrails.js` — new module: the gate
  functions described above (`isStagingUrl`, `assertStagingTarget`,
  `loadStagingAllowlist`, `isDestructiveStep`, `assertFixturesReset`,
  `assertStepPermitted`, `assertRunGuardrails`, `assertStepGuardrails`,
  `GuardrailViolation`).
- `services/waydocs-ai/test/safety.guardrails.test.js` — new tests,
  `node:test`, following the existing `orchestrator.runStore.test.js` /
  `tutorial.schema.test.js` conventions in this package.

No existing files need changes — this is a pure addition. No new
dependencies (staging-URL parsing uses `node:url`, already used by
`runStore.js`'s sibling modules elsewhere in this repo's convention).

## New contracts this phase produces (for `contracts.md`)

- Module path and full export list above.
- `GuardrailViolation` error shape (`.details`).
- New run-record field: `fixturesReset` (+ `fixturesResetAt`), extending
  Phase 2's run record via `updateRun`'s patch mechanism (no renames).
- Q-003 and Q-008(guardrail-half) resolutions as implemented (may deviate
  from § 19.1's exact wording in the same "mechanism not intent" style as
  Phase 1's Q-009 deviation — see below once implementation is final).
