# Phase 1A-7 plan — UI Reference Resolver + match_score

## Spec references confirmed in contracts.md / spec.md

- REQ-008/REQ-009/REQ-010/REQ-011 (spec.md L337-396) and the match-source
  precedence table (spec.md L688-703) — read in full, verbatim, not just the
  orchestrator's summary.
- Everything referenced by this slice that isn't defined here is already in
  contracts.md: `ui_element`/`ui_screen`/`ui_component` shapes (1A-1/1A-2/
  1A-6), `i18n_key`/`TRANSLATION_OF`/`text_source` upgrade rules (1A-4),
  `RENDERED_ON`/`CONTAINS` cardinality (EDGE-006, 1A-6), `resolution_status`
  enum (1A-6), `element_id` format (1A-1/REQ-020), `config.uiEnabled` (1A-1).
  Nothing this slice needs is missing from contracts.md.

## Locate (real code, not assumed)

- `src/config.js`: `uiEnabled` (`UI_ENABLED`), `uiI18nLocale`
  (`UI_I18N_LOCALE`). Checked for any existing "model provider" / LLM chat
  config: only `embeddingProvider`/`voyage`/`openai.apiKey` exist, and all
  three are scoped to *embeddings* (used by the vector-search pipeline), not
  chat/completion calls. No LLM-provider abstraction for NL parsing exists
  anywhere in this codebase (grepped `src/*.js` for provider/apiKey/anthropic/
  openai — only the embedding config above matched).
- `src/operations.js`: grepped for `docsEnabled`/`rulesEnabled`/`config.` —
  zero matches. Feature flags gate *indexing* (`src/indexer.js`), not query
  operations; a query op with a flag off just returns naturally-empty results
  because nothing was ever written to the DB. There is no established
  "return {enabled:false}" convention to copy. Given this phase's prompt asks
  for an explicit disabled signal, I'm introducing that shape here — it's a
  reasonable read of "should respect it too", not a copy of an existing
  pattern (documented as a judgment call in contracts.md).
- `src/migrations/0006_identity_and_history.sql:50-86`: `entities`
  (id, org_id, project_id, kind, natural_key, title, data JSONB, deleted_at)
  and `entity_links` (id, org_id, src_id, dst_id, relation, data JSONB,
  UNIQUE(src_id, relation, dst_id)).
- `src/db.js`: `getProject(name, orgId?)` → project row `{id, org_id, name,
  root_path}` or `null`. `pool` exported for direct queries.
- `src/indexer.js` `resolveUiRelations()` (~L1776+): confirms query
  conventions (`pool.query` with `project.id`/`project.org_id`, `deleted_at
  IS NULL` filters, a `log(message)` callback, `entity_links` join patterns
  for `RENDERED_ON`).
- `src/ui/*.js` (phpElements/phpHooks/phpI18nCalls/phpWpPrimitives/
  phpSettingsRender/i18nCatalog): sibling-module convention — pure functions
  where possible, doc comment referencing contracts.md, no shared mutable
  state.
- `test/indexer.uiRelations.test.js`, `test/identity.preflight.test.js`: real
  DB, no mocking, `initDb()`/`cleanupTestProject()`/`pool.end()` pattern,
  `node --test test/*.test.js`.

## REQ-009 judgment call (this phase's main design decision)

**Decision:** build only the deterministic fallback path. Do not add any
server-side LLM-provider call, config, or client in this phase.

**Reasoning:**
1. No "model provider" abstraction for chat/completion exists anywhere in
   this codebase today (confirmed above) — building one would mean inventing
   a new subsystem (HTTP client, API key config, retry/timeout handling,
   error surface) from scratch inside a phase whose upfront risk score is
   total=2. The phase brief itself flags this as an escalation signal, and I
   agree with that framing: it would silently blow past Security=1 and
   New-infra=0.
2. REQ-009's own text supports this reading: "By default, NL parsing happens
   in the calling agent, not inside WayContext" and "Enabling server-side
   provider-based parsing REQUIRES explicit configuration" is written as a
   forward-looking allowance, not a mandate for Increment 1A to ship it.
   Nothing in REQ-008–011 or the manifest row names a specific provider,
   config key, or endpoint — there's nothing concrete to implement even if
   in scope.
3. The manifest's own phase title says "4-signal scoring, text_source
   precedence, NL field extraction" — extraction, not "provider
   integration". 1A-8 (the MCP surface phase) is a more natural place to
   wire an optional server-side path later, if a human decides to build it,
   since it would need its own risk re-score.

So: `extractQueryFields()` is the deterministic path REQ-009 requires when
only `task_text` is given, and it is unconditional — there is no provider
branch to fall back *from*. `task_text` never leaves the process. Structured
hints (`screen`, `text`, `role`, per Q-009) bypass extraction for the fields
they cover, exactly as REQ-008 requires.

## Design

New module: `src/ui/referenceResolver.js`, sibling to the existing `src/ui/
*.js` extractors, same "pure functions where possible" convention.

1. `extractQueryFields(taskText, hints)` — pure, no DB, no LLM. Extracts
   `{screen, element_type, visible_text, viewport, problem_type}`.
   Regex/keyword-based (quoted-string capture for `visible_text`, "on/in the
   X page/screen/tab" capture for `screen`, a small element-type synonym
   table, a small viewport keyword table, a small problem-type keyword
   table — all documented as heuristic/non-exhaustive, matching this repo's
   existing style for `i18nCatalog.js`'s discovery heuristic). `hints.screen`
   /`hints.text`/`hints.role` bypass extraction for those three fields
   (Q-009's named hint fields) and are treated as authoritative — passed
   through with only normalization, never guessed at or replaced.

2. `scoreCandidate(candidate, queryFields)` — pure, the 4-signal REQ-011
   scorer. `candidate = {data, screens}` where `data` is a `ui_element.data`
   blob and `screens` is an array of `ui_screen.data` blobs (0, 1, or many,
   per EDGE-006). Returns `{match_score, evidence}`.
   - text (0.40): `textSimilarity(data.text, queryFields.visible_text)` —
     reads the already-resolved `data.text`/`data.text_source` verbatim, no
     re-derivation from raw attrs (contracts.md "What 1A-7 needs to know").
   - route (0.30): max `textSimilarity` over each screen's
     `route|menu_slug|page_title|menu_title` vs `queryFields.screen`.
   - role (0.20): canonicalized exact match, `data.type` (fallback
     `data.role`) vs `queryFields.element_type`.
   - context (0.10): token-recall overlap between `taskText` tokens and the
     owning component's identity tokens (`data.owner` + source-path
     basename, both tokenized) — deliberately reuses `data.owner` directly
     (already on every `ui_element` row) rather than a second query to
     `ui_component`, since `owner` *is* the component identity per 1A-6.
     Documented judgment call: REQ-011 names "surrounding/component context"
     but does not define an algorithm; this is the interpretation chosen,
     and it's the only one of the four signals not already fully determined
     by contracts.md.
   `textSimilarity` is a small deterministic normalize→exact/substring→
   Jaccard-token-overlap function — no LLM, no fuzzy ML matching, per
   REQ-009's determinism mandate applying to the whole resolver, not just
   the field-extraction step.
   `evidence` lists signal names (`"text"|"route"|"role"|"context"`, in that
   fixed order) with score > 0, matching REQ-011's own example ordering.

3. `resolveUiReference({project, taskText, hints, log})` — DB-backed. Checks
   `config.uiEnabled` first (returns `{enabled:false, queryFields:null,
   candidates:[]}` without querying, never throws for this reason). Resolves
   the project via `getProject`. Runs `extractQueryFields`. Pulls a bounded
   candidate pool of live `ui_element` rows (`LIMIT 500`, documented scaling
   limitation — no full-text-search infra exists in this codebase to narrow
   further, and building one is out of this phase's scope/risk budget), a
   batched `RENDERED_ON` join for screens, scores every candidate, filters
   `match_score >= 0.45` (REQ-010's floor is inclusive), sorts desc
   (tie-break by `element_id` string for determinism), caps at 5 (REQ-010,
   hardcoded `MAX_CANDIDATES = 5`, not a caller-adjustable parameter — a
   caller must not be able to violate the spec's hard cap).

No new DB writes. No new `entity_links`/`entities` rows. No `"partial"`
`resolution_status` writer — that enum lives on `entity_links` rows, and this
phase writes no `entity_links` rows at all (pure query phase, per the
orchestrator's explicit scope boundary), so there is nothing for this phase
to mark `"partial"` on. Recorded as an explicit non-decision in contracts.md
so 1A-8 doesn't wonder why it wasn't used.

## Gate (risk re-check)

Re-scored after Locate/Plan, same six dimensions:

- Reversibility: 0 (pure functions + read-only queries; nothing to revert).
- Security surface: re-confirmed 1, not upgraded. The only surface is
  `task_text` reaching a SQL query — mitigated by using it exclusively in
  parameterized `pool.query` calls (via ILIKE/array parameters, never string
  interpolation) and by REQ-009's own no-outbound-call mandate, which this
  design satisfies by construction (no HTTP client added at all). No new
  attack surface found beyond what the upfront score already anticipated.
- Concurrency: 0. Read-only queries, no shared mutable state (matches
  `i18nCatalog.js`'s no-module-state precedent).
- Blast radius: 0. New file + new tests only; touches no existing module,
  no existing test, no `runIndex()` pipeline step.
- New infra/dependencies: 0. No new package, no new service, no new config
  key beyond reading the existing `config.uiEnabled`.
- Spec ambiguity: re-confirmed 1, not upgraded to 2. REQ-009's provider
  question resolves cleanly to "build the deterministic path only" (above);
  the "surrounding/component context" signal is genuinely undefined by the
  spec but is a small (0.10-weight), non-load-bearing, clearly-documented
  judgment call, not a decision that blocks correctness of the other three
  signals or of REQ-010's cap/floor.

No dimension moved to "high" / no dimension reads 2. Proceeding to Code,
no escalation.

## Files to add

- `src/ui/referenceResolver.js` — the module described above.
- `test/ui.referenceResolver.test.js` — pure unit tests for
  `extractQueryFields`/`scoreCandidate` (no DB) plus a small number of
  real-DB end-to-end tests for `resolveUiReference` (seeded via
  `indexProject()` over a tmp PHP fixture, same pattern as
  `test/indexer.uiRelations.test.js`): ranking order, the 0.45 floor, the
  5-candidate cap, `text_source` passthrough, `config.uiEnabled=false`
  short-circuit, and RENDERED_ON-cardinality (EDGE-006) not breaking scoring
  when an element is on 0 or 2+ screens.

## Contracts this phase will append

- `extractQueryFields(taskText, hints)` signature and field shape.
- `scoreCandidate(candidate, queryFields)` signature, weight breakdown,
  `evidence` shape.
- `resolveUiReference({project, taskText, hints, log})` signature and full
  return shape (`enabled`, `queryFields`, `candidates[]` with `match_score`,
  `evidence`, `text_source`, `visible_text`, and enough entity fields for
  1A-8 to build its MCP response without a second query).
- REQ-009 resolution rationale (already above, will be copied into
  contracts.md).
- "What 1A-8 needs to know" section.
