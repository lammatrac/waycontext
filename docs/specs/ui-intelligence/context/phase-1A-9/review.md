STATUS: DONE

## What was verified

Every AC-001 through AC-014, plus AC-018 and AC-019, exercised as real,
running tests (`test/uiIntelligence.acceptance.test.js`, 17 tests) against
a real Postgres-backed `indexProject()` run — no mocking, matching the
convention every prior UI-intelligence phase's test file used. Both named
§ 15 regressions (`test/parser.test.js:154-161`;
`project_overview`/`get_callers`/`get_callees` output shape) re-verified
directly.

Full AC-by-AC results, the two real bugs found and fixed, and one real,
documented (not fixed) spec-level tension are recorded in `contracts.md`
"Phase 1A-9" — not restated here.

## What wasn't verified

- AC-015, AC-016, AC-017 (shortcodes/blocks/`data_owned`) — explicitly out
  of this phase's scope, reserved for 1B-3.
- No load/scale testing against a large real-world WordPress codebase (the
  500-row candidate-pool cap noted by 1A-7, the full-recompute cost of
  `resolveHookGraph()`/`resolveI18nGraph()`/`resolveUiRelations()` noted by
  1A-3/1A-6) — out of this hardening phase's scope, already flagged as
  unmeasured by the phases that introduced them.
- Authorization — still unaddressed everywhere in `src/operations.js`, not
  just the five UI operations (1A-8's own note, unchanged by this phase).

## Verification commands run

```
node --test test/uiIntelligence.acceptance.test.js   # 17/17 passing
node --test test/*.test.js                            # 765/765 passing (run twice for stability)
```

No leftover test-project rows or scratch files left in the database or
working tree (`git status` clean except the intended file changes below).

## Gate re-check outcome

Manifest's upfront score (0/0/0/1/1/0, no checkpoint) was re-scored after
Locate and again after finding/fixing both bugs below. No dimension moved
to "high." Not escalated. Full reasoning in `plan.md`.

## Files changed

- `src/indexer.js` — moved `resolveHookGraph()`/`resolveI18nGraph()` to run
  after the identity preflight instead of before it (fixes AC-018: a
  same-run `backfillProjectIdentity()` success previously couldn't be
  reflected in that run's own `LISTENS_TO`/`FIRED_BY`/`HANDLED_BY`, only on
  the next run). No interface change; no new config.
- `src/ui/referenceResolver.js` — added `\bposition(?:ed|ing)?\b` to
  `PROBLEM_TYPE_PATTERNS`'s `styling` pattern (fixes AC-007: the spec's own
  worked task text extracted `problem_type: null` before this).
- `test/fixtures/wordpress-ui/` — finished (added
  `wp-content/plugins/waycontext/languages/waycontext-vi.po` for AC-003,
  `wp-content/plugins/waycontext/includes/malformed.php` for AC-012; fixed
  `members-screen.php`'s submenu slug `waycontext-members` → `wc-members`,
  a fixture-only change).
- `test/uiIntelligence.acceptance.test.js` — new, 17 tests.
- `docs/specs/ui-intelligence/contracts.md` — appended "Phase 1A-9" section
  (mandatory); resolved the "WordPress fixture project" pending
  cross-phase decision.
- `docs/specs/ui-intelligence/manifest.md` — 1A-9 row `Status` → `done`;
  resolved the WordPress-fixture open item note.

## Contracts added

None new (no new entity kind, relation, or MCP operation — this was a
verification/hardening phase). Two corrections to existing contracts
(pipeline call order in `runIndex()`; the fixture project's final
path/approach) recorded in `contracts.md` "Phase 1A-9" → "What 1B-1 needs
to know".
