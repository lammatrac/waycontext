STATUS: DONE

## What was verified

- Full test suite: `npm test` → 695 tests, 695 pass, 0 fail (691 pre-existing
  + 4 new in `test/identity.preflight.test.js`).
- New tests exercise, against the real Postgres DB (no mocking):
  1. Already-complete project: preflight is a no-op, no diagnostic.
  2. Two legacy (pre-identity-plane) symbols across two files backfilled in
     one preflight call — asserts `backfillResult.files >= 2` and that the
     preflight's own log line appears exactly once (once-per-job, not
     per-file).
  3. A genuine `backfillProjectIdentity` failure (two symbol rows forced to
     share one pre-set `symbol_key`, triggering a real Postgres "ON CONFLICT
     DO UPDATE command cannot affect row a second time" error inside the
     backfill's entity-creation INSERT) — asserts `identityPreflight.complete
     === false`, the single `UI_IDENTITY_INCOMPLETE` diagnostic has exactly
     the five agreed keys with the agreed values, and `stats.failed === 0`
     (the overall `index_project` job still completes).
  4. `config.uiEnabled = false` → `identityPreflight` stays `null`, no
     backfill attempted even with unlinked symbols present in the DB.
- Storage/pipeline placement confirmed by reading `src/indexer.js` directly:
  the new call sits immediately after `reconcileIdentity()`, inside the
  existing per-project `pg_advisory_lock`, gated by `config.uiEnabled`,
  wrapped in its own try/catch — same additive-subsystem contract as
  `hooks`/`i18n`/`history`/`rules`.

## What wasn't verified

- No load/scale test against a large real-world project's identity backlog
  (matches 1A-3/1A-4's own precedent of not benchmarking against a large
  real WordPress codebase — flagged there for 1A-9, same caveat applies
  here: `backfillProjectIdentity` itself is unchanged, batching behavior is
  its own prior concern, not this phase's).
- 1A-6 (the actual consumer of `identityPreflight`) doesn't exist yet, so
  the handoff shape is verified only by direct test assertion on
  `stats.identityPreflight`, not by an end-to-end DEFINED_BY/HANDLED_BY
  `unresolved`-marking test — that's 1A-6's own phase to build and test.

## Risk

Re-scored after Locate/Plan: no dimension moved from the upfront score
(0/0/1/1/0/0). No escalation.

## Files changed

- `src/indexer.js` — new import (`identityBackfillStatus`,
  `backfillProjectIdentity`), new `identityPreflight` call site in
  `runIndex()` right after `reconcileIdentity()`, new field on the returned
  stats object, two new local functions
  (`identityIncompleteDiagnostic`, `runIdentityPreflight`).
- `test/identity.preflight.test.js` — new, 4 tests.
- `docs/specs/ui-intelligence/contracts.md` — new "Phase 1A-5" section
  appended; "Pending cross-phase decisions" list edited to remove the
  now-resolved `UI_IDENTITY_INCOMPLETE` bullet (the one shared-section edit
  explicitly permitted by the phase brief).
- `docs/specs/ui-intelligence/manifest.md` — 1A-5 row `Status`: `pending` →
  `done`.
- `docs/specs/ui-intelligence/context/phase-1A-5/plan.md` — new (written
  before Code, per process).
