# Phase 4 plan — Documentation Agent: WayContext understanding & outline generation

## Spec slice read
REQ-005 (L145-151), REQ-006 (L152-159), AC-004 (L664-672), EDGE-005 (L549-557),
Q-002 (L809-818) and its proposed resolution (L909-915).

## What this phase owns
Q-002: what determines a workflow "deserves a tutorial." Working default per
§19.1: no new business-entity extraction; derive candidates from WordPress
UI-index output already produced by WayContext (`find_ui_element`,
`get_ui_context`, `resolve_ui_reference`, `find_ui_source`), propose as an
outline, gate on human sign-off before recording (Phase 9's job, not this
phase's).

## Locate findings (binding on the design)
Read `src/ui/uiQueries.js` (operations backing `find_ui_element`,
`get_ui_context`, `resolve_ui_reference`, `trace_ui_action`,
`find_ui_source`) and `src/operations.js` (their MCP tool registration) in
the main `waycontext` project.

**Gap found, not visible from the spec slice text alone:** none of the five
UI-index MCP tools enumerate/list UI screens or elements. All five are
*resolve-by-hint* or *lookup-by-id* operations:
- `find_ui_element(text, screen?)` / `resolve_ui_reference(task_text?,
  screen?, text?, role?)` — require a text/hint input, return ranked
  candidates (fields include `element_id`, `match_score`, `ownership`).
- `get_ui_context(element_id)`, `find_ui_source(element_id)`,
  `trace_ui_action(element_id)` — require an already-known `element_id`.

There is no "list every ui_screen/ui_element in this project" tool (checked
`get_modules`/`get_project_overview` too — directory/symbol-level only, no
UI entities). §19.1's resolution text ("derive the candidate workflow list
from WordPress UI structure already extracted by find_ui_element/
get_ui_context") reads as if these tools can enumerate; in the code as
built, they cannot — they can only *confirm/rank* a hinted candidate.

**Gate re-check:** this doesn't newly elevate Blast radius, Security,
Concurrency, or Reversibility (module stays additive/isolated inside
`services/waydocs-ai/`, calls only read-only WayContext tools). New infra
and Ambiguity were already scored at their ceiling (1 and 2) for this
phase precisely because Q-002 was flagged spec-wide as the least-settled
part of the design — this finding sharpens *what* the ambiguity is but
doesn't introduce a new high-risk dimension the upfront pass missed. Not
escalating; proceeding with a documented, narrower design (see below),
consistent with how Phase 2/3 handled in-phase deviations from §19.1's
literal wording without escalating.

## Design decision
1. **Pure grouping/formatting core**, testable with fixture data shaped
   exactly like the real `find_ui_element`/`resolve_ui_reference` candidate
   objects (`element_id`, `match_score`, `ownership`, ...) — no live MCP
   connection needed for this half.
2. **Thin async orchestration layer** that takes an injected WayContext UI
   client (duck-typed: `findUiElement`, `getUiContext`) and a list of
   *operator/config-supplied seed hints* (`{ section, workflow, text,
   screen? }`) — since automatic enumeration isn't available, v1 discovery
   is seed-driven confirmation against WayContext, not full auto-discovery.
   This keeps REQ-005's "MUST use WayContext... before any blind browser
   exploration" and AC-004 satisfied: zero direct browser calls, every
   candidate is grounded in a WayContext query; nothing here drives
   Playwright.
3. Every resolved candidate is filtered to `ownership === "application"`
   (excludes WordPress-core/framework-owned elements, mirroring
   `find_ui_source`'s `not_relevant` signal) — this is the false-positive
   control. Seeds with no application-owned match become a recorded "miss"
   — human-reviewable at Phase 9's outline-approval gate (EDGE-005), not
   silently dropped.
4. Bridge into Phase 2's `runStore`: `runOutlineStage(runId, seeds, {
   client, runsDir })` calls `updateRun(runId, { stage: "outline", outline
   })` — using the `stage` convention Phase 2's contract already reserved
   for this phase, and the `outline` field is a pure additive extension via
   `updateRun`'s patch mechanism (no renames).

## Files
- `services/waydocs-ai/src/outline/outlineGenerator.js` (new)
- `services/waydocs-ai/test/outline.outlineGenerator.test.js` (new)

## Contracts this phase adds
- Q-002 decision (data source: WayContext UI-index only, seed-driven
  confirmation; miss/false-positive tradeoff).
- `generateOutline`, `formatOutlineText`, `runOutlineStage`,
  `isApplicationOwned` exports and their shapes.
- Outline shape appended to run records (`run.outline`), `stage: "outline"`.

## Browser verification
Not applicable — no HTTP endpoint, CLI command, or UI surface of its own;
an internal analysis/generation module over WayContext's read-only MCP
tools. Verified via `npm test` only.
