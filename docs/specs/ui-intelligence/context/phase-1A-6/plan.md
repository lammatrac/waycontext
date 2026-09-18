# Phase 1A-6 plan — UI-specific post-pass orchestration (THE CHECKPOINT PHASE)

## Spec slice cross-check against contracts.md

Everything the slice names is already defined in contracts.md, confirmed by
reading all five dependency phases' sections in full plus `src/indexer.js`
directly:

- Pipeline order (verified fresh, not trusted from the brief): in the real
  `src/indexer.js`, `resolveHookGraph()` (1A-3) and `resolveI18nGraph()`
  (1A-4) run at lines ~502/523, **before** `reconcileIdentity()` at line 568.
  `runIdentityPreflight()` (1A-5) runs immediately after `reconcileIdentity`
  (lines 580-600), storing its result in the local `identityPreflight` and
  in the returned stats object. The slot right after that block (line 601,
  before `let history = null;`) is open — this is where my post-pass call
  goes. Matches 1A-5's own contracts.md note exactly; no further drift found.
- `identityPreflight` handoff shape (`{complete, backfillRan, backfillResult,
  diagnostics[]}` or `null` when `config.uiEnabled` is false) — read directly
  from `src/indexer.js:774-786` return statement. Confirmed.
- `UI_IDENTITY_INCOMPLETE` diagnostic shape (5 fixed keys) — read
  `identityIncompleteDiagnostic()` at `src/indexer.js:798-812`. Confirmed.
- `ui_element` / `ui_screen` / `ui_settings_section` / `ui_settings_field`
  shapes and existing `REGISTERED_AT`/`RENDERED_BY`/`TRANSLATION_OF`/
  `TRANSLATION_USED_AT`/`LISTENS_TO`/`FIRED_BY` relations — read
  `writeUiElements`, `writeUiWpPrimitives`, `resolveHookGraph`,
  `resolveI18nGraph` directly (`src/indexer.js:885-1110`, `1267-1354`,
  `1413-...`). All match contracts.md's descriptions.
- `entities`/`entity_links` schema — read `src/migrations/0006_identity_and_history.sql`.
  Key facts that shape this plan:
  - `entities`: `UNIQUE(project_id, kind, natural_key)`, free-text `kind`
    (no CHECK constraint) — a new `kind` value needs no migration.
  - `entity_links`: `src_id`/`dst_id` are `BIGINT NOT NULL REFERENCES
    entities(id)` — **no relation row can ever point at nothing.** This
    directly shapes the `unresolved` handling below (see "Gate" and
    "resolution_status" sections) — REQ-027's "mark unresolved" cannot mean
    "write a link with a null target"; it has to mean something recorded on
    the *source* entity's own `data`.
  - `entity_links.data` is a JSONB column (default `{}`) — available for
    `resolution_status`/`ownership` annotations on relation rows.

## Reality check the brief's assumptions didn't fully cover

1. **`do_settings_sections()` cross-file completion has no staged data to
   read.** 1A-2's contracts.md says it "completes the cross-file case" is
   1A-6's job, but 1A-2 only ever recorded `rendered_at` for a **same-file**
   `do_settings_sections($page)` call — a cross-file call site is silently
   dropped by 1A-2 (never staged anywhere). There is nothing in the DB today
   for a project-wide post-pass to read for the cross-file case. To
   "complete" it at all, this phase must add a **new sibling extractor**
   (`src/ui/phpSettingsRender.js`, following the exact
   `phpHooks.js`/`phpI18nCalls.js` precedent: independent tree-sitter-php
   walk, pure/DB-free, literal-`$page`-only) plus a new internal-only
   staging entity kind (`settings_render_site`, same status as
   `hook_site`/`i18n_call_site` — never MCP-facing), written per-file in the
   same gated block `src/indexer.js:327-374` already uses for the other four
   PHP UI extractors, tombstoned the same way.
2. Given the schema's `NOT NULL` FK on `entity_links.dst_id`, "mark
   `unresolved`" (REQ-027) is implemented as a field on the **owning UI
   entity's own `data`**, not as a partial/null relation row. See
   "resolution_status" below.

## Gate — risk re-check against reality

Upfront score: 1/0/1/2/0/1 (total 5, checkpoint on Blast=2).

- **Reversibility (1, unchanged).** All new writes follow the exact
  recompute-in-full pattern `resolveHookGraph()`/`resolveI18nGraph()`
  already established (delete this project's own rows for the relations I
  own, reinsert from current state) — idempotent across repeated runs, same
  as those two phases.
- **Security (0, unchanged).** No new external input, no new dependency, no
  network/file access beyond what 1A-1..1A-4's extractors already do.
- **Concurrency (1, unchanged).** Runs inside the same per-project
  `pg_advisory_lock(project.id)` every other project-wide pass in
  `runIndex()` already relies on (confirmed by reading
  `src/indexer.js:99-106` again). The new per-file extraction step
  (`settings_render_site`) runs inside the same per-file transaction the
  other four PHP UI extractors already use — no new concurrency primitive.
- **Blast radius (2, unchanged — already at max, this is why it's the
  checkpoint).** Scope is larger than "just add one post-pass function call"
  — it also adds one more per-file extraction step to the shared loop. This
  is still within the checkpoint's already-assumed shape ("the shared
  `index_project` pipeline stage every later phase builds on"): the new
  per-file step follows an exact, already-tested precedent (4 prior sibling
  extractors use the identical shape/lifecycle/try-catch), not a new
  mechanism. Does not push this dimension to a new level.
- **New infra (0, unchanged).** No new npm dependency.
- **Spec ambiguity (1, unchanged).** Two explicitly-flagged pending
  decisions (EDGE-006, `resolution_status` enum) are exactly what this phase
  was tasked to resolve — expected work, not new-found ambiguity. The
  `do_settings_sections()` staging gap (above) is a concrete instance of
  work the brief already named ("completing RENDERED_BY for
  `do_settings_sections()`"), solvable with an established, low-risk
  pattern (one more sibling extractor + staging entity) — not a genuinely
  open design question requiring a human call.

**Conclusion: no dimension moved to "high" under closer inspection. Proceed
without escalating.** (If, during implementation, the `ui_component`
materialization or `DEFINED_BY` cross-file resolution had turned out to need
something structurally new — e.g. a schema change, or ambiguity in what
"defines" an element that two reasonable readings would produce
incompatible graphs for downstream 1A-7/1A-8 — that would have been grounds
to stop and escalate. Neither materialized once the actual schema/code was
read.)

## Design decisions (new ground, not a rehash of any prior phase)

### `ui_component` materialization rule

**One `ui_component` entity per distinct `(source_path, owner)` pair that
appears as an `owner` on at least one live `ui_element`, `ui_screen`,
`ui_settings_section`, or `ui_settings_field` row — EXCLUDING the `"@file"`
top-level sentinel.** Always materialized (not just when >1 element shares
an owner): a uniform graph shape (every function-scoped UI entity belongs to
exactly one component, never "sometimes wrapped, sometimes not") is what
lets 1A-7/1A-8 write one traversal instead of branching on cardinality. The
`"@file"` exclusion is principled, not arbitrary: there is no function/class
to represent as a "component" for bare top-level markup, and REQ-020's
`<component_identity>` slot in `element_id`'s own format already treats
`"@file"` as a sentinel meaning "no component," so `ui_component` follows
that same convention rather than fabricating one.

Shape: `kind = 'ui_component'`, `natural_key =
ui:<project_name>:php:<source_path>:<owner>:component` (REQ-020's format,
`<element_fingerprint>` slot filled with the fixed literal `component` since
`(source_path, owner)` is already unique — no content hash needed). `title =
owner`. `data`: `{ component_id, framework: "php", source_path, owner,
ownership }` (`ownership` — see below).

Lifecycle: recomputed in full every project-wide post-pass run (same
cost/simplicity tradeoff `resolveHookGraph()`/`resolveI18nGraph()` already
made and documented) — upsert every currently-referenced `(source_path,
owner)` pair, tombstone any `ui_component` no live UI entity references
anymore. Not tied to one file's per-file tombstone pass, since a
component's liveness depends on the whole project's current UI-entity set.

### Relations this phase writes

- **`RENDERS`** (`ui_component` → `ui_element`): element's `(source_path,
  owner)` matches the component's. Direct string-keyed join, no ambiguity.
- **`DEFINED_BY`** (`ui_element`/`ui_component` → `symbol` entity): the
  entity's own `owner`, resolved to that owner's `symbols.entity_id` in the
  **same file** (owner is always in-file by construction — 1A-1/1A-2 read
  `owner` from the same parse tree as the element). Only written when
  `identityPreflight?.complete === true` *and* the symbol's `entity_id` is
  non-null; see "resolution_status" for the incomplete case.
- **`HANDLED_BY`** (`ui_component` → `symbol` entity): reuses 1A-3's
  already-resolved hook graph rather than reimplementing any hook logic
  (explicit instruction in the brief) — for a component `C`, if `hook_site`
  rows show `C`'s own `(source_path, owner)` **firing** a hook (`direction =
  'fire'`), and that hook's `LISTENS_TO` (already resolved by
  `resolveHookGraph()`) points at some symbol `S`, write `C --HANDLED_BY-->
  S`. Reading: "this component's action is handled by S" — the concrete,
  spec-consistent content for REQ-015's category (D) callout ("plugin-owned,
  covered by REQ-014's hook resolution") applied at the UI-component level.
  `DEFINED_BY` answers "who wrote this markup"; `HANDLED_BY` answers "who
  processes what this component does" — genuinely distinct, not a
  duplicate relation.
- **`CONTAINS`**:
  - `ui_screen → ui_component`: joined through the **shared target symbol
    entity_id** — when a `ui_screen`'s already-resolved `RENDERED_BY` link
    (1A-2, in-file) points at the same symbol a `ui_component`'s
    `DEFINED_BY` link points at, the screen `CONTAINS` that component. This
    sidesteps name-collision ambiguity entirely (both sides already resolve
    to the same unique `entity_id`, no fresh string matching needed).
  - `ui_component → ui_settings_section`/`ui_settings_field`: via the new
    `settings_render_site` staging entity (see "Reality check" above) —
    when a live render site's `(source_path, owner)` matches a component,
    and a live settings section/field's `page` matches the render site's
    `page`, link component `CONTAINS` section/field. Same-page string
    matching, "unique match only" discipline (skip on ambiguous multi-match,
    same rule `resolveHookGraph()`'s `LISTENS_TO` already applies).
  - `ui_screen → ui_settings_section`/`ui_settings_field` (flattened,
    convenience hop for 1-hop screen-scoped queries): written whenever the
    component-level link above exists AND that same component is also
    `CONTAINS`'d by a screen (transitive flattening, same reasoning as
    `RENDERED_ON` below).
  - `ui_settings_section → ui_settings_field`: field's `(page, section)`
    matches section's `(page, section_id)`, project-wide, unique-match only.
- **`RENDERED_ON`** (`ui_element → ui_screen`): flattened from `ui_screen
  --CONTAINS--> ui_component --RENDERS--> ui_element` — for every element
  whose owning component is `CONTAINS`'d by a screen, write a direct
  `ui_element --RENDERED_ON--> ui_screen` link. This is REQ-006's own ask
  ("associated with the Screen(s) it belongs to, so a query can be scoped by
  screen") answered without forcing every caller through a 2-hop traversal.

### EDGE-006 — one entity, many `RENDERED_ON` links (decided)

A `ui_element`/`ui_component` reused across several screens (a shared
renderer function invoked by more than one `add_menu_page`/
`add_submenu_page()` registration) gets **one entity, multiple `RENDERED_ON`
links** — not a duplicated entity per screen. Reasons: (1) `element_id`'s
durable natural key (REQ-020) is defined by `(source_path, owner,
fingerprint)`, independent of which screen(s) invoke the owning renderer —
duplicating the entity per screen would require inventing a second,
incompatible key format not sanctioned by REQ-020. (2) `entity_links`'
`UNIQUE(src_id, relation, dst_id)` constraint already supports multiple
`RENDERED_ON` rows from one `src_id` to different `dst_id`s natively, with
zero extra schema work. (3) Any hook/i18n links already attached to that
one element's content stay singular and correct; per-screen duplication
would either fork them too (extra bookkeeping, no informational gain) or
leave them oddly attached to only one of several duplicate rows.

### `resolution_status` enum (decided, closed)

Five values, meaning fixed here for every later phase to test against:

| value | where it lives | meaning |
|---|---|---|
| `resolved` | `entity_links.data.resolution_status` | target found via an exact, unambiguous signal (shared entity_id, or unique name/page match). Default for effectively every link this phase writes. |
| `partial` | `entity_links.data.resolution_status` | target found via a weaker heuristic where more than one interpretation existed but a best-effort pick was recorded as such. **Not produced by any relation 1A-6 writes** (Increment 1A's PHP-only scope never needed it) — reserved for 1A-7/1B work already named in the spec (EDGE-003/Q-013). |
| `unresolved` | source entity's own `data.resolution_status` (e.g. `ui_element.data`, `ui_component.data`) | a relation conceptually applies but couldn't be completed because `identityPreflight?.complete !== true` at index time. **Never written as a relation row** — `entity_links.dst_id` is `NOT NULL`, so there is no relation to "mark"; the gap is recorded on the entity that would have had the link. A later run, once identity is backfilled, recomputes in full and upgrades this to `resolved`. |
| `unknown_render` | source entity's own `data.resolution_status` | identity was complete and resolution was attempted, but no candidate target exists anywhere in the current graph (e.g. an element's owning function is never used as any screen's renderer, or any settings render site's owner). Distinct from `unresolved`: this isn't a transient identity gap, there's genuinely nothing to link yet. |
| `data_owned` | entity's own `data.resolution_status` | reserved, written only by 1B-2 (REQ-015 category C — persisted/dynamic content). Not produced anywhere in this phase; documented here so 1B-2 doesn't invent a second name for the same idea. |

Practical note: this phase only ever writes `resolved` on `entity_links`
rows it creates (every relation above requires an exact match by
construction to be written at all — no "write a link with lower confidence"
path exists in 1A's scope). `unresolved`/`unknown_render` appear on the
owning entity's `data.resolution_status` field, merged in without disturbing
other `data` keys (`data || jsonb_build_object(...)`, same merge pattern
`src/indexer.js`'s existing symbol-entity upsert already uses at line ~303).

### REQ-013 ownership/framework classification

`classifyOwnership(sourcePath)`: `framework` when the path contains
`wp-admin/`, `wp-includes/`, or `vendor/` as a path segment (leading or
`/`-bounded), else `application` — exactly the heuristic contracts.md's
"Fixed by the spec" section already fixed. Implemented as a single SQL
`CASE`/`LIKE` expression (not per-row JS), applied in one `UPDATE` per live
UI-graph kind this phase touches (`ui_element`, `ui_screen`, `ui_component`,
`ui_settings_section`, `ui_settings_field`), merging `data.ownership` in
without disturbing other fields. Also recorded on every `DEFINED_BY`/
`HANDLED_BY` link's own `data.ownership` (classifying the **target**
symbol's file) so 1A-8 can implement REQ-013's "report the framework
renderer as `not_relevant`" behavior directly from relation data, without
re-deriving path classification itself.

Noted for context, not a design decision: `vendor/**` is already in
`src/indexer.js`'s `DEFAULT_IGNORES` for the project glob walk, so in
practice very little `vendor/`-owned code is ever indexed as symbols/UI
entities to begin with — the classifier still exists for `wp-admin/`/
`wp-includes/` (not ignored by default) and for a project whose own
`.gitignore` doesn't exclude `vendor/`.

### REQ-015 category A/B/D distinction

Implicit in the above, not a separate mechanism: category (A) code-owned =
`ownership: "application"` on the resolved `DEFINED_BY`/`HANDLED_BY` target;
category (B) framework-owned = `ownership: "framework"` there; category (D)
plugin-owned = already fully covered by 1A-3's `LISTENS_TO`/`FIRED_BY` graph
(consumed, not rebuilt, via the `HANDLED_BY` derivation above). Category (C)
data-owned is explicitly not attempted (REQ-015) — `resolution_status:
"data_owned"` stays reserved/unused in this phase, per the enum above.

## Files touched

- `src/ui/phpSettingsRender.js` (new) — `extractPhpSettingsRenderSites(source)
  -> {page, owner, line}[]`, recognizes `do_settings_sections($page)` calls,
  literal `$page` only. Same tree-sitter-php sibling-extractor shape as
  `phpHooks.js`/`phpI18nCalls.js`.
- `src/indexer.js`:
  - new import for the above.
  - one more per-file extraction+write call inside the existing
    `config.uiEnabled && lang === "php"` block (`writeUiSettingsRenderSites`),
    wrapped in its own try/catch (REQ-021).
  - `dropFile()`'s tombstone `UPDATE ... WHERE kind IN (...)` list gains
    `settings_render_site`.
  - new project-wide post-pass function `resolveUiRelations(project, log)`,
    called once after the `identityPreflight` block, gated by
    `config.uiEnabled`, wrapped in try/catch (own failure must not fail the
    index — REQ-021), with each internal step (component materialization,
    DEFINED_BY, HANDLED_BY, CONTAINS, RENDERS, RENDERED_ON, ownership
    classification) in its own try/catch so one failing step doesn't take
    down the others, matching the existing convention at
    `src/indexer.js:457-492`/`:616-627` the brief points at.
  - `runIndex()`'s returned stats gains a new `uiRelations` field.
- `docs/specs/ui-intelligence/contracts.md` — new dated "Phase 1A-6"
  section; mark EDGE-006 and `resolution_status` resolved in "Pending
  cross-phase decisions".
- `docs/specs/ui-intelligence/manifest.md` — flip 1A-6's `Status` to `done`.
- New test file `test/indexer.uiRelations.test.js` (real-DB, no mocking,
  following `indexer.uiHooks.test.js`'s pattern) plus
  `test/ui.phpSettingsRender.test.js` (pure extractor unit tests, following
  `ui.phpHooks.test.js`'s pattern).

## What I will NOT do (explicitly out of scope)

- Not rebuilding `LISTENS_TO`/`FIRED_BY` (1A-3), `TRANSLATION_OF`/
  `TRANSLATION_USED_AT` (1A-4), or in-file `REGISTERED_AT`/`RENDERED_BY`
  (1A-2) — only consuming them.
- Not attempting generic cross-file `REGISTERED_AT`/`RENDERED_BY` completion
  beyond the `do_settings_sections()` case explicitly named in the brief —
  `REGISTERED_AT` can never legitimately be cross-file (a registration
  call's enclosing function is always in that call's own file by
  construction), and expanding `RENDERED_BY` completion further than what's
  named risks unscoped growth on the one phase everyone is told to be most
  careful about.
- Not building `match_score`/resolver (1A-7), MCP operations (1A-8), or any
  Increment 1B (shortcode/block) work.
- Not writing `resolution_status: "data_owned"` anywhere (reserved for
  1B-2).
