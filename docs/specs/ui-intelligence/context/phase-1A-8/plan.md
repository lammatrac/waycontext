# Phase 1A-8 plan — Five MCP operations

## Spec / Locate

- REQ-012 (spec.md L398-408), § 6.2.3 Interface Contract (L839-883), EDGE-010
  (L1164-1170).
- Depends on 1A-7 (`src/ui/referenceResolver.js`: `resolveUiReference`,
  `scoreCandidate`, `canonicalElementType`, `textSimilarity`,
  `SIGNAL_WEIGHTS`, `MIN_MATCH_SCORE`, `MAX_CANDIDATES`) and 1A-6 (the
  resolved UI graph: `ui_component`, `RENDERS`/`DEFINED_BY`/`HANDLED_BY`/
  `CONTAINS`/`RENDERED_ON`, `ownership`, `resolution_status` enum).
- Registry: `src/operations.js` (single source of truth for MCP/CLI/HTTP),
  `src/mcpServer.js` (registers each op as an MCP tool, `readOnlyHint` from
  `op.readOnly`).
- Read `src/graph.js` for the established conventions this phase must match:
  `requireProject`/`requireSymbol`/`requireFile` throw on a bad specific
  identifier; `getCallers`/`getCallees`/`getSubgraph` read `edges`/`symbols`
  directly and are the "existing call graph traversal" 1A-8 must reuse for
  trace_ui_action's "onward through the existing call graph", not
  reimplement.
- Read `src/backfillIdentity.js`/migration 0006 to confirm how a `symbol`
  entity's `entities.id` maps back to `symbols.name`/`start_line`/`path`
  (join on `symbols.entity_id`) -- needed to turn a `DEFINED_BY`/
  `HANDLED_BY`/`RENDERED_BY`/`REGISTERED_AT` link's target into a real
  file/line the caller can act on.

Nothing referenced by the spec slice was missing from contracts.md.

## Plan

New module `src/ui/uiQueries.js` (sibling to `referenceResolver.js`, same
DB-aware-query convention): five exported operation functions plus internal
query helpers (`requireUiEntity`, `outgoingSymbolLinks`/`outgoingEntityLinks`/
`incomingEntityLinks`, `firedHooksBySymbol`/`listensToHooksBySymbol`). No
writes anywhere in this module -- verified by absence of INSERT/UPDATE/DELETE.

Wired into `src/operations.js` as five new registry entries (`readOnly:
true`), each with a CLI `args` list covering every input field (required
by `test/operations.test.js`'s "every input field is reachable from the
CLI" invariant) and an alias (`ui-resolve`/`ui-find`/`ui-context`/`ui-trace`/
`ui-source`).

`src/completion.js` needed a new `OP_HELP` entry per operation and a new
`SECTIONS` entry (`ui`) -- an existing, generic invariant
(`test/completion.test.js`) requires every registry operation to have a help
section/gloss; missed this on the first pass, caught by the full suite run,
fixed by adding the section/glosses and regenerating
`test/fixtures/help.txt`.

## Key design decisions (see contracts.md "Phase 1A-8" for full reasoning)

1. **`readOnly`**: all five are `true`, matching every other pure-read
   operation in `src/operations.js` (no source contradicts this; NOTE
   [MISSING] in the spec).
2. **Authorization**: left unaddressed -- no operation in this registry
   declares one today, so this phase does not invent a first instance.
3. **Error vs. status-field convention**: `resolve_ui_reference`/
   `find_ui_element` follow 1A-7's own convention (a real error only for a
   bad `project` or a missing task_text/hint combo; "nothing matched" is
   `status: "not_found"`). `get_ui_context`/`trace_ui_action`/
   `find_ui_source` take a specific `element_id`, matching `graph.js`'s
   `requireSymbol`/`requireFile` pattern -- an unresolvable `element_id`
   throws, the same as an unresolvable symbol name does elsewhere in this
   codebase.
4. **`get_ui_context`'s shape** (spec NOTE [AMBIGUOUS]): composes the
   element's own data, its `ui_component` (via `RENDERS`), the screen(s) it
   renders on, its component's `HANDLED_BY` target (hook named via the
   public `FIRED_BY` graph, never via the internal-only `hook_site`), and
   its i18n key -- the already-resolved 1A-6 graph, one hop out, distinct
   from `trace_ui_action`'s onward call-graph walk.
5. **`trace_ui_action`**: element/component -> `HANDLED_BY` (or settings
   field/section -> `RENDERED_BY`) -> `getSubgraph(project, symbolName, 2)`
   for "onward through the existing call graph" -- reuses `src/graph.js`
   unmodified.
6. **`find_ui_source`'s "entry hook"**: uses `LISTENS_TO` (is the
   registering symbol itself a hook callback?), which is the *opposite*
   direction from the `FIRED_BY`-based hook naming `get_ui_context`/
   `trace_ui_action` use for the `HANDLED_BY` chain (does this symbol *fire*
   a hook?). Caught and fixed before finalizing tests -- see contracts.md.
7. **`resolve_ui_reference`/`find_ui_element` candidate enrichment**: adds
   `resolution_status`/`limitations`/`source`/`application_source`/
   `not_relevant` (all cheap, from data already on the candidate or one
   small batched query bounded by MAX_CANDIDATES=5); `handler`/`api`/
   `styles` stay `null`/`[]` -- populating `handler` for every candidate on
   every search call would mean `trace_ui_action`'s queries times 5 on a
   fast-path tool; a caller wanting that calls `trace_ui_action` on the
   candidate it picks.
8. **`status: "ok"|"not_found"|"partial_match"`**: a documented, unscored
   threshold (top score must clear the runner-up by >= 0.15) -- not derived
   from any contracts.md value, recorded so a later phase can retune it.
9. **EDGE-010 (staleness)**: resolved -- stay silent, matching
   `search_code`/`get_symbol`/every other line-number-returning operation in
   this codebase, none of which flags staleness either. Adding a
   staleness signal only for UI results would be an unrequested, isolated
   embellishment inconsistent with the rest of the query surface.

## Gate

Re-scored after Locate/Plan: no dimension moved to "high". The registry
pattern (`src/operations.js`) is exactly as bounded as every prior addition
to it -- five more entries, no change to the registry's own mechanics.
`uiQueries.js` is pure `SELECT`-only (verified), reuses `getSubgraph`
unmodified (bounded depth=2, existing default), and never reads the
internal-only staging kinds. The one real risk the upfront score named
(blast radius, since `src/operations.js` is shared by every MCP/CLI/HTTP
consumer) stayed additive-only: existing operations/tests are untouched
except for two accurate, mechanical fixture updates (`completion.js`
OP_HELP/SECTIONS, `test/fixtures/help.txt`) that a full-suite run demanded.
No new infra, no new writes, no new concurrency surface. Proceeded without
escalating.
