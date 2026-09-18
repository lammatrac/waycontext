# Phase 1 plan — tutorial-plan.json schema & interface contract

## Scope

Define the `tutorial-plan.json` artifact's schema and validator only. No
producer (Documentation Agent, Phase 4) or consumer (Playwright runner,
Phase 6) logic — those are later phases.

## Precedent followed

`src/reasoning/schema.js` + `test/reasoning.schema.test.js` is the existing
in-repo convention for a JSON-artifact schema: a zod schema module exporting
a `validate*` function (throws on invalid, fills defaults) and a `new*`
convenience constructor, tested with `node:test` + `node:assert/strict`.
Phase 1 follows the same shape for `tutorial-plan.json`, under
`src/tutorial/schema.js`.

Location is provisional: Q-001 (delivery shape — MCP tools on the existing
server vs. a separate orchestration service) is still open and owned by
Phase 2. Putting the schema in this repo's `src/` is the only choice that
doesn't block either outcome — a separate service can still import/vendor
it, and if Q-001 resolves to "new MCP tools," it's already in the right
place. Phase 2 may relocate it; if so it must update `contracts.md`.

## Field-by-field source

From spec: `{ title, language, steps: [{ action, url?, target?, value?,
narration? }] }` (§6.2.3, §6 Rules, REQ-003, REQ-013).

Established plan-level actions (§6 Rules, L308-310): `goto` (+ `url`),
`click` (+ `target`), `type` (+ `target`, `value`). `scroll`, `wait`,
`login` are named for the **execution layer**, explicitly *not*
plan-level-encoded actions. Kept out of the `action` enum for that reason.

## Deviations / additions this phase decides

1. **`schemaVersion` field** (int, default 1) — spec explicitly flags this
   as `NOTE [MISSING]` (§6.2.3 L366, §6 Rules L322-324) and contracts.md's
   "Pending cross-phase decisions" list assigns Phase 1 to decide. Adding
   it: plans are committed to Git and replayed by an evolving runner
   (§13), so an un-versioned artifact is a known future migration hazard.
   Not a deviation from § 19.1 (§ 19.1 has no resolution for this
   question) — a genuinely open decision this phase is scoped to make.

2. **`credentialRef` on `type` steps** (Q-009 resolution, adopted as
   default per phase instructions) — Q-009 requires the plan to reference
   credentials by name/env-var, never a literal value. Rather than adding
   a new `login` action (which would contradict §6 Rules' explicit
   "login is execution-layer-only, not plan-level-encoded"), extend the
   existing `type` step: it takes either `value` (literal, for non-secret
   fields) or `credentialRef` (a secrets-store key, for password/secret
   fields), mutually exclusive, exactly one required. This satisfies
   Q-009 at the schema level without introducing an action `type` the
   Rules section didn't establish. Recorded as a resolution choice, not a
   deviation from § 19.1's substance.

3. **`language` as a free string, not a closed enum** — REQ-013 names
   `"vi"` and `"en"` as the two languages established by sources but
   explicitly flags (NOTE AMBIGUOUS) that "the full supported language set
   are not established" (Q-005). A closed 2-value enum would force a
   schema change for every future language. Constraint: non-empty string,
   scalar (one language per plan, per Q-005's v1 default "one language per
   plan").

## Files

- `src/tutorial/schema.js` — zod schema + `validateTutorialPlan`,
  `newTutorialPlan`, exported sub-schemas (`tutorialPlanSchema`,
  `stepSchema`) for later phases to reuse (Phase 6 runner will want the
  action vocabulary; Phase 4 will want the constructor).
- `test/tutorial.schema.test.js` — TDD tests, mirroring
  `test/reasoning.schema.test.js` structure.

## Contracts this phase produces

- `tutorial-plan.json` finalized shape (fields, types, constraints).
- Q-009 credential-ref resolution as actually implemented (`credentialRef`
  on `type` steps).
- Schema-versioning decision (`schemaVersion`, default 1).
- Module path/export names later phases must import.

## Gate re-check (step 4)

Upfront score: Rev 0 / Sec 1 / Con 0 / Blast 2 / Infra 0 / Amb 1 = 4,
checkpoint yes (flagged solely on blast radius).

After Locate: this is a pure additive module with zero existing callers
(new file, new test file, no edits to existing code, no runtime wiring).
Nothing surfaced that raises any dimension — no hidden coupling, no
concurrency, no new infra, no security surface beyond the schema-level
`credentialRef` field, which stores only a *reference name*, never a
secret. Ambiguity (language set, `login` action shape) is resolved above
with documented reasoning, not guessed silently. No dimension moved to
"high." Proceeding without escalation.
