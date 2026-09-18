# Phase 1B-3 — plan

## Spec

Read `contracts.md` in full (all 11 prior phase sections + header). Read
spec.md L1404-1460 (AC-015/016/017/018/019) and L1462-1516 (§15 testing
requirements) directly. Everything this phase's slice references (the
`shortcode`/`block`/`block_manifest` entity shapes, `REGISTERED_AT`/
`RENDERED_BY`/`DEFINED_IN` relations, `resolution_status` enum,
`UI_IDENTITY_INCOMPLETE` diagnostic shape, the shared fixture) is already
defined in contracts.md — no missing dependency found.

## Locate

- `src/indexer.js`: grepped for `resolveHookGraph`/`resolveI18nGraph`/
  `resolveShortcodeGraph`/`resolveBlockGraph`/`resolveUiRelations`/
  `reconcileIdentity`/`identityPreflight` call sites to re-verify pipeline
  order fresh (1A-9/1B-1/1B-2 all warn line numbers/order drift — this time
  it matched contracts.md's documented order exactly: reconcileIdentity ->
  identity preflight -> resolveHookGraph -> resolveI18nGraph ->
  resolveShortcodeGraph -> resolveBlockGraph -> resolveUiRelations -> git
  history/docs/rules/derived).
- Grepped all of `src/` for `wp_posts`/`post_content`/`wpdb`/`mysqli` —
  zero real hits, only two comment lines in `src/indexer.js` explicitly
  stating no DB access exists. Confirms 1B-2's AC-017 claim fresh.
- Grepped `src/operations.js` + `src/ui/uiQueries.js` for `shortcode`/
  `block` (kind names) — zero hits outside `block_manifest`/`block_site`/
  `shortcode_site` (staging kinds). Confirms neither `shortcode` nor
  `block` is exposed to any MCP operation, so the REQ-010/Q-005 floor/
  weight tension (1A-9's own finding) doesn't apply to this phase's ACs.
- `git diff --stat -- src/parser.js`: empty. `git status --porcelain` does
  not list `src/parser.js`. Confirms it is genuinely untouched across the
  whole 12-phase feature (1A-3's original claim, re-verified fresh here as
  the closing phase).
- Read `test/uiIntelligence.acceptance.test.js` in full (754 lines):
  AC-015 (L474-501), AC-016 (L507-546), AC-017 (L548-576), AC-018
  (L582-655), AC-019 (L657-721), and the §15 `project_overview`/
  `get_callers`/`get_callees` regression (L727-754) are all already
  present, real-DB (no mocking), and non-tautological — each asserts
  specific `dst_id`/`data` values, not just "a row exists". Verified
  `test/parser.test.js:154-161` still matches the exact §15 regression
  name/line range.
- Confirmed all 11 prior phase directories under
  `docs/specs/ui-intelligence/context/phase-*/` have both `plan.md` and
  `review.md`.

## Plan

Given the existing AC-015/016/017 tests are real, DB-backed, and already
assert the specific facts each AC requires (not just existence checks),
and my own independent greps corroborate the two claims contracts.md asks
this phase to re-verify (no `wp_posts` access; pipeline order), the highest
-value use of this phase's Blast=1 budget is:

1. Run the full suite twice (stability check, 1A-9's own convention) and
   confirm 0 regressions.
2. Do NOT duplicate the existing AC-015/016/017 tests with a second,
   redundant scenario — 1B-1/1B-2 already wrote rigorous, real-DB tests
   for their own ACs in this exact file, and re-running them (which the
   full suite already does) satisfies "actually run it, don't just read
   and assume" from the phase brief. Writing a second near-identical test
   against the same shared fixture would add maintenance cost without
   adding verification value.
3. Perform the light-touch final sanity pass: `src/parser.js` diff check
   (done, see Locate), manifest/context directory skim (done), config-flag
   documentation consistency check (checked: neither `UI_ENABLED` nor
   `UI_I18N_LOCALE` nor any other Enabled flag is documented in README.md
   — a pre-existing, feature-wide non-gap, not something this feature
   introduced inconsistently, so not flagged as a closing observation).
4. Append the closing "## Phase 1B-3" section to `contracts.md`: AC-by-AC
   table, regression results, entity/relation kind inventory, final test
   count, "Increment 1A/1B complete" summary.
5. Update `manifest.md`'s 1B-3 row to `done`.
6. Write `review.md`.

No code changes are planned unless the full-suite run or an independent
check above surfaces a real discrepancy.

## Gate — risk re-check

Re-scoring the six dimensions after Locate, against what was actually
found (not the upfront spec-text-only score):

- Reversibility: 0 (unchanged) — no code changes are being made.
- Security surface: 0 (unchanged) — no new surface; the one prior
  filesystem-read surface (`writeUiBlockSites()`) was 1B-2's own scope,
  already mitigated and already reviewed by that phase's own Gate.
- Concurrency: 0 (unchanged) — nothing here touches locking/serialization.
- Blast radius: 1 (unchanged from upfront) — this phase can at most touch
  `contracts.md` (append-only), `manifest.md` (one status cell), and
  possibly one narrowly-scoped test/fixture fix if a real bug were found.
  None was found.
- New infra/dependencies: 0 (unchanged) — none introduced.
- Spec ambiguity: 0 (unchanged) — AC-015/016/017 and the two named §15
  regressions are concrete, and every open judgment call belonging to this
  slice was already resolved by 1A-9/1B-1/1B-2's own Gate/plan steps.

No dimension moved to "high" (or even changed at all) after Locate — the
codebase matched contracts.md's own documentation with no surprises this
time (unlike 1A-9, which found a real pipeline-order bug, or 1B-2, which
found a real filesystem-read security surface). Proceeding without
escalation.
