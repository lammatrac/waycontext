STATUS: DONE

## What was verified

- `node --check` on both changed/new source files: clean.
- `test/ui.phpElements.test.js` (1A-1's existing unit tests, 12) — unchanged,
  all pass. Confirms this phase did not regress 1A-1.
- `test/indexer.uiElements.test.js` (1A-1's existing live-DB integration
  tests, 3) — unchanged, all pass. Confirms `writeUiElements()`'s tombstone
  lifecycle and the `ui.enabled` gate still work after this phase's edits to
  its call site in `src/indexer.js`.
- `test/ui.phpWpPrimitives.test.js` (new, 12 unit tests, pure/DB-free) —
  covers REQ-016 (submit_button literal/default/i18n/dynamic-text/other_attributes
  cases), REQ-017 (add_menu_page, add_submenu_page with `array($this, ...)`
  renderer resolution, an unresolvable-renderer case), REQ-018
  (add_settings_section/add_settings_field extraction incl. `label_for`,
  omitted-`$section`-defaults-to-`"default"`, `do_settings_sections()`
  same-file/same-page correlation, and the no-in-file-match case). All pass.
- `test/indexer.uiWpPrimitives.test.js` (new, 2 live-DB integration tests) —
  a full `indexProject()` run over a realistic WP admin-class fixture
  (`add_menu_page` + `add_settings_section` + `add_settings_field` +
  `do_settings_sections` + `submit_button`, all inside one class using
  `array($this, 'method')` callbacks) asserts: correct `ui_screen`/
  `ui_settings_section`/`ui_settings_field` entity rows and `data` shapes;
  `REGISTERED_AT`/`RENDERED_BY` `entity_links` rows actually resolve for the
  in-file case; `submit_button()` lands as a `ui_element` with
  `extraction: "wp_primitive"`; storage plane confirmed
  (`symbols`/`edges` untouched by this phase); and a second test confirms
  removing a settings field from the file tombstones only that entity while
  the screen/section stay live. Both pass.
- Full suite: `npm test` (`node --test test/*.test.js`) — **658/658 pass**,
  0 failures. This is the whole repo's test suite, not just this phase's
  files, run to catch any unintended interaction (e.g. with `dropFile()`'s
  changed tombstone query, which is shared code touched by this phase).

## What wasn't verified

- No WordPress fixture project exists in this repo for a full
  `index_project` MCP-tool-level run (same gap the manifest already notes
  for 1A-9); verification here is at the `indexProject()` function level
  with an in-repo tmp-dir fixture, same depth as 1A-1's own tests.
- Cross-file `REGISTERED_AT`/`RENDERED_BY` resolution is explicitly out of
  this phase's scope (Q-003 bound, deferred to 1A-6/1A-7) — not tested here
  because it isn't this phase's job; a `null` `renderer`/`callback` in that
  case is the expected, verified behavior, not a bug.
- No performance/scale testing (large WP admin files, deeply nested
  classes) — extraction is a single linear AST walk per file, same
  complexity class as 1A-1's, not expected to be a concern.

## Gate

Re-scored after Locate/Plan against the actual codebase — see
`plan.md`'s "Gate re-check" section. No dimension moved to "high" (the one
genuine ambiguity found, `do_settings_sections()`'s exact contribution, was
explicitly anticipated by the phase brief and resolved conservatively, not
escalation-worthy). No escalation.

## Files changed

- `src/ui/phpWpPrimitives.js` (new) — pure/DB-free extractor for
  `submit_button`/`add_menu_page`/`add_submenu_page`/`add_settings_section`/
  `add_settings_field`/`do_settings_sections`.
- `src/indexer.js` (edited) — import, per-file wiring (merges `submit_button`
  output into the existing `writeUiElements()` call, adds a new
  `writeUiWpPrimitives()` function and its call), `dropFile()`'s tombstone
  `kind IN (...)` list extended to the three new kinds.
- `test/ui.phpWpPrimitives.test.js` (new) — 12 unit tests.
- `test/indexer.uiWpPrimitives.test.js` (new) — 2 live-DB integration tests.
- `docs/specs/ui-intelligence/contracts.md` (appended, new dated section
  "Phase 1A-2") — did not edit 1A-1's section.
- `docs/specs/ui-intelligence/manifest.md` (1A-2 row `Status`:
  `pending` -> `done`, only that row touched).

## Contracts added

`ui_screen`, `ui_settings_section`, `ui_settings_field` `data` shapes;
`REGISTERED_AT`/`RENDERED_BY` `entity_links` relation semantics; the
`do_settings_sections()` no-entity/no-new-relation judgment call and its
`data.rendered_at` hand-off to 1A-6; `resolveCallable()`'s WP-callable
resolution rules (`array($this, ...)`/`array(__CLASS__, ...)`/literal
string/literal class name). Full detail in contracts.md's "Phase 1A-2"
section.
