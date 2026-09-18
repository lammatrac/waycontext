# Phase 1A-3 plan — Hook graph as first-class entities

## Spec / contracts check

- REQ-014, REQ-026, EDGE-012 (verbatim in the phase brief) reference no name
  or shape not already fixed in contracts.md: `entities`/`entity_links` as
  the only storage plane (REQ-019), generic (non-`ui_`) kind naming for
  engineering concepts (REQ-025/Q-018/D-UI-018), and the no-fabrication rule
  (REQ-026 itself). Nothing missing.

## Locate

- `src/parser.js:221-233` — current behavior: `add_action`/`add_filter`/
  `add_shortcode` all produce a `REGISTERS_HOOK` edge with
  `dst_name = "hook:<name>"`; `do_action`/`apply_filters`/`do_shortcode`
  produce `FIRES_HOOK` the same way. `dst` is never resolved (no symbol is
  ever named `hook:<name>`), and hooks and shortcodes are indistinguishable
  in this table (same relation name covers both). This rules out reading
  `edges` as the data source for `hook` entities without also picking up
  shortcodes.
- `src/indexer.js` per-file loop (~line 320-345 before this phase): PHP UI
  extraction gated by `config.uiEnabled && lang === "php"`, already calling
  two sibling pure extractors (`extractPhpUiElements`,
  `extractPhpWpPrimitives`) and writing their output via
  `writeUiElements`/`writeUiWpPrimitives` inside the same per-file
  transaction as symbols/edges.
- `src/indexer.js:408-463` (pre-phase line numbers) — the existing
  project-wide `edges` resolution passes, including the "only unique matches
  are linked" discipline for the namespace-suffix pass. Reused as the model
  for this phase's LISTENS_TO resolution.
- `src/indexer.js:496` (pre-phase) `reconcileIdentity()` call — the existing
  project-wide post-pass positioned after per-file work and edge resolution.
  Model for where `resolveHookGraph()` should run.
- `src/ui/phpWpPrimitives.js` — precedent for a sibling pure/DB-free
  tree-sitter-php extractor, `resolveCallable()`'s exact rule set (used
  verbatim here), and the "duplicate small helpers rather than export from a
  frozen file" convention (contracts.md "Phase 1A-2 module boundary").
- `src/migrations/0006_identity_and_history.sql` — `entities`
  `UNIQUE(project_id, kind, natural_key)`; `entity_links`
  `UNIQUE(src_id, relation, dst_id)`, both FKs `NOT NULL`. Confirms no
  "pending/unresolved" column exists on `entity_links` (unlike `edges.dst`
  vs `edges.dst_name`) — a deferred/staged design is required for anything
  that can't resolve immediately.
- `pool.query("SELECT pg_advisory_lock(...)")` in `indexProject()` — confirms
  concurrent `index_project` runs on the same project are already serialized,
  which bounds this phase's concurrency risk to "within one run", not
  cross-run races.

## Design decision: `hook_site` staging entities + one project-wide post-pass

Considered and rejected: reading `edges`' existing `REGISTERS_HOOK`/
`FIRES_HOOK` rows as the source of hook call sites (conflates hooks with
shortcodes, see Locate above) and re-parsing every PHP file at post-pass
time (redundant work, no incremental benefit).

Chosen: a third sibling extractor (`src/ui/phpHooks.js`) recognizing only
`add_action`/`add_filter`/`do_action`/`apply_filters` (not
`add_shortcode`/`do_shortcode`), written per-file as `kind='hook_site'`
staging entities (internal-only, not spec-facing, tombstone-then-upsert by
`source_path` exactly like `ui_element`). A single project-wide post-pass,
`resolveHookGraph()`, runs once per `index_project` job (after the existing
edges-resolution block, same neighborhood as `reconcileIdentity()`) and:

1. Upserts one `hook` entity per distinct hook name any live `hook_site`
   references (natural_key keyed by name alone, project-wide — unlike every
   other `ui_*`/`hook_site` entity, which is keyed per call site).
2. Tombstones a `hook` entity once no live `hook_site` references it.
3. Recomputes `LISTENS_TO`/`FIRED_BY` in full (delete then reinsert) rather
   than diffing incrementally.
   - `FIRED_BY`: matched same-file only (the firing owner is always
     resolvable in its own file — no cross-file join needed for this
     direction).
   - `LISTENS_TO`: matched project-wide by exact `symbols.name`, mirroring
     the existing namespace-edge-resolution pass's "only a unique match is
     linked" rule. This is EDGE-012's actual cross-file requirement.

Full write-up, rationale, and known limitations: `contracts.md` § Phase
1A-3.

## Files to change

- New: `src/ui/phpHooks.js` (pure extractor).
- New: `test/ui.phpHooks.test.js` (unit tests, mirrors
  `test/ui.phpWpPrimitives.test.js`'s style).
- New: `test/indexer.uiHooks.test.js` (integration test, mirrors
  `test/indexer.uiWpPrimitives.test.js`'s style; covers EDGE-012's
  cross-file scenario and REQ-026's no-fabrication case).
- `src/indexer.js`:
  - import `extractPhpHooks`
  - call it + `writeUiHookSites()` inside the existing per-file
    `config.uiEnabled && lang === "php"` block
  - new `writeUiHookSites()` function
  - new `resolveHookGraph()` function, called once per run, gated by
    `config.uiEnabled`
  - `dropFile()`'s tombstone kind list extended with `'hook_site'`
  - `runIndex()`'s return object gets a new `hooks` field
- `docs/specs/ui-intelligence/contracts.md` — new dated section.
- `docs/specs/ui-intelligence/manifest.md` — phase 1A-3 row status.

## Gate re-check (see review.md for the actual re-score)

Concurrency/blast-radius risk raised by the manifest is bounded by: (a) the
existing advisory lock already serializing `index_project` runs per project,
and (b) this phase touching only `kind IN ('hook','hook_site')` entities and
`relation IN ('LISTENS_TO','FIRED_BY')` links — no write to `symbols`,
`edges`, or any other `ui_*`/`entities` kind.
