# Phase 10 plan — Hardening: idempotency, failure taxonomy, observability

## Scope (4 items from the brief)

1. **Q-008 reset-hook implementation** — new module
   `services/waydocs-ai/src/safety/fixtureReset.js`. Injectable
   `resetRunner(run) => Promise<void>`, defaulting to shelling out to a
   configured command (`options.command` / `WAYDOCS_AI_FIXTURE_RESET_CMD`
   env var, mirroring this package's existing `WAYDOCS_AI_*` config
   convention). `resetFixtures(runId, options)`:
   - success -> `updateRun(id, { fixturesReset: true, fixturesResetAt })`
     (exactly what Phase 3's `assertFixturesReset` precondition checks).
   - failure -> leaves `fixturesReset` false/absent, records
     `status: "failed", stage: "blocked", failureReason:
     "fixture_reset_failed"` (same blocked-reason vocabulary Phase 6
     already uses) + `lastFailure` (new observability field, item 4),
     rethrows `FixtureResetError`.

2. **Q-004 re-plan trigger** — new module
   `services/waydocs-ai/src/execution/replanTrigger.js`. `needsReplan(run)`
   checks `run.stage === "changed" && run.changed`. `triggerReplan(runId,
   options)` moves `stage: "changed" -> "planning"` (Phase 9's own
   `rejectedStage` value, so both "sent back for reason X" paths land on
   the same stage) and appends to a new additive `run.replanTriggers[]`
   audit trail (mirrors `run.approvals[]`). Does not itself call Phase 4's
   outline generator — building the actual AI re-plan pass is out of this
   module's reach (REQ-004 keeps planning judgment out of the
   deterministic layer); this only performs the mechanical stage
   transition + audit trail so something (an operator via CLI, or a future
   Maintenance-mode scheduler) has a real trigger to call.

3. **Outline-approval gap** — edit `src/execution/executor.js`: call
   `assertOutlineApproved(run)` (Phase 9, already exported) right after
   plan-schema validation, before the guardrails/credentials pre-flight
   checks. On failure: `status: "failed", stage: "blocked",
   failureReason: "outline_not_approved"`. Ordering choice: plan-schema
   validation still runs first (preserves the existing "invalid plan
   caught before guardrails" test unmodified), then outline-approval, then
   guardrails/credentials, then the browser. Requires updating
   `test/execution.executor.test.js`: every test that reaches past
   pre-flight (all except the invalid-plan test and the
   `verifyDesignatedAccount` unit test) needs a new `markOutlineApproved`
   helper (`updateRun(run.id, { stage: "approved" }, { runsDir })`) added
   to its setup, since none of them currently approve the run and would
   now fail one step earlier than intended.

4. **Failure taxonomy & observability** — new module
   `services/waydocs-ai/src/observability/failureTaxonomy.js`:
   `FAILURE_TAXONOMY` (lookup table of every `*Error` class across
   Phases 1/3/5/6/7/8/9/10), `classifyError(err)` (uniform shape, never
   throws), `buildFailurePatch(err)` (returns `{ lastFailure: {...} }` to
   spread into an existing `updateRun` patch). Wired into every failure
   branch of `executor.js` (the highest-traffic error site, and the one
   this phase is already editing) and `fixtureReset.js`. Deliberately
   *not* retrofitted into Phase 3/5/9's own modules (they don't call
   `updateRun` themselves — their errors are always caught and recorded by
   a caller, already executor.js for 3/5, or exist as their own
   `run.approvals[]`/`run.changed` structured record for 9/6) and *not* a
   new logging/metrics framework — §6.2.8/§15 explicitly decline to
   require one. Extends Phase 2's existing `run.history`/`updateRun`
   surface only, per the brief's explicit instruction.

## Explicitly not built (recorded, not silently dropped)

- Concurrency/locking (§6.2.4 NOTE MISSING: two runs against the same
  staging dataset). Not one of the 4 assigned items, no §19.1 resolution
  to anchor it to, would be speculative infra. Flagged in contracts.md as
  a remaining gap.
- EDGE-009 (non-WordPress / non-standard site support) — spec itself
  declines to establish behavior; nothing actionable for this phase.
- The outline -> `tutorial-plan.json` translation step (still open per
  Phase 9's note) — out of this phase's 4 assigned items.
- No new console/metrics logging framework (see item 4 above).

## Test files

- `test/safety.fixtureReset.test.js` (new)
- `test/execution.replanTrigger.test.js` (new)
- `test/execution.executor.test.js` (edited: new test + helper +
  `markOutlineApproved` added to existing tests' setup)
- `test/observability.failureTaxonomy.test.js` (new)
- Possibly small CLI additions (`reset-fixtures`, `replan` commands) with
  light coverage in `test/cli.test.js`, mirroring Phase 9's
  request-approval/approve/reject additions — time permitting, not
  required by the 4 items.

## Gate re-check (risk)

Upfront: Rev 1 / Sec 0 / Con 2 / Blast 1 / Infra 1 / Amb 2 = 7.
After Locate: no dimension moved to "high" that wasn't already:
- Security stays 0: the reset command is operator-set env var config,
  same trust boundary as existing `WAYDOCS_AI_*` vars (credentials,
  allowlist) — never derived from AI-authored plan content.
- Blast radius: editing `executor.js` (used by every run) is exactly what
  item 3 asks for and was pre-anticipated by Phase 9 (`assertOutlineApproved`
  exported specifically for this). Not a surprise.
- Concurrency stays 2, unaddressed (see "not built" above) — not made
  worse, just not solved.
No escalation.
