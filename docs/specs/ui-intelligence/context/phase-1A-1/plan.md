# Phase 1A-1 plan — PHP literal-HTML UI element indexer + a11y/identity attrs

## Re-check of risk against real code (Gate step)

Upfront score: Reversibility 0 / Security 0 / Concurrency 0 / Blast 1 / Infra 0 / Ambiguity 1 (total 2, not a checkpoint).

Findings after Locate:
- The codebase's PHP parsing is `parseFile("php", source)` in `src/parser.js`, a single
  tree-sitter-php walk that returns `{ symbols, relations }`, written by `src/indexer.js`
  into `symbols`/`edges` only. Per contracts.md's fixed decision, UI elements must go to
  `entities`/`entity_links` instead — so this phase cannot just add cases to `parseFile`,
  it needs a parallel extraction pass. That's a new code path, not a change to a shared
  one, which keeps blast radius at the phase's own files.
- Literal HTML that a PHP file outputs between `?>`/`<?php` tags is *not* parsed into an
  HTML AST by tree-sitter-php at all — it comes through as a single opaque `text` node
  (confirmed empirically: `<div>x</div>` before/between PHP tags is one `text` node
  spanning the whole markup run). `tree-sitter-html` (already a project dependency, used
  for `.html` files) parses a standalone fragment string correctly with no doctype
  needed, confirmed empirically. So the working shape is: walk the PHP tree for `text`
  nodes (+ `echo_statement` concatenations), and for each, hand the substring to a second,
  independent HTML parse to pull out tags/attrs/text — no change to `src/parser.js` needed.
- No risk dimension moved up from the upfront score. This is genuinely additive (new
  module + a new per-PHP-file step inside the existing per-file transaction in
  `runIndex`), gated by a new `config.uiEnabled` flag that defaults on but costs nothing
  when a project has no PHP. Not escalating.

## What I'm building

1. `src/config.js` — add `uiEnabled: setting("UI_ENABLED", "1") !== "0"`, following the
   exact pattern of `docsEnabled`/`historyEnabled`/`rulesEnabled`.

2. `src/ui/phpElements.js` (new) — pure, DB-free extraction:
   - `extractPhpUiElements(source)` parses `source` with tree-sitter-php, walks the whole
     tree tracking an owner stack (nearest enclosing `function_definition` /
     `method_declaration`, qualified `Class::method` inside a `class_declaration`, else
     the sentinel `"@file"` — same sentinel `src/parser.js` already uses for top-level PHP
     hook calls), and for every:
       - `text` node (literal HTML PHP emits directly), and
       - `echo_statement` whose expression is a string or a `.`-concatenation chain
         containing at least one string operand,
     runs a second-pass HTML parse (`tree-sitter-html`) over the (reconstructed, for echo)
     fragment and pulls out "interesting" elements (see filter below), each becoming one
     record: `{ tag, type, role, text, textSource, attrs, hasDynamicText, i18nKey, owner,
     line, extraction }`.
   - "Interesting" element filter (documented decision, not in spec): a semantic tag
     (`button, a, input, select, textarea, option, label, summary, legend, caption,
     h1..h6`) OR carries any of REQ-002's identity attributes (`aria-label, title,
     placeholder, alt, role, name, data-testid`). Bare structural tags (div/span/li/...)
     with neither are not indexed — nothing in REQ-001/002 asks for structural markup, and
     indexing every div would make `ui_element` noise-dominated.
   - Echo/concatenation handling (this resolves EDGE-009 — see contracts.md for the
     write-up): walk the `.`-chain, keep only literal `string` operands and the first
     string argument of a recognized WP i18n wrapper call (`__, _e, esc_html__,
     esc_html_e, esc_attr__, esc_attr_e, _x, _ex`); everything else (variables, other
     calls, ternaries) is replaced by a one-character placeholder so tag structure survives
     reconstruction, and sets `hasDynamicText: true`. If no literal fragment ever forms a
     recognizable opening tag, nothing is emitted for that statement (no entity with an
     unknown type — REQ-001 requires type/role, so nothing to write without one).

3. `src/indexer.js` — inside `runIndex`'s existing per-file loop, in the same transaction
   that already writes `symbols`/`edges` for a `.php` file (right after that insert block,
   before `COMMIT`): when `config.uiEnabled && lang === "php"`, call
   `extractPhpUiElements(content)`, tombstone this file's previously-recorded `ui_element`
   entities (`UPDATE entities SET deleted_at = now() WHERE project_id=$1 AND kind='ui_element'
   AND data->>'source_path' = $2 AND deleted_at IS NULL`), then upsert the fresh set with
   `INSERT ... ON CONFLICT (project_id, kind, natural_key) DO UPDATE SET data=EXCLUDED.data,
   title=EXCLUDED.title, deleted_at=NULL, updated_at=now()` — the tombstone-then-upsert
   pair is what makes an edited-out element disappear (stays tombstoned) while a
   still-present one un-tombstones instead of duplicating. Also add the same tombstone
   query into `dropFile()` (the full-file-deletion path) so a deleted `.php` file's
   elements don't linger as live entities forever.

4. Append this phase's section to `contracts.md`: the `entities` row shape (`kind`,
   `natural_key`/`element_id` format, `data` JSON), the REQ-002 attribute-resolution
   fields, the EDGE-009 decision + rationale, the `ui.enabled` config key name, and what
   1A-2/1A-6 need to know (owner sentinel, tombstone lifecycle, "no entity without a type"
   rule, `framework: "php"` value).

5. Tests:
   - `test/ui.phpElements.test.js` — unit tests for `extractPhpUiElements` directly (no
     DB), covering: literal HTML between php tags, a11y/identity attrs as text sources,
     nested element text concatenation, self-closing `<input>`, owner attribution
     (function / class method / `@file`), the structural-tag filter, echo concatenation
     with a literal-only chain, echo concatenation through a recognized i18n wrapper, echo
     concatenation with a bare variable (dynamic, `hasDynamicText`), and an all-dynamic
     echo producing no entity at all.
   - `test/indexer.uiElements.test.js` — one end-to-end test through `indexProject`
     (pattern copied from `test/indexer.newLanguages.test.js`): a `.php` fixture file,
     assert `entities` rows of `kind='ui_element'` land with the right `data`; a second
     run after editing the fixture to drop one element asserts it tombstones
     (`deleted_at IS NOT NULL`) rather than lingering; a run with `UI_ENABLED=0` asserts
     zero `ui_element` entities are written.

## Files touched
- `src/config.js` (add `uiEnabled`)
- `src/ui/phpElements.js` (new)
- `src/indexer.js` (wire extraction + tombstone into the PHP file branch and `dropFile`)
- `docs/specs/ui-intelligence/contracts.md` (append phase section)
- `docs/specs/ui-intelligence/manifest.md` (status → done)
- `test/ui.phpElements.test.js` (new)
- `test/indexer.uiElements.test.js` (new)

## Out of scope (left for later phases, per the spec slice)
- JSX/TSX elements (Increment 2).
- WP-specific primitives (`submit_button`, admin menu, Settings API) — 1A-2.
- `RENDERED_ON`/`CONTAINS`/etc. relations, ownership classification — 1A-6.
- i18n `.po`/`.mo` resolution of the `i18nKey` this phase records — 1A-4.
- `resolve_ui_reference`/`match_score` consumption of `text`/`textSource` — 1A-7.
