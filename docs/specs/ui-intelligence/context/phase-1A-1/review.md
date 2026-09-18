STATUS: DONE

## What was verified

- `node --test test/ui.phpElements.test.js` — 12/12 pass. Unit coverage:
  semantic-tag extraction with type/text/line/owner; the structural-tag
  filter (div/span without an identity attr → not indexed); REQ-002 text
  precedence (child text > aria-label > title > placeholder > alt), verified
  with cases where multiple sources are present simultaneously so the
  ordering is actually exercised, not just the fallback path; self-closing
  elements; owner attribution at all three scopes (`@file`, plain function,
  `Class::method`); all four EDGE-009 branches (literal-only concat,
  i18n-wrapper concat, dynamic-variable concat, all-dynamic → no entity);
  a dynamic value inside an identity attribute; nested-element text
  concatenation; leading top-level HTML before the first `<?php`.
- `node --test test/indexer.uiElements.test.js` — 3/3 pass. End-to-end
  through `indexProject`: entities land with the right `data` shape and
  `natural_key` format; editing an element out of the file tombstones it
  (`deleted_at` set) rather than deleting or leaving it live, while the
  still-present siblings un-tombstone correctly; `config.uiEnabled = false`
  produces zero `ui_element` rows; and an explicit check that no `symbols`
  row of a `ui*` kind was written (storage-plane discipline, REQ-019).
- Full suite (`npm test`, 644 tests) run twice after these changes: clean
  644/644 both times. One earlier ad hoc run showed a single unrelated
  failure that did not reproduce on either full re-run and did not name any
  file this phase touched — logged as a flake, not chased further given the
  phase's risk budget.
- Manual sanity runs against representative fixtures (not part of the test
  suite, used during development to validate AST assumptions before writing
  tests) confirmed: tree-sitter-php returns literal HTML as an opaque `text`
  node (never parses it), tree-sitter-html parses a standalone fragment
  string with no doctype needed, and PHP `binary_expression` exposes a real
  `operator` field (not positional) — worth recording since a future editor
  of this file might be tempted to index into `node.child(n)` instead.

## What wasn't verified

- No test against a WordPress-scale real fixture (no WP fixture project
  exists in this repo yet — manifest.md already flags this as an open item
  for 1A-9's integration tests). My fixtures are small hand-written `.php`
  files.
- No test of PHP double-quoted strings containing backslash-escaped
  characters inside the echo-concatenation path — documented as a known
  limitation in contracts.md rather than fixed, since the dominant WP idiom
  (single-quoted PHP string wrapping double-quoted HTML attributes) is what
  the tests cover and what's actually common in the wild.
- No performance testing on a large PHP file / large repo. The extraction
  adds one extra tree-sitter-html parse per `text` node / `echo_statement`
  candidate per PHP file; for a typical template file this is a handful of
  parses, but a PHP file with hundreds of tiny interleaved echo statements
  was not benchmarked.
- No test of `print`/`printf`/heredoc-based HTML output — only `echo` is
  handled, as scoped in plan.md. If a real WP codebase leans on `printf`
  for translated strings (plausible — `printf(esc_html__('Save %s', 'td'),
  $x)` is a common pattern), this phase's echo-only handling will miss it.
  Flagging this explicitly since it's the kind of gap that looks like a bug
  later if not written down now: REQ-001/REQ-002 don't call out `printf`
  specifically, and the scope note said "echo/string concatenation" verbatim.

## Open questions for later phases (not blocking this phase's DONE status)

- 1A-6 needs to decide how `owner` (a bare name / `Class::method` /
  `@file`) becomes an actual graph edge to the corresponding `symbol`
  entity — this phase deliberately left `owner` as a plain string rather
  than pre-resolving it, since edge resolution against `symbols` is already
  a `runIndex`-wide concern (see the dst-name resolution passes later in
  `runIndex`) and duplicating that logic here felt like scope creep for a
  phase scored at risk-total 2.
- 1A-7 needs to decide how much to discount `match_score` when
  `has_dynamic_text: true` — this phase records the signal but does not
  prescribe a weighting.
- EDGE-006 (one entity with several `RENDERED_ON` links vs. one per screen)
  and EDGE-010 (staleness) remain open in contracts.md's "Pending
  cross-phase decisions" section, untouched by this phase — they're 1A-6's
  and 1A-8's calls respectively, not mine.

## Risk re-check outcome

No dimension moved up from the upfront score (0/0/0/1/0/1). See plan.md's
"Re-check of risk against real code" section for the reasoning — the shape
that looked risky on paper (touching the shared `parseFile`) turned out not
to be the actual shape needed (a parallel, independent extraction pass), which
kept blast radius contained to new files plus one narrow, well-tested
insertion point in `src/indexer.js`.
