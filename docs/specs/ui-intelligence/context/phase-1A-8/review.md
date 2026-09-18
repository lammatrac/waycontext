STATUS: DONE

## What was verified

- `node --test test/*.test.js`: 748 passing, 0 failures (729 pre-existing +
  19 new in `test/operations.uiQueries.test.js`). No regressions.
- `test/operations.uiQueries.test.js` (19 tests, real DB, real
  `indexProject()` run over a tmp PHP fixture, no mocking -- same convention
  as `test/indexer.uiRelations.test.js`/`test/ui.referenceResolver.test.js`):
  - Registry wiring: all five operations registered, `readOnly: true`,
    reachable by name.
  - `resolve_ui_reference`: task_text resolution + `understood` echo,
    missing task_text/hint throws, unknown project throws (not a status
    field), framework-owned candidate carries `not_relevant`/no
    `application_source`, no-match returns `status: "not_found"` (not an
    error), `config.uiEnabled = false` surfaces `enabled: false` distinctly
    from `not_found`.
  - `find_ui_element`: structured-hint-only resolution, missing `text`
    throws.
  - `get_ui_context`: composes component/screen/`handled_by` (hook named via
    `FIRED_BY`) for a real submit_button element; a component with no
    handler resolves cleanly with empty `handled_by`; unknown `element_id`
    throws.
  - `trace_ui_action`: element -> hook -> callback -> `getSubgraph` onward
    call graph (asserted the onward graph actually reaches the callback's
    own callee); settings field traces via `RENDERED_BY` instead of the hook
    graph; no resolvable handler reports `status: "no_handler_found"`, not
    an error.
  - `find_ui_source`: submit_button element reports `created_via:
    "submit_button"` + registration + entry hook; a `ui_screen` reports
    `created_via: "add_menu_page"` and its entry hook via `LISTENS_TO`
    (`admin_menu`); a `wp-includes/`-owned element gets `not_relevant`, never
    `application_source`; unknown `element_id` throws.
- `test/operations.test.js` (18 tests, pre-existing, unmodified): still
  fully green -- registry invariants (CLI/MCP agreement, alias uniqueness,
  positional ordering, readOnly declarations) hold for the five new entries
  with no changes to the test file itself.
- `test/completion.test.js` (pre-existing): initially failed 2/many after
  the first pass (missing `OP_HELP` entries for the five new operations, and
  the stale `test/fixtures/help.txt` byte-comparison). Fixed by adding a new
  `SECTIONS` entry (`ui`, "WordPress UI (Increment 1A)") and five `OP_HELP`
  glosses in `src/completion.js`, then regenerating
  `test/fixtures/help.txt` via `node src/cli.js help`. Full suite green
  after the fix.
- Storage plane: `src/ui/uiQueries.js` contains no `INSERT`/`UPDATE`/
  `DELETE` anywhere -- confirmed by reading the file; every query is a
  `SELECT`. No new `entities`/`entity_links` rows, no schema change.

## What was not verified

- No WordPress fixture project exists in this repo beyond the small
  synthetic PHP fixtures this phase's own test file and 1A-6's write to a
  tmp dir (contracts.md's still-open "WordPress fixture project" item,
  reserved for 1A-9). This phase's tests exercise the full REQ-012 surface
  against those synthetic fixtures, not a real-world WordPress codebase's
  scale/shape.
- No load/perf testing of `enrichCandidates`'s extra batched query or
  `trace_ui_action`'s `getSubgraph` call against a large project -- both are
  bounded (candidates <= 5, `getSubgraph`'s own existing `maxNodes=60`
  default), consistent with every other bound already established in this
  feature (1A-7's 500-row candidate pool, 1A-6's unique-match-only
  discipline), but not measured.
- MCP-transport-level testing (`buildMcpServer()`/`readOnlyHint` end-to-end
  through an actual MCP client) was not run -- `src/mcpServer.js` derives
  `readOnlyHint` mechanically from `op.readOnly`, which the registry-level
  test suite does cover; no MCP-transport test file exists in this repo to
  extend.
- HTTP route testing (`/v1/ops/:name`) was not run for the five new ops --
  no test file for that surface exists to extend, and it consumes the same
  `operations` registry already covered by `test/operations.test.js`.

## Files changed

- `src/ui/uiQueries.js` (new)
- `src/operations.js` (five new registry entries + import)
- `src/completion.js` (new `ui` section, five `OP_HELP` entries, one stale
  doc-comment number removed)
- `test/operations.uiQueries.test.js` (new, 19 tests)
- `test/fixtures/help.txt` (regenerated)
- `docs/specs/ui-intelligence/contracts.md` (new "Phase 1A-8" section
  appended)
- `docs/specs/ui-intelligence/manifest.md` (1A-8 row: pending -> done)
- `docs/specs/ui-intelligence/context/phase-1A-8/plan.md`,
  `docs/specs/ui-intelligence/context/phase-1A-8/review.md` (this file)
