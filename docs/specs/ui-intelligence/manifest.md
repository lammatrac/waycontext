# Manifest — UI Intelligence / UI Graph

Spec: `tasks/context/ui-intelligence/spec.md` (1883 lines)
Slug: `ui-intelligence`

## Phase boundary note

The spec's own § 4 "Increment sequencing" (L214-231) fixes the top-level order
— Increment 1A → 1B → 2 → 3 → 4 — and only Increment 1A and 1B carry
Requirements (§5), Acceptance Criteria (§14) and a Testing plan (§15) in this
document; Increment 2/3/4 are named but not specified in enough detail to
implement (§4 "Deferred" / "Out of Scope" tables). This run therefore covers
**Increment 1A and 1B only**. Within each increment there is no finer
milestone list in the spec, so phases below are synthesized by layer
(parser-level extraction → cross-file post-pass/relations → pipeline
orchestration → query/resolver → MCP surface → hardening), per the skill's
fallback rule, ordered to match the dependency chain the spec itself
describes in § 6.2.1's pipeline diagram (L730-750).

No schema migration is required for either increment (Q-001, § 6.2.2,
L1063-1066) — `entities`/`entity_links` are unconstrained `TEXT` + `JSONB`
already. There is therefore no standalone "data/schema" phase.

## Phases

| Phase | Title | Spec range | Depends on | Rev/Sec/Con/Blast/Infra/Amb | Total | Checkpoint | Status |
|---|---|---|---|---|---|---|---|
| 1A-1 | PHP literal-HTML UI element indexer + a11y/identity attrs | REQ-001 L249-259, REQ-002 L261-269, EDGE-009 L1153-1163 | — | 0/0/0/1/0/1 | 2 | no | done |
| 1A-2 | WP UI primitives: `submit_button`, admin menu, Settings API | REQ-016 L463-471, REQ-017 L473-483, REQ-018 L485-495 | 1A-1 | 0/0/0/0/0/0 | 0 | no | done |
| 1A-3 | Hook graph as first-class entities (`LISTENS_TO`/`FIRED_BY`, project-wide, no fabrication) | REQ-014 L426-445, REQ-026 L593-603, EDGE-012 L1179-1188 | — | 1/0/1/1/0/1 | 4 | no | done |
| 1A-4 | WordPress gettext i18n resolution (`TRANSLATION_OF`, `.po`/`.mo`) | REQ-003 L271-283, REQ-004 L285-301, EDGE-004 L1112-1117, EDGE-005 L1119-1128 | 1A-1, 1A-2 | 0/0/1/0/1/0 | 2 | no | done |
| 1A-5 | Identity preflight in `index_project` (REQ-027) | REQ-027 L605-623, § 6.2.1 L729-750, § 6.2.4 L895-903 | — | 0/0/1/1/0/0 | 2 | no | done |
| 1A-6 | UI-specific post-pass orchestration: `CONTAINS`/`RENDERS`/`RENDERED_ON`/`DEFINED_BY`/`HANDLED_BY`, ownership classification, additive-failure wrapping | REQ-006 L314-321, REQ-013 L410-424, REQ-015 L447-461, REQ-019 L497-509, REQ-020 L511-523, REQ-021 L525-535, REQ-022 L537-547, § 6.2.1 L713-757, § 6.2.2 L759-837, § 6.2.5 L911-924, EDGE-006 L1130-1136, EDGE-010 L1164-1170 | 1A-1, 1A-2, 1A-3, 1A-4, 1A-5 | 1/0/1/2/0/1 | 5 | **yes** (Blast=2) | done |
| 1A-7 | UI Reference Resolver + `match_score` (4-signal scoring, `text_source` precedence, NL field extraction) | REQ-008 L337-347, REQ-009 L349-364, REQ-010 L366-375, REQ-011 L377-396, § "Match-source precedence" L688-703 | 1A-6 | 0/1/0/0/0/1 | 2 | no | done |
| 1A-8 | Five MCP operations (`resolve_ui_reference`, `find_ui_element`, `get_ui_context`, `trace_ui_action`, `find_ui_source`) | REQ-012 L398-408, § 6.2.3 L839-883 | 1A-7, 1A-6 | 0/1/0/1/0/1 | 3 | no | done |
| 1A-9 | Increment 1A hardening: adapter-failure isolation, additive-only guarantees, AC-001–AC-014 + AC-018/AC-019 verification | REQ-021 (test angle), § 14 AC-001–AC-014 L1273-1402, AC-018/019 L1437-1460, § 15 L1462-1516 | 1A-1..1A-8 | 0/0/0/1/1/0 | 2 | no | done |
| 1B-1 | Shortcode recognition (`add_shortcode` → generic `shortcode` entity) | REQ-023 L549-560, AC-015 L1404-1412 | 1A-6 | 0/0/0/0/0/0 | 0 | no | done |
| 1B-2 | Gutenberg static block registration (`register_block_type` + `block.json` + `render_callback` → generic `block` entity) | REQ-024 L562-576, AC-016 L1414-1425, AC-017 L1427-1435, EDGE-014 L1203-1216 | 1B-1 | 0/0/1/0/0/1 | 2 | no | done |
| 1B-3 | Increment 1B hardening: AC-015/016/017 verification, regression checks | § 14 AC-015–AC-017, § 15 L1462-1516 (regression tests) | 1B-1, 1B-2 | 0/0/0/1/0/0 | 1 | no | done |

## Legend

Risk dimensions in table order: Reversibility / Security surface / Concurrency
/ Blast radius / New infra / Spec ambiguity — each 0-2, per the rubric in
`spec-phase-runner`. `checkpoint: yes` when total ≥ 6 or any single dimension
= 2.

Only one phase triggers a checkpoint: **1A-6**, on Blast radius (=2) — it is
the shared `index_project` pipeline stage every later phase (resolver, MCP
ops, and Increment 1B) builds on, and it's also where REQ-021's "adapter
failure must not fail the whole index" guarantee has to actually hold across
every producer wired in by 1A-1..1A-5.

## Notable open items carried into phase implementation (not blocking)

- § 6.2.9 review notes: `UI_IDENTITY_INCOMPLETE` diagnostic shape vs. today's
  plain `{error: message}` convention (relevant to 1A-5/1A-6); `resolution_status`
  enum consistency (`"partial"`/`"unknown_render"` vs. `"data_owned"`) (relevant
  to 1A-6, 1A-9, 1B-2).
- EDGE-006 (one node with multiple `RENDERED_ON` vs. one node per screen) and
  EDGE-010 (staleness) were NOTE [MISSING] in the spec — both now resolved
  and recorded in `contracts.md` (EDGE-006 by 1A-6, EDGE-010 by 1A-8).
- ~~No WordPress fixture project exists in this repo~~ — RESOLVED by 1A-9:
  `test/fixtures/wordpress-ui/`, a purpose-built fixture (finished from a
  partially-built one an earlier interrupted dispatch left behind). See
  `contracts.md` "Phase 1A-9" — 1B-3 should reuse it rather than building a
  second one.
