STATUS: DONE

## Gate re-check (step 4)

Upfront score: Reversibility 2 / Security 2 / Concurrency 1 / Blast radius 1
/ New infra 1 / Ambiguity 2 — total 9, checkpoint: yes.

After Locate (reading Phase 1's `schema.js` and Phase 2's `runStore.js` /
`cli.js` / package layout): nothing surfaced that the spec text didn't
already show. This is a pure, new, dependency-free module (`node:url`
only, no new package deps) with no coupling to Playwright, an approval
store, or any external service — Phase 6/9's absence doesn't create a
hidden dependency because this module deliberately takes booleans
(`planApproved`) and plain objects (`run`, `plan`) rather than reaching
into those phases' stores itself. No dimension reads higher than the
upfront pass. Proceeding without escalation.

One thing worth flagging (not an escalation, just a scoping note, also in
contracts.md): AC-007 also mentions the run being blocked when "an account
that is not the designated test account" is used, but Phase 1's schema
has no account/identity field on a plan (only `credentialRef`, a secret
*name*, on `type` steps). This phase can only implement the URL side of
AC-007. Account-identity verification would need either a schema
extension (Phase 1's territory) or fold into Phase 5's credential-store
design (e.g. the store itself only knows about designated test
accounts) — flagged in contracts.md for whichever phase picks it up.

## TDD

Followed strict red-green-refactor via `superpowers:test-driven-development`.
Built the module incrementally in 5 batches, each with its own
red-then-green cycle, confirmed by running `node --test
test/safety.guardrails.test.js` after every RED and every GREEN step (not
just at the end):

1. `isStagingUrl` / `assertStagingTarget` (allowlist match, wildcard,
   fails-closed on empty allowlist, unparseable URL, AC-007 throw).
2. `loadStagingAllowlist` (explicit array vs. `WAYDOCS_AI_STAGING_ALLOWLIST`
   env var vs. unset).
3. `isDestructiveStep` (delete/publish/payment keyword heuristic, positive
   and negative cases including EDGE-002's "Delete property").
4. `assertFixturesReset` / `assertStepPermitted` (Q-008 precondition;
   Q-003 mechanism 2, including the EDGE-002 approved-vs-unapproved case).
5. `assertRunGuardrails` (the composed run-start gate: fixtures-reset +
   every `goto` step's URL against the allowlist).

Every RED was verified to fail for the expected reason (missing export /
`ERR_MODULE_NOT_FOUND` or an unmet assertion), never a typo. Final run:
`npm test` in `services/waydocs-ai` — **50/50 passing** (26 pre-existing
Phase 1/2 tests + 24 new guardrail tests), no other test touched or
modified.

## Browser verification

**Skipped, explicitly.** This phase is a policy/guardrail module
(`services/waydocs-ai/src/safety/guardrails.js`) — pure synchronous
functions with no HTTP endpoint, CLI command, or UI of its own. There is
nothing browser-observable to exercise; Phase 6 (the Playwright runner
that will actually call these gates against a live browser session)
doesn't exist yet. Verified via the automated test suite only.

## What this phase did NOT do (left for later phases, as scoped)

- Does not read Phase 9's approval-gate `stage` string itself (Phase 9 not
  built) — takes an explicit `planApproved` boolean; Phase 6 is
  responsible for deriving that boolean from whatever Phase 9 ships.
- Does not implement the fixture/seed reset hook itself (Phase 10) — only
  the precondition check that a reset already happened.
- Does not verify "designated test account" identity (see Gate re-check
  note above) — only the staging-URL half of AC-007.
- Does not wire `assertRunGuardrails` / `assertStepPermitted` into an
  actual runner — Phase 6's job, per the phase description.

## Files

- `services/waydocs-ai/src/safety/guardrails.js` (new)
- `services/waydocs-ai/test/safety.guardrails.test.js` (new, 24 tests)
