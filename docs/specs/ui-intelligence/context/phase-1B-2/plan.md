# Phase 1B-2 plan — Gutenberg static block registration (REQ-024)

## Spec (confirmed against contracts.md + spec.md directly)

- REQ-024 (spec.md L562-576): `register_block_type()` + `block.json` +
  `render_callback` -> generic `block` entity (not `ui_block`), with
  `DEFINED_IN` (-> block.json) and `RENDERED_BY` (-> render callback).
  MUST NOT resolve persisted block *instance* content
  (`wp_posts.post_content`) — that's `resolution_status = "data_owned"`,
  deferred to Increment 3.
- AC-016 (L1414-1425): worked example —
  `register_block_type(__DIR__.'/build', ['render_callback' =>
  'render_pricing_block'])` + a `block.json` declaring
  `"name": "waycontext/pricing"`.
- AC-017 (L1427-1435): a *persisted* `<!-- wp:button -->` instance queried
  via `find_ui_element`/`resolve_ui_reference` — result "(if any)" carries
  `resolution_status = "data_owned"`, no fabricated `visible_text`.
- EDGE-014 (L1203-1216): same content, "increment 1B does not promise to
  identify every element inside persisted Gutenberg content."
- REQ-025/Q-018/D-UI-018: `block` is in the fixed generic (non-`ui_`-
  prefixed) kind list.

Everything referenced by the slice (`resolveCallable`'s rule set, the
`ui_`/generic kind-naming rule, `entities`/`entity_links` storage plane,
`identityPreflight` pipeline position) is already in contracts.md — no
missing dependency.

## Locate (real code, not prose)

- `src/ui/phpShortcodes.js` — closest precedent: 6th sibling PHP extractor,
  pure/DB-free, one recognized function, `resolveCallable()`, literal-only
  key argument, per-callsite record shape.
- `src/indexer.js`:
  - Per-file PHP block (`config.uiEnabled && lang === "php"`, ~L329-408):
    where the sibling extractors are called and their staging entities
    written, one after another, inside the same per-file transaction.
  - `writeUiShortcodeSites()` (~L1916) / `resolveShortcodeGraph()`
    (~L1493): the exact tombstone-then-upsert + project-wide post-pass
    shape to mirror for `block`/`block_site`.
  - `dropFile()` (~L428): kind list to extend with `block_site`.
  - Pipeline order (verified fresh, matches 1A-9's Bug #1 note and 1B-1's
    own position): `resolveHookGraph()` -> `resolveI18nGraph()` ->
    `resolveShortcodeGraph()` -> `resolveUiRelations()`, all after
    `reconcileIdentity()`/identity preflight. `resolveBlockGraph()` slots
    in right after `resolveShortcodeGraph()`, same reasoning (joins
    `symbols.entity_id`).
  - Final `stats` return object (~L869-883): add `blocks` alongside
    `hooks`/`i18n`/`shortcodes`.
- `src/ui/phpWpPrimitives.js` — `arrayLiteralGet()` precedent (literal
  string value from an `array('key' => 'literal', ...)`), needs a sibling
  variant returning the raw *node* (not just a string) so a
  `'render_callback'` value can be run through `resolveCallable()`.
- `src/migrations/0006_identity_and_history.sql` L75-85 —
  `entity_links.dst_id BIGINT NOT NULL REFERENCES entities(id)`: a relation
  target MUST be an `entities` row. No existing mechanism links to a raw
  file path.
- `src/migrations/0007_documents.sql` — the one existing precedent for "a
  specific file becomes an entity, so relations can target it":
  `entities(kind='document')`, keyed by repo-relative path. Its own doc
  comment explicitly says "a file is not an entity in this schema" *in
  general*, but documents are the deliberate, already-precedented
  exception when a specific file needs to be a link target. `block.json`
  is the same shape of exception, at a much lighter weight (no
  chunking/embedding — that whole `documents`/`chunks` machinery is
  `docsEnabled`-gated, ADR/README-specific, and would be serious scope
  creep for a JSON metadata file).
- `src/ui/i18nCatalog.js` — precedent for "a UI-Intelligence submodule that
  reads a *second* file from disk, independent of the main per-file parse,
  with no module-level cache" (`discoverCatalogs(root)`). Model for a new
  `src/ui/blockManifest.js` that reads/parses one `block.json`.
- `src/parser.js` `EXT_LANG` — `.json` is already a walked/indexed
  language (pre-existing, unrelated to this feature); irrelevant to my own
  direct `fs.readFileSync` of block.json (not read through that path).
- Confirmed via a throwaway tree-sitter-php parse: `__DIR__` parses as a
  `name` node (text `"__DIR__"`), the same node *type* `resolveCallable()`
  already special-cases for `__CLASS__`. `array(...)` and `[...]` both
  parse to `array_creation_expression` (confirmed empirically) — existing
  `arrayLiteralGet`-style helpers already handle both syntaxes for free.

## Judgment calls (decided here, documented in contracts.md on completion)

1. **`block` entity keying: project-wide by namespace** (block.json's
   `name` field), not per-callsite. Mirrors `hook`/`shortcode`'s own
   precedent — WordPress's block registry is namespace-unique (one
   canonical registration), same shape as a shortcode tag, not a
   per-callsite identity like `ui_element`/`ui_screen`.
2. **`DEFINED_IN`'s target is a new, lightweight `block_manifest` entity**
   representing the specific `block.json` file (`kind = 'block_manifest'`,
   keyed project-wide by path, generic naming — same non-`ui_`-prefixed
   treatment as `document`, since a JSON manifest file isn't itself "a
   rendered UI surface" any more than a markdown file is). This is the
   only way to satisfy `entity_links.dst_id NOT NULL REFERENCES
   entities(id)` for a relation whose spec-named target is a raw file, and
   directly mirrors the `documents` plane's own precedent for exactly this
   situation (see Locate above).
3. **AC-017 reading: no persisted-block-instance entity is created in this
   phase, at all.** REQ-024's own text ("MUST NOT attempt to resolve...")
   and EDGE-014 both scope persisted content out of Increment 1B
   entirely. AC-017's own "(if any)" is read as: `find_ui_element`/
   `resolve_ui_reference` simply never surface a result for persisted
   content, because nothing was ever indexed for it — the assertion passes
   trivially, by construction, not by adding a `data_owned`-writing
   mechanism. Verified before finalizing (see Gate/Code below): the
   existing `ui_element` extractors (`phpElements.js`/`phpWpPrimitives.js`)
   only ever walk *PHP source*, never `wp_posts.post_content` (which this
   indexer has no access to at all — no DB connection into a target WP
   site, only static source files) — so a `<!-- wp:button -->` HTML
   comment sitting in post content literally cannot reach any extractor.
   No writer for `data.resolution_status = "data_owned"` is added by this
   phase.
4. **Scope of `register_block_type()` recognition**: two-positional-arg
   PHP-array form only (AC-016's own required minimum) — first arg
   resolved via a `__DIR__`/`.`-concat/bare-literal walk (Q-003-bounded,
   modeled on `resolveLiteralArg`'s concatenation walk but purpose-built
   for a *path* fragment, not text), second arg's `'render_callback'` key
   resolved via the existing `resolveCallable()` rule set. Explicitly NOT
   covered: `register_block_type_from_metadata()` (different function
   name), block.json's own `"render"` field, a bare `namespace/block-name`
   single-arg form. Documented as scope, not silently dropped.

## Code, file by file

1. **New `src/ui/blockManifest.js`** — `readBlockManifest(absolutePath) ->
   {name, title, category, textdomain} | null`. Pure I/O, no
   module-level state (mirrors `i18nCatalog.js`). Returns `null` (never
   throws) on a missing file, invalid JSON, or a missing/non-string
   `name` field.

2. **New `src/ui/phpBlocks.js`** — 7th sibling PHP extractor, same
   `stripQuotes`/`resolveCallable`/`positionalArgs` duplication precedent.
   `extractPhpBlocks(source) -> {dirArg, renderCallback, owner, line}[]`.
   `dirArg` is the resolved literal path *fragment* (relative to this
   file's own directory — resolving the rest of the way, and reading the
   actual `block.json`, is `src/indexer.js`'s job, since only it knows
   this file's `rel` path and the project `root`). A call site whose first
   argument isn't resolvable from syntax alone is skipped entirely (no
   record at all) — same "no fabrication" rule `phpShortcodes.js`'s
   `literalTag()` already applies.

3. **`src/indexer.js`**:
   - Import both new modules.
   - New `writeUiBlockSites(client, project, root, rel, blocks)`: for each
     extracted call site, resolves `dirArg` to a `block.json` path
     relative to the project root (posix-join against `path.posix.dirname(rel)`,
     with `.json`-suffix detection for "the arg already names block.json
     directly"), applies a root-boundary check (rejects an escaped
     `../`-walked path — see "Security" below), calls
     `readBlockManifest()`, and skips the call site entirely if no
     manifest resolves (no namespace to key an entity on — same
     no-fabrication rule as everywhere else). Writes surviving records as
     `block_site` staging entities, same tombstone-then-upsert lifecycle
     as `writeUiShortcodeSites()`.
   - New `resolveBlockGraph(project, log)`: upserts/tombstones
     `block_manifest` (by path) and `block` (by namespace) entities from
     live `block_site` rows, then recomputes `DEFINED_IN`
     (block -> block_manifest, unique-namespace-to-path match only) and
     `RENDERED_BY` (block -> symbol, same-file-only, mirroring
     `resolveShortcodeGraph()`'s own `RENDERED_BY` SQL shape) from
     scratch. Same call position as `resolveShortcodeGraph()` (right
     after it, before `resolveUiRelations()`).
   - Wire the per-file call site into the existing `config.uiEnabled &&
     lang === "php"` block, after the shortcode extraction call.
   - Wire the project-wide call site into `runIndex()`, after
     `resolveShortcodeGraph()`.
   - Extend `dropFile()`'s tombstone `kind IN (...)` list with
     `block_site`.
   - Add `blocks` to the final `stats` return object.

4. **Fixture**: `test/fixtures/wordpress-ui/wp-content/plugins/waycontext/`
   — add `build/block.json` (declaring `"name": "waycontext/pricing"`,
   matching AC-016's own worked example almost verbatim) and a PHP
   registration call, reusing the shared fixture per 1A-9/1B-1's own
   instruction rather than building a new one. Namespace kept as
   `waycontext/pricing`, not colliding with the `wc-members` /
   `waycontext` route-scoring concern (blocks aren't exposed to any route/
   text search signal this phase touches — see contracts.md note below).

5. **Tests**: `test/ui.phpBlocks.test.js` (pure extractor unit tests, no
   DB) + `test/indexer.uiBlocks.test.js` (real-DB end-to-end, no mocking,
   same convention as `test/indexer.uiShortcodes.test.js`) + one AC-016
   test appended to `test/uiIntelligence.acceptance.test.js` against the
   shared `wp_ui_fixture` project + a short AC-017 verification (no
   persisted-instance entity/result is ever produced).

## Security note (Gate-relevant)

Reading `block.json` from disk based on a parsed path fragment is the one
place in this whole feature where *parsed source text* drives a
filesystem read of a file other than the one already being indexed.
Mitigation: after resolving+normalizing the candidate path, reject it
(skip the call site, no entity) if it normalizes outside the project
root (a leading `..` segment). This closes the only otherwise-open
escalation (a crafted `__DIR__ . '../../../../etc/passwd'`-shaped
argument) without adding scope — a plain boundary check, not a new
subsystem.

## Gate — re-check risk against reality

Six dimensions, re-scored after Locate:

- **Reversibility (was 0)**: still 0. Purely additive `entities`/
  `entity_links` writes, gated by `config.uiEnabled`, same tombstone
  discipline as every sibling. No schema migration, no destructive
  operation.
- **Security surface (was 0)**: stays low, but not literally zero — see
  "Security note" above. This is a *new* kind of read (parsed-source-text
  drives a second file read) that no prior UI-Intelligence phase did, so
  it deserved fresh scrutiny; the mitigation (root-boundary check) is a
  contained, cheap fix, not a sign the surface is actually large. The
  path is entirely local-filesystem, read-only, and only reachable from a
  project the operator already chose to index (the same trust boundary
  every other parsed-source-derived write in this codebase already
  operates inside). Does not move to "high."
- **Concurrency (scored 1 upfront)**: confirmed same as every other
  project-wide post-pass — runs inside the existing per-project
  `pg_advisory_lock(project.id)` `resolveShortcodeGraph()`/
  `resolveHookGraph()` already rely on. No new primitive. Stays 1, not
  escalated.
- **Blast radius (was 0)**: stays 0. New entity kinds (`block`,
  `block_manifest`, `block_site`) and one new relation name (`DEFINED_IN`)
  are additive; nothing existing is read, deleted, or reinterpreted.
  `RENDERED_BY`'s shape is reused verbatim, not redefined.
- **New infra/dependencies (was 0)**: stays 0. `JSON.parse` is a
  built-in; no new npm dependency (unlike 1A-4's `gettext-parser`, which
  was justified by there being no existing parser — here there's nothing
  to parse but plain JSON).
- **Spec ambiguity (scored 1 upfront)**: resolved, not deepened. The two
  real judgment calls the phase brief flagged (entity keying, DEFINED_IN's
  target shape) both had a clean precedent to lean on once Locate found
  them (`hook`/`shortcode` for keying, `document` for a file-as-relation-
  target). AC-017's "(if any)" reading is a straightforward "verify no
  extractor path could accidentally surface persisted content" check, not
  a new mechanism to build. Nothing here surfaced a hidden coupling or a
  bigger-than-expected scope the upfront pass didn't already anticipate.

**No dimension moved to "high." Proceeding to Code — not escalating.**
