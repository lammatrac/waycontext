STATUS: DONE

## What was verified

- Full test suite: **801 tests passing (779 pre-existing + 22 new), 0
  failures.** Run via `npm test` (`node --test test/*.test.js`), real
  Postgres DB, no mocking anywhere in the new tests.
- `test/ui.phpBlocks.test.js` (12 tests): pure extractor unit coverage —
  AC-016's exact worked example, short-array (`[...]`) syntax, `__DIR__`
  alone, a bare literal directory, `array($this,'method')`/
  `array(__CLASS__,...)`/`array('LiteralClass',...)` callback resolution, a
  dynamic first argument skipped entirely (no fabrication), a
  `plugin_dir_path(__FILE__)`-style unresolvable concatenation skipped, a
  missing/unresolvable `render_callback`, `register_block_type_from_metadata()`
  correctly not recognized, line numbers.
- `test/indexer.uiBlocks.test.js` (8 tests, real `indexProject()` runs):
  AC-016's full chain end to end (`block` + `block_manifest` +
  `DEFINED_IN` + `RENDERED_BY`, plus an explicit assertion that
  `resolution_status` is never written); cross-file `render_callback`
  (`DEFINED_IN` resolves, `RENDERED_BY` doesn't — same-file-only scope);
  a registration whose block.json doesn't exist on disk produces zero
  entities; a resolved path naming block.json directly (not just a
  directory); the root-boundary security check (a real, valid block.json
  placed **outside** the project root at the exact resolved escape target,
  confirmed never read); storage-plane isolation (`symbols`/`edges`
  untouched); tombstone/restore lifecycle for both `block` and
  `block_manifest`; `config.uiEnabled = false` full skip.
- `test/uiIntelligence.acceptance.test.js` (+2 tests, against the shared
  `wp_ui_fixture` project): AC-016 end to end against the shared fixture;
  AC-017 — `find_ui_element`/`resolve_ui_reference` both return
  `status: "not_found"`/zero candidates for text that would only appear in
  a persisted block instance, and a project-wide scan confirms zero
  entities anywhere carry `data.resolution_status = "data_owned"`.
- Storage plane confirmed by test: only `entities` (`kind IN ('block',
  'block_manifest', 'block_site')`) and `entity_links` (`relation IN
  ('DEFINED_IN', 'RENDERED_BY')`) touched; `symbols`/`edges` untouched.
  `src/parser.js` was not modified.
- `node --check src/indexer.js` — no syntax errors.
- Manually verified the `__DIR__` tree-sitter-php node shape (`name` node,
  text `"__DIR__"`) and that `array(...)`/`[...]` both parse to
  `array_creation_expression`, via a throwaway parse, before writing
  `resolveDirArg()`/`arrayLiteralGetNode()`.
- Manually verified `path.posix.dirname`/`join`/`normalize` behavior for a
  top-level file (owner `"@file"`, `rel` with no directory component) and
  for an escape attempt (`../../../../etc`), confirming the boundary check
  (`normalizedRel.startsWith("../")`) fires correctly before writing the
  end-to-end test that proves it against a real decoy file.

## What wasn't verified

- Not benchmarked against a large real-world WordPress codebase with many
  block registrations — `resolveBlockGraph()`'s full-recompute-every-run
  cost profile is the same documented, unmeasured tradeoff
  `resolveHookGraph()`/`resolveShortcodeGraph()` already carry; not
  re-measured by this phase.
- No MCP-surface test — `block`/`block_manifest` are not exposed to any MCP
  operation in this phase (matches REQ-024's own text, which names no
  query-surface requirement, and 1B-1's identical scope decision for
  `shortcode`), so there is nothing MCP-facing to test.
- Real-world WordPress block.json variety beyond `name`/`title`/`category`/
  `textdomain` (i18n-schema fields, `supports`, `attributes`, etc.) is not
  read or recorded — out of scope per REQ-024's own minimum ask; documented
  in contracts.md under "Scope explicitly not covered."

## Files changed

- `src/ui/blockManifest.js` (new) — `readBlockManifest()`.
- `src/ui/phpBlocks.js` (new) — `extractPhpBlocks()`.
- `src/indexer.js` — imports; `writeUiBlockSites()`; `resolveBlockGraph()`;
  wired into the per-file PHP block, the post-file-loop pipeline (after
  `resolveShortcodeGraph()`, before `resolveUiRelations()`), `dropFile()`'s
  tombstone kind list, and the final `stats` return object (`blocks`
  field).
- `test/ui.phpBlocks.test.js` (new, 12 tests).
- `test/indexer.uiBlocks.test.js` (new, 8 tests).
- `test/uiIntelligence.acceptance.test.js` — +2 tests (AC-016, AC-017).
- `test/fixtures/wordpress-ui/wp-content/plugins/waycontext/build/block.json`
  (new) and `.../includes/blocks.php` (new).
- `docs/specs/ui-intelligence/contracts.md` — new "Phase 1B-2" section
  appended.
- `docs/specs/ui-intelligence/manifest.md` — 1B-2 row `Status` → `done`.

## Contracts added

- `block` entity (`kind = 'block'`, generic, project-wide by namespace).
- `block_manifest` entity (`kind = 'block_manifest'`, generic, project-wide
  by path) — new entity shape, no prior precedent in this feature (mirrors
  `entities(kind='document')`'s own "a file becomes an entity so a relation
  can target it" precedent, at a much lighter weight).
- `block_site` internal-only staging entity (`kind = 'block_site'`).
- `DEFINED_IN` relation (`block -> block_manifest`) — new relation name in
  this feature, project-wide resolution, "unique match only."
- `RENDERED_BY` reused verbatim (`block -> symbol`, same-file-only scope,
  same SQL shape as `shortcode`'s own `RENDERED_BY`).
- `runIndex()`'s stats object gained a `blocks` field.

## Notes

- Gate re-check (plan.md): no risk dimension moved to "high." The one new
  finding not visible from spec text alone — a filesystem read driven by
  parsed source text (block.json resolution) — was mitigated directly in
  code (a root-boundary check, verified by test against a real decoy file
  outside the project root) rather than treated as an escalation trigger;
  documented in contracts.md under "Security note."
- The two open judgment calls the phase brief flagged (`block`'s entity
  keying; `DEFINED_IN`'s target shape) are both resolved and documented in
  contracts.md, with reasoning grounded in existing precedent
  (`hook`/`shortcode` for keying; `document` for a file-as-relation-target).
