STATUS: DONE

## What was verified

- Full test suite: `npm test` → 712 tests, 712 pass, 0 fail (695 pre-existing
  + 5 new in `test/ui.phpSettingsRender.test.js` + 12 new in
  `test/indexer.uiRelations.test.js`).
- Pipeline position confirmed by reading `src/indexer.js` directly (not
  trusted from any prior phase's note, per the phase brief's explicit
  instruction): `resolveUiRelations()` is called immediately after the
  `identityPreflight` block, inside the same per-project
  `pg_advisory_lock`, gated by `config.uiEnabled`, wrapped in its own
  try/catch, with every one of its 9 internal steps independently
  try/catch-wrapped via a `step()` helper (REQ-021).
- New end-to-end tests (`test/indexer.uiRelations.test.js`, real Postgres
  DB, no mocking), covering a fixture spanning 5 PHP files:
  1. `ui_component` materialization per `(source_path, owner)`, excluding
     `"@file"`.
  2. `RENDERS` (component→element) and `DEFINED_BY` (element/component→
     owning symbol's entity), including the target's `entity_id` matching
     the real `symbols` row.
  3. `CONTAINS` (screen→component) via the shared `RENDERED_BY`/`DEFINED_BY`
     target symbol — no name-string matching needed.
  4. `RENDERED_ON` (element→screen), flattened, with `resolution_status:
     "resolved"`.
  5. Cross-file `do_settings_sections()` completion: settings section/field
     registered in a different file than the one calling
     `do_settings_sections()` — `CONTAINS` resolves both at the
     `ui_component` level and flattened onto the `ui_screen`, plus
     section→field `CONTAINS`.
  6. `HANDLED_BY`, reusing 1A-3's already-resolved `LISTENS_TO` graph across
     a third file (`listener.php`) — confirmed the target is the correct
     real symbol entity, not a fabricated one.
  7. REQ-013 ownership classification: an element under `wp-includes/`
     classified `"framework"`, one under a plain path classified
     `"application"`.
  8. `unknown_render`: an element whose owner is never any screen's
     renderer gets no `RENDERED_ON` link and an explicit
     `render_status: "unknown_render"` — never a fabricated relation
     (REQ-026's spirit).
  9. **REQ-027 end-to-end**: a genuine (unmocked) `backfillProjectIdentity`
     failure — same symbol-key-collision technique
     `test/identity.preflight.test.js` uses — forced on the exact symbol a
     `ui_element`'s `DEFINED_BY` would target. Confirmed: the overall
     `index_project` job still completes (`failed: 0`), no `DEFINED_BY`/
     `RENDERED_ON` row is written (impossible anyway —
     `entity_links.dst_id` is `NOT NULL`), and the entity's own
     `data.defined_by_status`/`data.render_status` are both `"unresolved"`.
  10. Storage-plane isolation (`entities`/`entity_links` only).
  11. `config.uiEnabled = false` → `uiRelations` stays `null`, whole
      post-pass skipped.
  12. Full-recompute correctness: removing a hook's firing call site drops
      the corresponding `HANDLED_BY` link on the next index; restoring it
      brings the link back.
- New extractor unit tests (`test/ui.phpSettingsRender.test.js`, 5 tests, no
  DB): literal `$page` recognition, owner qualification (bare/`Class::method`/
  `@file`), and the no-fabrication rule for a dynamic `$page`.
- Two real SQL bugs caught and fixed during implementation (not present in
  the final code, noted here since they'd have silently broken the
  post-pass at runtime if unverified):
  1. `COUNT(DISTINCT x) OVER (PARTITION BY ...)` — PostgreSQL doesn't
     support `DISTINCT` inside a window function. Fixed by switching the two
     "unique match only" queries (`ui_component`→settings section/field via
     `settings_render_site`, and `ui_settings_section`→`ui_settings_field`)
     to a `GROUP BY` + plain aggregate, matching `resolveHookGraph()`'s own
     existing pattern for the same discipline.
  2. Several `pool.query()` calls passed a bound parameter (`project.org_id`)
     that the SQL text never referenced — Postgres/node-postgres rejects
     this with "could not determine data type of parameter $N" when
     preparing the statement. Fixed by dropping the unused parameter and
     renumbering placeholders. Caught by actually running the code against
     the real DB (a debug script + the test suite), not by inspection —
     this is exactly the kind of bug code review alone would likely have
     missed.

## What wasn't verified

- No load/scale test against a large real-world WordPress codebase (same
  caveat 1A-3/1A-4/1A-5 already flagged, carried forward for 1A-9): the
  recompute-in-full pattern for `ui_component`/`DEFINED_BY`/`HANDLED_BY`/
  `CONTAINS`/`RENDERS`/`RENDERED_ON` redoes the whole project's relevant SQL
  on every `index_project` run, not scoped to just the files that changed.
- 1A-7/1A-8 (the actual consumers of this graph) don't exist yet, so the
  handoff shapes (`ui_component`, `resolution_status` enum, `ownership`
  field) are verified only by direct assertion on the written rows, not by
  an end-to-end resolver/MCP-operation test.
- The `"partial"` value of the `resolution_status` enum is defined but has
  no writer in this phase (by design — Increment 1A's PHP-only scope never
  produces an ambiguous-but-still-written match) — untested because nothing
  produces it yet.
- Ownership classification's `vendor/` branch is effectively unreachable in
  practice (already excluded by `src/indexer.js`'s `DEFAULT_IGNORES` for the
  project glob walk) — not separately tested; `wp-includes/` is tested and
  covers the same code path.

## Risk

Gate re-check (see `plan.md` "Gate" section for full reasoning): no
dimension moved to "high" under closer inspection of the real code. The one
concrete surprise — 1A-2 never staged the cross-file `do_settings_sections()`
case, requiring a new sibling extractor + staging entity — was judged to
fall within the checkpoint's already-assumed shape (an established,
4-times-precedented pattern) rather than grounds to escalate. Proceeded
without escalating.

## Files changed

- `src/ui/phpSettingsRender.js` (new)
- `src/indexer.js` (import, per-file `writeUiSettingsRenderSites()` call +
  write function, `dropFile()` tombstone list, `resolveUiRelations()` +
  `identityIncompleteDiagnostic`-adjacent `OWNERSHIP_CASE_SQL` helper, new
  call site + `uiRelations` stats field)
- `test/ui.phpSettingsRender.test.js` (new)
- `test/indexer.uiRelations.test.js` (new)
- `docs/specs/ui-intelligence/contracts.md` (new dated "Phase 1A-6" section;
  "Pending cross-phase decisions" edited to mark EDGE-006 and
  `resolution_status` resolved)
- `docs/specs/ui-intelligence/manifest.md` (1A-6 row: `pending` → `done`)
- `docs/specs/ui-intelligence/context/phase-1A-6/plan.md`,
  `docs/specs/ui-intelligence/context/phase-1A-6/review.md` (this file)
