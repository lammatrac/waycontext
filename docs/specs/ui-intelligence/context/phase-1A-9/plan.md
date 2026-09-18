# Phase 1A-9 plan — Increment 1A hardening/verification

## Spec slice references not already in contracts.md

None. Every entity kind, relation, MCP operation shape, and judgment call
this phase needed was already recorded across contracts.md's "Phase 1A-1"
through "Phase 1A-8" sections (all read in full before starting). No
missing-contract gaps found.

## Step 1 — Inspect the partial fixture (finish vs. rebuild decision)

`test/fixtures/wordpress-ui/` (six files, from a previous interrupted
dispatch) was read in full. Verdict: **finish, don't rebuild.** The six
files correctly, coherently cover AC-001/002/004/005/006/011 exactly as
their own doc comments claim (verified by reading each file's actual PHP,
not just its comment) — a `waycontext` plugin (menu screen + i18n-wrapped
submit_button + aria-label button + settings field with an onward call
chain), a second screen (`members-screen.php`) with duplicate visible text
for screen-scoped disambiguation, a `storefront` theme firing a hook a
*different* plugin (`cart-plugin`) registers the callback for, and a
`wp-includes/core-widgets.php` framework-owned control. Missing, per the
previous run's own last words: AC-003's `.po` catalog, and AC-012's
malformed-file trigger. Both added (see contracts.md "Phase 1A-9").

## Step 2 — Locate

Read (not just grepped) the full `resolveUiRelations()`/`runIndex()` body
in `src/indexer.js`, all five `src/ui/uiQueries.js` operations, and
`src/ui/referenceResolver.js`'s scoring/extraction functions, to verify
what 1A-1..1A-8 actually built rather than trusting contracts.md's prose
paraphrase for anything I was about to assert an AC against.

## Step 3 — Gate (risk re-check)

Manifest's upfront score: 0/0/0/1/1/0 (Blast=1, Infra=1), no checkpoint.
Re-scored after Locate + after finding and fixing two real bugs (below):
still 0/0/0/1/1/0. Neither fix introduces new infrastructure, touches
security-relevant code, or changes any public interface/contract — the
indexer.js fix reorders two existing, already-gated, already-try/catch-
wrapped internal calls (no behavior change for the common case: any file
reprocessed this run already has `entity_id` set before either call runs
regardless of order; only the identity-preflight-backfill-during-this-run
edge case changes, and only to now behave *correctly*), and the
referenceResolver.js fix adds one alternation to an already-existing,
already-documented-as-non-exhaustive regex table. Both are backed by the
full 765-test suite passing twice in a row with no other regressions. No
dimension moved to "high." Proceeded without escalating.

## Step 4 — Build out the fixture

- `wp-content/plugins/waycontext/languages/waycontext-vi.po`: textdomain
  `waycontext`, locale `vi`, `"Sync members" -> "Đồng bộ thành viên"` (AC-003).
- `wp-content/plugins/waycontext/includes/malformed.php`: ~4,000-deep
  nested `<div>` run inside literal PHP-emitted HTML (AC-012) — chosen only
  after an empirical probe showed the initially-tried "insanely long
  `.`-concatenation chain" crashes the shared base PHP parser too (not
  isolated to a UI adapter — see contracts.md for the full investigation),
  which would have falsely demonstrated the wrong thing.
- `members-screen.php`: changed its submenu slug from `waycontext-members`
  to `wc-members` — the original slug's shared prefix with the top-level
  `waycontext` slug defeated 1A-7's route-signal containment scoring for
  AC-005's own screen-hint disambiguation (both screens scored identically
  via substring containment). A fixture bug, not a system bug; see
  contracts.md.

## Step 5 — Write `test/uiIntelligence.acceptance.test.js`

One test per AC (001–014, 018, 019) plus the two named § 15 regressions,
real DB, real `indexProject()` runs, no mocking — same convention as every
prior phase's test file. Iterated against actual output rather than
predicted output throughout (see contracts.md "Phase 1A-9" for the AC-by-AC
table, including the two real bugs found this way: the identity-preflight/
hook-graph pipeline-ordering gap, and AC-007's "positioned" → `problem_type`
gap).

## Step 6 — Regression checks (§ 15)

- `test/parser.test.js:154-161` re-checked directly: no drift, still exact.
- `project_overview`/`get_callers`/`get_callees` run against the UI-graph-
  populated fixture project; output shape asserted unaffected (both
  functions only ever read `files`/`symbols`/`edges`, never
  `entities`/`entity_links` — verified by reading `src/graph.js`, then
  confirmed by running them for real).

## Step 7 — Full suite

765/765 passing (748 pre-existing + 17 new), run twice for stability.
