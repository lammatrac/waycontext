# Phase 1B-1 plan — Shortcode recognition (REQ-023, AC-015)

## Spec

REQ-023 (spec.md L549-560): `add_shortcode('tag', 'callback')` MUST be
recognized, producing a generic `shortcode` entity (not `ui_shortcode`) with
`REGISTERED_AT` (registration callsite) and `RENDERED_BY` (callback)
relations. Applies to Increment 1B. Q-019/Q-018: shortcodes ship before
Gutenberg (1B-2) because more deterministic; kind is generic per D-UI-018.

AC-015 (spec.md L1404-1412): `add_shortcode('members', 'render_members')` ->
a `shortcode` entity (kind `"shortcode"`) with `REGISTERED_AT` at the call
site and `RENDERED_BY` -> `render_members()`.

Everything referenced by this slice (`REGISTERED_AT`/`RENDERED_BY` shape,
`resolveCallable()`, generic-kind naming rule, storage-plane rule, pipeline
position, staging-entity precedent) is already defined in contracts.md
(phases 1A-2, 1A-3, 1A-9). No missing dependency found.

## Locate — real code this phase touches

- `src/ui/phpHooks.js` — closest structural precedent (a third sibling PHP
  extractor: `stripQuotes`/`resolveCallable`/`positionalArgs` duplicated
  locally, an owner-tracking `walk()`, literal-only name resolution, `@file`
  sentinel for top-level). Confirmed (test/ui.phpHooks.test.js's last test)
  that `add_shortcode`/`do_shortcode` are NOT recognized by this module —
  matches contracts.md's note that this is deliberately left to 1B-1.
- `src/ui/phpWpPrimitives.js` — precedent for per-file in-file-only
  `REGISTERED_AT`/`RENDERED_BY` resolution via `SELECT name, entity_id FROM
  symbols WHERE file_id = $1 AND entity_id IS NOT NULL` in the same
  transaction (`writeUiWpPrimitives`).
- `src/indexer.js`:
  - per-file PHP UI-extraction block (~L328-391): where each sibling
    extractor is called, wrapped in try/catch, and its write function
    invoked in the same per-file transaction.
  - `dropFile()` (~L411-441): tombstones all UI-adjacent kinds by
    `data->>'source_path'` on outright file deletion — needs a new entry.
  - `writeUiHookSites()` (~L1186) / `resolveHookGraph()` (~L1323): the
    staging-entity + project-wide-post-pass pattern for a project-wide-keyed
    generic entity (`hook`) with per-callsite staging facts. This is the
    closest precedent for `shortcode`'s own lifecycle, NOT
    `writeUiWpPrimitives()` alone, because `shortcode` (like `hook`) is
    keyed by name/tag project-wide, not per callsite (see "Design decision"
    below) — but unlike `hook`'s `LISTENS_TO` (project-wide symbol-name
    match), `REGISTERED_AT`/`RENDERED_BY` here resolve same-file only,
    mirroring `resolveHookGraph()`'s own `FIRED_BY` SQL shape (join through
    `files f ON f.path = hs.data->>'source_path'` then `symbols sym ON
    sym.file_id = f.id`), not its `LISTENS_TO` shape.
  - pipeline order in `runIndex()` (~L556-655, confirmed fresh per 1A-9's
    warning not to trust older phase notes): `reconcileIdentity()` ->
    `identityPreflight` -> `resolveHookGraph()` -> `resolveI18nGraph()` ->
    `resolveUiRelations()`. A new post-pass joining `symbols.entity_id` must
    sit after `identityPreflight` (Bug #1, 1A-9) — placed right after
    `resolveI18nGraph()`, before `resolveUiRelations()`.
  - `runIndex()`'s returned stats object (~L829-842): gains a `shortcodes`
    field alongside `hooks`/`i18n`.
- `test/fixtures/wordpress-ui/` — reused per 1A-9/1B-1 handoff note. Add a
  shortcode fixture to `includes/members-screen.php` (thematically "members"
  already) rather than a new file, matching AC-015's own worked example
  almost verbatim.

## Design decision: `shortcode` entity keying + relation resolution scope

Per the orchestrator's brief and re-confirmed by re-reading contracts.md
"Phase 1A-3" directly: WordPress allows only one callback per shortcode tag
(a second `add_shortcode()` call for the same tag overwrites the first at
runtime) — so `shortcode` is one entity **per tag, project-wide**, following
`hook`'s precedent (`natural_key = hook:<project>:<hook_name>`), not the
per-callsite `ui:<project>:php:<path>:<owner>:<fingerprint>` format every
`ui_*` kind uses.

`REGISTERED_AT`/`RENDERED_BY` resolve **same-file only** (1A-2's precedent
for these exact two relation names), NOT project-wide like `hook`'s
`LISTENS_TO`. Reasoning: REQ-023's own text and AC-015's own worked example
name no cross-file scenario (unlike EDGE-012, which explicitly named a
cross-plugin hook scenario driving `LISTENS_TO`'s project-wide scope); a
shortcode's registration and its render callback are overwhelmingly declared
in the same file in real WP plugin code (unlike settings/hooks, which are
commonly split across an `admin_init` callback file and a separate render
file) — no spec text or WP convention was found suggesting otherwise.

Consequence: entity lifecycle still needs project-wide knowledge (tag X's
entity must stay alive iff *some* live call site anywhere still registers
it), so a staging entity (`shortcode_site`, one row per callsite, same
non-spec-facing status as `hook_site`) plus a small project-wide post-pass
(`resolveShortcodeGraph()`) is still required — it cannot be done as a pure
per-file write the way `ui_screen`/`ui_settings_section` are, because the
entity's own upsert/tombstone can't be scoped to one file's
`data->>'source_path'` when a shared tag could (in principle) be referenced
from more than one file. The post-pass's relation resolution, however,
mirrors `resolveHookGraph()`'s `FIRED_BY` shape (same-file join), not its
`LISTENS_TO` shape (project-wide unique-name join) — this is the "hybrid"
the orchestrator's brief flagged as the likely right call, confirmed here
against the real hook-graph SQL rather than assumed.

## Plan — file by file

1. **New: `src/ui/phpShortcodes.js`** — fourth sibling extractor (after
   phpElements/phpWpPrimitives/phpHooks/phpI18nCalls/phpSettingsRender —
   actually sixth in file-creation order, fifth counting only PHP-source
   extractors). Recognizes only `add_shortcode(tag, callback)`. Duplicates
   `stripQuotes`/`resolveCallable`/`positionalArgs` locally (module-boundary
   precedent). `extractPhpShortcodes(source) -> {tag, callback, owner,
   line}[]`. Literal-only `tag` (skip call site entirely if not a literal
   string — REQ-026 spirit, same as `phpHooks.js`'s `literalHookName`).
   `callback` via `resolveCallable()`, may be `null`. No `do_shortcode()`
   recognition (out of scope, confirmed by REQ-023's own text and the
   "Scope boundaries" section of the brief).

2. **`src/indexer.js`**:
   - import `extractPhpShortcodes`.
   - in the per-file PHP block, extract shortcodes (try/catch, same log
     line convention: `UI adapter "phpShortcodes" extraction skipped for
     ${rel}: ...`) and call a new `writeUiShortcodeSites(client, project,
     rel, shortcodes)`.
   - `writeUiShortcodeSites()`: tombstone-then-upsert `shortcode_site`
     entities by `data->>'source_path'`, natural_key
     `shortcodesite:<project>:php:<path>:<owner>:<fingerprint>` (fingerprint
     = `sha256(tag|callback|owner|line).slice(0,12)`, `-2`/`-3`
     disambiguation), `data: {source_path, owner, line, tag, callback}`.
     Mirrors `writeUiHookSites()` almost exactly.
   - `dropFile()`: add `'shortcode_site'` to the tombstone `kind IN (...)`
     list.
   - new `resolveShortcodeGraph(project, log)`: mirrors `resolveHookGraph()`
     structurally —
     (a) upsert one `shortcode` entity per distinct live `tag`
     (`natural_key = shortcode:<project>:<tag>`, `data: {shortcode_id, tag,
     framework: "php"}`, `title = tag`);
     (b) tombstone `shortcode` entities with no live `shortcode_site`
     referencing their tag anymore;
     (c) delete existing `REGISTERED_AT`/`RENDERED_BY` links touching this
     project's `shortcode` entities, then reinsert from scratch (full
     recompute, same cost/simplicity tradeoff as `resolveHookGraph()`);
     (d) `REGISTERED_AT`: `src` = shortcode entity, `dst` = the call site's
     own-file `owner` symbol's `entity_id` (same-file join, mirrors
     `FIRED_BY`'s SQL shape); (e) `RENDERED_BY`: `src` = shortcode entity,
     `dst` = the call site's own-file `callback` symbol's `entity_id`
     (same-file join, same shape as (d), not project-wide).
   - call site: right after the `resolveI18nGraph()` block, before
     `resolveUiRelations()`, same gating (`config.uiEnabled`) and
     try/catch-and-log convention. Add `shortcodes` to the returned stats
     object.

3. **Fixture**: `test/fixtures/wordpress-ui/wp-content/plugins/waycontext/includes/members-screen.php`
   — append a shortcode registration matching AC-015's own worked example
   almost verbatim (`add_shortcode('members', 'render_members')`), wrapped
   in a named registering function (not top-level) so `REGISTERED_AT`
   resolves to a real symbol rather than the `"@file"` sentinel — same
   reasoning `waycontext_register_menu()`/`add_action('admin_menu', ...)`
   already establishes in the sibling fixture file for `add_menu_page()`.

4. **Tests**:
   - `test/ui.phpShortcodes.test.js` — pure extractor unit tests (literal
     tag + string callback; `array($this,'method')` callback; dynamic/
     non-literal tag skipped entirely; unresolvable callback recorded as
     `null`, never fabricated; `do_shortcode()` NOT recognized).
   - `test/indexer.uiShortcodes.test.js` — real-DB end-to-end: entity
     shape/keying, `REGISTERED_AT`/`RENDERED_BY` resolve same-file, a
     cross-file callback does NOT get `RENDERED_BY` (confirms the in-file-
     only scope decision), storage-plane isolation (`symbols`/`edges`
     untouched), tombstone/restore lifecycle (site removed -> entity
     tombstoned; re-added -> un-tombstoned), `config.uiEnabled = false`
     full skip.
   - `test/uiIntelligence.acceptance.test.js` — add an AC-015 case against
     the shared fixture (following 1A-9's per-AC test convention).

5. Append "## Phase 1B-1" to contracts.md; update manifest.md's 1B-1 row.

## Gate — risk re-check

Re-scoring the six dimensions against what Locate/Plan actually found (all
started at 0):

- **Reversibility**: still 0. New entity kind, upsert/tombstone, no
  destructive migration; fully reversible by re-indexing.
- **Security surface**: still 0. No new input surface, no new MCP operation,
  no network/file access beyond what phpHooks.js already does.
- **Concurrency**: still 0. Runs inside the same per-project
  `pg_advisory_lock` every other project-wide post-pass already relies on
  (confirmed by reading `indexProject()`); no new primitive.
- **Blast radius**: still 0. Purely additive — a new `entities`/
  `entity_links` kind/relation-target-pair, one new call site in
  `runIndex()`, one new tombstone-kind entry in `dropFile()`. Does not touch
  `resolveUiRelations()`/`ui_component`/`RENDERS`/etc, and does not touch
  `symbols`/`edges`/`src/parser.js` (confirmed by design — see phpHooks.js's
  own doc comment on why `add_shortcode` must NOT be read from
  `src/parser.js`'s existing `edges` plane).
- **New infra/dependencies**: still 0. No new package, no new table/column
  (unconstrained `entities`/`entity_links` already support this per Q-001).
- **Spec ambiguity**: still 0, not upgraded to "high." The one real judgment
  call (entity keying: per-tag project-wide vs. per-callsite; relation
  scope: same-file vs. project-wide) was already flagged and reasoned about
  explicitly in the orchestrator's brief, cross-checked directly against
  1A-2's/1A-3's own contracts.md sections during Locate, and resolved with a
  documented, precedent-grounded rationale above — not a new ambiguity
  Locate surfaced, and not a coin-flip.

No dimension moved to "high." Proceeding to Code — not escalating.
