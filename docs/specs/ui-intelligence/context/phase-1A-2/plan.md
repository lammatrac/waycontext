# Phase 1A-2 plan — WP UI primitives: submit_button, admin menu, Settings API

## Spec slice recap

REQ-016 (`submit_button()` -> button-shaped `ui_element`), REQ-017
(`add_menu_page()`/`add_submenu_page()` -> `ui_screen`), REQ-018
(`add_settings_section()`/`add_settings_field()`/`do_settings_sections()` ->
`ui_settings_section`/`ui_settings_field` with `REGISTERED_AT`/`RENDERED_BY`
relations). Depends on 1A-1 (done): `entities`/`entity_links`-only storage,
`element_id`/`natural_key` format `ui:<project_name>:php:<source_path>:<owner>:<fingerprint>`,
owner sentinel convention (`"@file"` / `"fn"` / `"Class::method"`), Q-003's
in-file-only resolution bound.

## What references contracts.md but isn't defined there yet

- `ui_screen`/`ui_settings_section`/`ui_settings_field` `data` shapes — not
  defined by any prior phase (contracts.md says so explicitly: "no prior
  phase has defined a `ui_screen` shape"). This phase defines them and
  appends the shapes to contracts.md, per its own instructions.
- `REGISTERED_AT`/`RENDERED_BY` relation shapes — same, first use in
  `entity_links` for a real UI relation (1A-1 never wrote `entity_links`).
  `entity_links.relation` is unconstrained TEXT (0006 migration comment lists
  examples, not an enum), so introducing two new relation names is schema-safe.

Nothing else in the spec slice references an undefined contract — proceeding.

## Locate

- `src/ui/phpElements.js` — 1A-1's pure, DB-free literal-HTML extractor.
  Read in full. Confirmed: exports only `extractPhpUiElements`; internal
  `I18N_WRAPPERS`/`stripQuotes`/echo-concatenation-walk are not exported.
- `src/indexer.js` — the per-file transaction (`runIndex`web`)`: symbols/edges
  written first (lines ~251-317), including a bulk `entities` upsert for
  `kind='symbol'` and `symbols.entity_id` backfill — both **complete before**
  the existing `config.uiEnabled && lang === "php"` UI block runs (line
  ~319), all inside the same transaction/client. This means this file's own
  symbol entities already exist and are queryable via the same `client` by
  the time UI writes happen — the load-bearing fact that makes in-file
  REGISTERED_AT/RENDERED_BY resolution possible without a second pass.
  `writeUiElements()` (tombstone-then-upsert, `ON CONFLICT (project_id, kind,
  natural_key)`) is the pattern to replicate for the three new kinds.
  `dropFile()` also tombstones `ui_element` on outright file deletion — needs
  the three new kinds added to its `kind IN (...)` list.
- `test/ui.phpElements.test.js`, `test/indexer.uiElements.test.js` — 1A-1's
  test shape/conventions to mirror (pure-function unit tests + a live-DB
  `indexProject()` integration test using `cleanupTestProject`).
- Confirmed via `src/parser.js:534`: a PHP method's `symbols.name` (and thus
  `entities.title` for `kind='symbol'`) is already stored as
  `${className}::${methodName}` — **identical** to phpElements.js's `owner`
  convention. No name-translation needed to match a callback/owner against
  this file's own symbol entities.
- Verified WP core function signatures and tree-sitter-php's concrete AST
  shapes for `function_call_expression`/`arguments`/`argument`/
  `array_creation_expression`/`array_element_initializer` with a scratch
  parse script (not committed) — positional array elements
  (`array($this, 'x')`) are two `array_element_initializer` nodes with one
  named child each; key=>value pairs (`array('k' => 'v')`) are one
  `array_element_initializer` node with two named children.

## Design decisions (see contracts.md for the full write-up)

1. **New sibling module**, not an extension of `phpElements.js`:
   `src/ui/phpWpPrimitives.js`, pure/DB-free, one independent PHP AST walk,
   exporting `extractPhpWpPrimitives(source)` ->
   `{ elements, screens, settingsSections, settingsFields }`. Chosen over
   extending `phpElements.js` in place to keep 1A-1's already-tested file
   and its export contract completely untouched (zero regression risk) —
   1A-1's tests only import `extractPhpUiElements` and assert array-shaped
   output; changing that shape to accommodate new entity kinds would have
   broken them. `I18N_WRAPPERS`/`stripQuotes` are duplicated (not imported)
   for the same isolation reason — a few lines of duplication versus adding
   new exports to a frozen, reviewed file.
2. `submit_button()` output is `ui_element`-shaped (matches 1A-1's shape
   exactly, `extraction: "wp_primitive"`) and is merged into the same array
   `writeUiElements()` already consumes — no new writer needed for REQ-016.
3. `ui_screen`/`ui_settings_section`/`ui_settings_field` get one new writer,
   `writeUiWpPrimitives()`, modeled directly on `writeUiElements()`
   (tombstone-then-upsert, same `natural_key` format, same disambiguation
   scheme), plus `REGISTERED_AT`/`RENDERED_BY` `entity_links` resolved
   in-file only against this file's own `symbols` (Q-003 bound — see
   contracts.md for why cross-file resolution is explicitly left to 1A-6/1A-7).
4. `do_settings_sections()` is recognized (REQ-018 requires it) but produces
   **no new entity and no new relation type** — see contracts.md for the
   full reasoning. Its only effect is an in-file, same-page correlation that
   sets `data.rendered_at` on matching `ui_settings_section`/
   `ui_settings_field` records, handing 1A-6 a ready fact instead of a
   relation type this phase would be guessing at.

## Files to change

- New: `src/ui/phpWpPrimitives.js`
- New: `test/ui.phpWpPrimitives.test.js`
- New: `test/indexer.uiWpPrimitives.test.js`
- Edit: `src/indexer.js` — import, per-file wiring, new `writeUiWpPrimitives()`
  function, `dropFile()`'s tombstone `kind IN (...)` list.
- Edit (append only): `docs/specs/ui-intelligence/contracts.md`,
  `docs/specs/ui-intelligence/manifest.md` (1A-2 row status only).

## Gate re-check (risk vs. upfront 0/0/0/0/0/0)

- **Reversibility**: purely additive new entity kinds + a new module; no
  migration, no change to existing kinds' shapes. Still 0.
  Locate turned up nothing that changes this: `entities`/`entity_links` are
  schema-free JSONB/TEXT, and the write path is gated by the same
  `config.uiEnabled` flag 1A-1 already established.
- **Security surface**: parses more of the same already-trusted, already-
  parsed PHP source (no new input source, no new external call). Still 0.
- **Concurrency**: same single-client, single-transaction, per-file pattern
  as every other write in `runIndex`; the new symbol-name lookup query runs
  on the same `client` inside the same transaction, so it sees this file's
  just-inserted symbol rows without any race. Still 0.
- **Blast radius**: gated behind `config.uiEnabled && lang === "php"`,
  touches only PHP projects, only adds new `entities.kind` values and two
  new `entity_links.relation` values (unconstrained TEXT column, no schema
  change). Still 0.
- **New infra/dependencies**: none — reuses `tree-sitter-php`, already a
  dependency. Still 0.
- **Spec ambiguity**: REQ-018's `do_settings_sections()` role was genuinely
  underspecified (does it produce an entity? a relation? which one?) — this
  is real ambiguity Locate surfaced that the upfront read of the REQ text
  alone didn't fully expose. However, the phase brief explicitly anticipated
  this ("use your judgment and document the reasoning in contracts.md") and
  the resolution chosen is conservative (no new relation invented, defers to
  1A-6, nothing fabricated) rather than a landmine — it doesn't rise to
  "high," so it doesn't change the score. Documented at length in
  contracts.md instead of escalating.

No dimension moved to "high." Proceeding without escalation.
