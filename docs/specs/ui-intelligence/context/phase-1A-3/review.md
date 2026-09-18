STATUS: DONE

## Gate re-check (post-Locate, pre-Code)

Upfront score: Rev/Sec/Con/Blast/Infra/Amb = 1/0/1/1/0/1 (total 4).

Re-scored after reading `src/parser.js:221-233`, `src/indexer.js`'s per-file
loop and edges-resolution block, `src/ui/phpWpPrimitives.js`, and the
`entities`/`entity_links` schema:

- **Reversibility (1, unchanged).** Additive-only: new kinds
  (`hook`, `hook_site`), new relations (`LISTENS_TO`, `FIRED_BY`), tombstone
  lifecycle throughout, no schema migration. Fully reversible by disabling
  `config.uiEnabled`.
- **Security (0, unchanged).** No new external input, no exec, no network.
- **Concurrency (1, unchanged — arguably lower than feared).** The upfront
  concern was project-wide cross-file resolution racing itself. Reading
  `indexProject()` shows a session-level `pg_advisory_lock` already
  serializes every `runIndex()` call for a given project, so this phase's
  post-pass runs with the same single-writer guarantee every other
  project-wide pass (edges resolution, `reconcileIdentity`) already relies
  on. No new concurrency primitive was needed.
- **Blast radius (1, unchanged).** Confirmed by test
  ("storage plane: only entities/entity_links are touched..."): writes are
  scoped to `kind IN ('hook','hook_site')` and
  `relation IN ('LISTENS_TO','FIRED_BY')`. `symbols`/`edges` and every other
  `ui_*` kind are untouched by this phase's code.
- **New infra (0, unchanged).** No new table, no new library.
- **Spec ambiguity (1, unchanged).** REQ-014 doesn't specify a `hook_site`
  staging mechanism, the `hook` entity's natural_key scheme, or the
  full-recompute-vs-incremental resolution strategy — these were resolved by
  the implementer and recorded in contracts.md, consistent with the
  "additive subsystem, implementer discretion, document the decision" pattern
  1A-1/1A-2 already established for comparable NOTE-[MISSING]-adjacent gaps
  (EDGE-009's dynamic-text handling, 1A-2's do_settings_sections() reading).

No dimension moved to "high." Proceeded to Code without escalating.

## What was verified

- `node --test test/ui.phpHooks.test.js test/indexer.uiHooks.test.js`: 10/10
  pass, covering:
  - REQ-014 unit-level extraction (add_action/add_filter/do_action/
    apply_filters recognized; add_shortcode/do_shortcode explicitly not).
  - REQ-026/Q-003: a dynamic (non-literal) hook name produces no entity at
    all; an unresolvable callback is recorded as `callback: null`, never
    fabricated.
  - EDGE-012 end-to-end: a hook fired in one file (`theme-template.php`),
    with a callback registered+defined in a second, different file
    (`woocommerce-cart.php`), resolves both `FIRED_BY` and `LISTENS_TO`
    against the correct `symbols.entity_id` in each of those two distinct
    files — this is the actual cross-plugin-boundary scenario REQ-014/
    EDGE-012 require.
  - REQ-026/Q-018 no-fabrication: a hook fired only by WordPress core (never
    indexed) gets zero `FIRED_BY` links, while its (in-project) `LISTENS_TO`
    side still resolves. No placeholder entity is ever created for the
    absent firer.
  - Storage plane: no `hook*`-kind rows land in `symbols`.
  - Tombstone/un-tombstone lifecycle across re-index.
- `node --test test/*.test.js`: full existing suite (668 tests) still
  passes — 1A-1/1A-2's tests (`ui.phpElements`, `ui.phpWpPrimitives`,
  `indexer.uiElements`, `indexer.uiWpPrimitives`) unaffected, confirming
  `src/parser.js`/`edges` and the existing `ui_*` write paths were genuinely
  left untouched.

## What wasn't verified

- No real multi-plugin WordPress fixture (per manifest.md's open item: "no
  WordPress fixture project exists in this repo"). The integration test's
  fixture is a synthetic 3-file layout modeling EDGE-012's shape, not a real
  WooCommerce/theme pair. 1A-9's hardening phase should re-run this against
  whatever real fixture it builds/borrows.
- Performance at scale: `resolveHookGraph()` recomputes the entire hook
  graph for the project on every `index_project` run (full delete +
  reinsert of `LISTENS_TO`/`FIRED_BY`), not incrementally. Not measured
  against a large real-world WP codebase (thousands of hook call sites).
  Flagged for 1A-9/whoever revisits performance, not fixed here — see
  contracts.md.
- `resolveCallable()`'s ambiguity behavior (skip when a method name matches
  more than one class project-wide) was reasoned about, not empirically
  measured against a real large OOP WP codebase's actual collision rate.

## Manifest

`docs/specs/ui-intelligence/manifest.md` phase `1A-3` row: `Status` updated
`pending` → `done`.

## Contracts

`docs/specs/ui-intelligence/contracts.md`: new dated "Phase 1A-3" section
appended (not editing any prior phase's section). Covers: `hook` entity data
shape, `hook_site` staging entity (internal-only, documented as such),
`LISTENS_TO`/`FIRED_BY` shapes and direction, the supersede-vs-additive
decision (edges/parser.js left untouched, "additive alongside" was chosen),
the project-wide post-pass's position in `runIndex()`, and what later
phases (1A-6 in particular, since its manifest row references `DEFINED_BY`/
`HANDLED_BY`/ownership classification that could plausibly touch hooks) need
to know.
