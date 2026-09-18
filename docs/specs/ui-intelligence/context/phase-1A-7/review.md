STATUS: DONE

## What was verified

- `node --test test/ui.referenceResolver.test.js` — 17/17 passing:
  - Pure unit tests (no DB): `extractQueryFields` (free-text extraction,
    hint bypass per Q-009, hint-wins-over-text, no-guess-on-no-match),
    `canonicalElementType` (recognized synonym + unrecognized-hint
    passthrough), `textSimilarity` (exact/substring/token-overlap/no-match),
    `scoreCandidate` (full 4-signal weighted sum with evidence ordering,
    EDGE-006 zero-screens and multi-screen-max-route cases, zero-signal
    zero-score case).
  - Real-DB end-to-end tests (`resolveUiReference`, via a real
    `indexProject()` run over a tmp PHP fixture, no mocking): ranking +
    0.45 floor exclusion, MAX_CANDIDATES=5 cap, `text_source` passthrough
    for both `child_text` and `aria_label` tiers, unknown-project rejection,
    `config.uiEnabled=false` short-circuit before any query.
- Full suite: `npm test` → 729 passing (712 pre-existing + 17 new), 0
  failures, 0 skipped. Confirms no regression to any prior phase.
- Manual sanity check via `node -e` importing the module directly (see
  transcript) before writing the test file, to catch obvious extraction/
  scoring bugs early.

## What was NOT verified

- No load/scale test against a large `ui_element` table — the
  `CANDIDATE_POOL_LIMIT = 500` bound and its "results may omit relevant
  elements beyond this bound" log line are reasoned about, not measured
  against a real large WordPress codebase. Flagged the same way 1A-3/1A-6
  flagged their own unmeasured-at-scale concerns, for 1A-9 to pick up if it
  becomes a real hardening concern.
- No test exercises `resolveUiReference` against `ui_screen`/`ui_component`
  rows produced by 1A-2's `add_submenu_page` path specifically (only
  `add_menu_page` was used in the fixture) — the query code path is
  identical either way (it reads `ui_screen.data` uniformly), so this is a
  coverage gap in the *fixture*, not a known behavioral gap.
- 1A-8 (the actual MCP operation) doesn't exist yet, so there's no
  integration test of `resolve_ui_reference` end-to-end through the MCP
  surface — out of this phase's scope by the orchestrator's own boundary.

## Files changed

- `src/ui/referenceResolver.js` (new)
- `test/ui.referenceResolver.test.js` (new)
- `docs/specs/ui-intelligence/contracts.md` (appended "Phase 1A-7" section)
- `docs/specs/ui-intelligence/manifest.md` (1A-7 row status → done)
- `docs/specs/ui-intelligence/context/phase-1A-7/plan.md` (new)
- `docs/specs/ui-intelligence/context/phase-1A-7/review.md` (this file)

No existing file was modified (no `src/operations.js`, `src/indexer.js`, or
`src/config.js` changes — all explicitly out of this phase's scope, and none
were needed: `config.uiEnabled` already existed from 1A-1).
