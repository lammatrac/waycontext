STATUS: DONE

## Gate re-check (post-Locate, before Code)

Upfront risk: Reversibility 1 / Security 0 / Concurrency 2 / Blast radius 1 /
New infra 1 / Ambiguity 2 = 7, checkpoint: yes.

After reading the real code (`runStore.js`, `guardrails.js`, `executor.js`,
`approvalGate.js`), no dimension moved to "high" that wasn't already:

- **Security stays 0.** The new fixture-reset mechanism shells out to an
  operator-configured command (`WAYDOCS_AI_FIXTURE_RESET_CMD` env var / an
  explicit `options.command`) — the same trust boundary as every other
  `WAYDOCS_AI_*` env var this package already reads (credentials, staging
  allowlist). Never derived from AI-authored plan content.
- **Blast radius stays 1.** Editing `executor.js` (used by every run) is
  exactly what item 3 asked for, and Phase 9 pre-built
  `assertOutlineApproved` specifically for this purpose — not a surprise
  discovered during Locate.
- **Concurrency stays 2, still unaddressed** (see "Explicitly not built"
  below) — not made worse, just not solved by this phase.
- **Ambiguity**: the design choices below (check ordering, module
  boundaries, tie-break mechanism) close most of the ambiguity that scored
  this dimension; nothing forced a design decision outside this phase's
  own spec slice or contracts.md.

No dimension escalated. Proceeded to Code.

## What was built (see contracts.md's `## Phase 10` section for the full contract)

1. **Q-008 reset-hook implementation** — `src/safety/fixtureReset.js` +
   `test/safety.fixtureReset.test.js` (7 tests). `resetFixtures(runId,
   options)`: injectable `runner(run) => Promise<void>`, defaulting to
   shelling out to a configured command. Success sets `fixturesReset:
   true` + `fixturesResetAt`; failure leaves the flag false/absent,
   records `status: "failed", stage: "blocked", failureReason:
   "fixture_reset_failed"` + a structured `lastFailure` entry, and
   rethrows — verified against Phase 3's real, unmodified
   `assertFixturesReset` (the precondition still blocks on failure, stops
   blocking after a real success). Wired into `cli.js` as `waydocs-ai
   reset-fixtures <runId>`.

2. **Q-004 re-plan trigger** — `src/execution/replanTrigger.js` +
   `test/execution.replanTrigger.test.js` (5 tests). `needsReplan(run)` /
   `triggerReplan(runId, options)`: moves a `stage: "changed"` run to
   `"planning"` (Phase 9's own `rejectedStage` value, so every "start
   over" path in the system lands on the same stage) and appends to a new
   `run.replanTriggers[]` audit trail (mirrors `run.approvals[]`). Does
   NOT itself re-invoke Phase 4's outline generator or any AI planning
   pass — see contracts.md for why (REQ-004; deciding *what* to re-plan
   with is an orchestration decision this module has no information to
   make). Wired into `cli.js` as `waydocs-ai replan <runId> [--reason
   TEXT]`.

3. **Outline-approval gap closed** — `src/execution/executor.js` now
   calls Phase 9's `assertOutlineApproved(run)` right after plan-schema
   validation, before the guardrails/credentials pre-flight. On failure:
   `status: "failed", stage: "blocked", failureReason:
   "outline_not_approved"`. Required updating
   `test/execution.executor.test.js`: added a `markOutlineApproved`
   helper and applied it to every test that exercises past pre-flight
   (all except the invalid-plan test, which fails earlier by design, and
   the `verifyDesignatedAccount` unit test, which doesn't call
   `executeTutorialPlan` at all). One test
   ("refuses a destructive step that is not in an approved plan") needed
   an explicit `planApproved: false` override to keep testing Phase
   3/6's destructive-step gate in isolation, because Phase 6's
   `planApproved` default is already derived from the exact same
   `run.stage === "approved"` value the outline gate now also requires
   (Phase 9's own contract, not something introduced here) — once a run
   clears the outline gate, the *default* can no longer distinguish
   "outline approved" from "plan approved for destructive steps" (there
   is still no separate plan-approval gate in this system). Recorded in a
   comment in the test itself.

4. **Failure taxonomy & observability** —
   `src/observability/failureTaxonomy.js` +
   `test/observability.failureTaxonomy.test.js` (5 tests):
   `FAILURE_TAXONOMY` (every `*Error` class across Phases 1/3/5/6/7/8/9/10
   in one lookup table), `classifyError` (uniform, never-throwing
   classification), `buildFailurePatch` (an additive `{ lastFailure }`
   patch to spread into an existing `updateRun` call). Wired into every
   failure branch of `executor.js` (pre-flight invalid-plan,
   outline-not-approved, guardrail/credential pre-flight, and the
   terminal generic-error branch) and into `fixtureReset.js`'s failure
   path. Deliberately NOT wired into the `"changed"` (Q-004) branch of
   `executor.js` — that branch already has its own dedicated structured
   `run.changed` field, and duplicating it into `lastFailure` would be
   redundant. Deliberately NOT retrofitted into Phase 3/5/9's own modules
   — none of them call `updateRun` themselves (their errors are always
   caught by a caller — `executor.js`, for 3/5 — or already have their own
   durable record, `run.approvals[]`, for 9). No new logging/metrics
   framework was built — §6.2.8/§15 explicitly decline to require one;
   this only extends Phase 2's existing `run.history`/`updateRun`
   surface, per the brief's explicit instruction.

## Explicitly deferred / not built (recorded, not silently dropped)

- **Concurrency / locking** (§6.2.4 NOTE MISSING — two runs against the
  same staging dataset). Not one of the 4 assigned items, no §19.1
  resolution to anchor a design to, would be speculative infra beyond
  this phase's scope. Flagged in contracts.md as a still-open gap for
  whoever builds real multi-run scheduling.
- **EDGE-009** (non-WordPress / non-standard site support) — the spec
  itself declines to establish behavior here (`NOTE [MISSING]`, no §19.1
  resolution at all). Nothing actionable for this phase; noted in
  contracts.md, no code change.
- **The outline -> `tutorial-plan.json` translation step** (flagged open
  by Phase 9) — not one of this phase's 4 items; still open.
- No new console/metrics/tracing framework (see item 4 above) — an
  in-phase decision, not an oversight.

## Bonus fix: the pre-existing flaky `runStore.js` test

Fixed. Root cause: `listRuns`'s sort compared `createdAt` (millisecond
ISO8601 string) only — two `triggerRun` calls landing in the same
millisecond sorted with unspecified relative order (`Array.prototype.sort`
on an equal comparator result). Added a same-process monotonic sequence
counter (`_createdSeq`, assigned at `triggerRun` time) used purely as a
`listRuns` tie-breaker; `createdAt` remains the primary sort key. Added a
new deterministic reproduction test
(`test/orchestrator.runStore.test.js`, "listRuns tie-breaks runs created
within the same millisecond...") that freezes `Date` so the tie is
guaranteed every run, rather than relying on real-clock timing (which is
itself why the original bug was flaky to catch). Verified RED before the
fix, GREEN after, and ran the full package suite 3x in a row with no
failures (178/178 each time) to confirm stability. This does **not** make
cross-process run ordering fully monotonic (the counter resets per Node
process) — that remains an accepted limitation of this placeholder
file-backed store (Phase 2's contract already flags "whether this becomes
a real DB/queue" as Phase 10's territory; a full fix would require a
persisted, cross-process sequence, which is a bigger change than fixing
this specific test's flakiness warrants).

## Verification

- `npm test` in `services/waydocs-ai`: **178/178 passing**, run 3
  consecutive times with no failures (was 154/154 at the end of Phase 9).
  +24 new tests: `safety.fixtureReset.test.js` (8),
  `execution.replanTrigger.test.js` (5),
  `observability.failureTaxonomy.test.js` (5), `cli.hardening.test.js`
  (4), plus one new test each in `execution.executor.test.js` (now 10)
  and `orchestrator.runStore.test.js` (now 10, the flaky-fix
  reproduction).
- Every new/changed module followed RED-GREEN TDD: each new test file
  (`safety.fixtureReset.test.js`, `execution.replanTrigger.test.js`,
  `observability.failureTaxonomy.test.js`, `cli.hardening.test.js`) was
  run against the not-yet-existing module and confirmed to fail with
  `ERR_MODULE_NOT_FOUND` before implementation; the new
  `executor.js`/`orchestrator.runStore.test.js` tests were run and
  confirmed to fail for the *expected* reason (wrong error type /
  assertion mismatch, not a typo) before their corresponding source
  changes.
- Re-ran the full existing test suite (not just this phase's new tests)
  after every source change touching a shared module (`executor.js`,
  `runStore.js`) — see the multiple `npm test`/targeted-file runs in this
  session.

## Browser verification

Skipped, explicitly. This phase added two new CLI commands
(`reset-fixtures`, `replan`) to the existing CLI-only trigger interface —
same pattern as every prior phase's CLI additions (Phase 2's
`run`/`status`/`list`, Phase 9's `request-approval`/`approve`/`reject`),
not a new browser-observable surface. The `executor.js` edit is a guard
addition (per the task brief's own note that this doesn't require new
browser verification), not a new UI/HTTP surface. There is still no HTTP
endpoint or web UI anywhere in this service. Verified instead via the
real CLI subprocess tests in `test/cli.hardening.test.js`
(`execFileSync` against the actual compiled CLI, not a mock, including a
real shell command via `WAYDOCS_AI_FIXTURE_RESET_CMD=true`/`false`).

## Final-phase notes

This was Phase 10 of 10 — the last phase of this spec. Per the
orchestrating agent's explicit instruction, **no merge into `main` was
performed** — the branch `feature/ai-tutorial-video-generator` and the
worktree `.worktrees/ai-tutorial-video-generator` are left exactly as
they are, fully committed, for a human to review and merge themselves.
