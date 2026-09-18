# Phase 1A-5 plan — Identity preflight in `index_project` (REQ-027)

## Spec slice cross-check against contracts.md

Everything the slice references is already defined:
- `identityBackfillStatus(projectId)` / `backfillProjectIdentity(project, opts)` —
  `src/backfillIdentity.js`, read in full. `identityBackfillStatus` returns one
  row per project with `unlinked` (= `entity_id IS NULL` count); no row at all
  when the project has zero symbols (trivially complete).
- Per-project advisory lock — `src/indexer.js:99-106` (`pg_advisory_lock`
  around the whole `runIndex()` call). Confirmed still true.
- `reconcileIdentity()` call site — contracts.md's "Fixed by the spec" cites
  `src/indexer.js:455`; current line is 567 (drift from earlier phases
  editing the file, expected/normal).
- `resolveHookGraph()` / `resolveI18nGraph()` — contracts.md "Phase 1A-3"/
  "Phase 1A-4" describe these as running "after edges resolution", gated by
  `config.uiEnabled`, try/catch-and-log. Confirmed: both are called at
  indexer.js:502/523, **before** `reconcileIdentity()` at line 567, not
  after. So the phase-brief's assumption that these "occupy the position
  after reconcileIdentity" is not accurate for the current code — they
  actually sit *before* it. This doesn't block placement: REQ-027 and
  contracts.md's own "Fixed by the spec" bullet are unambiguous that the
  preflight goes right after `reconcileIdentity()`, and that's an open slot
  (nothing 1A-6-related occupies it yet). Noted here for 1A-6's implementer,
  who inherits this same discrepancy.

Nothing referenced is missing from contracts.md — no ambiguity to flag.

## What I'm building

1. `src/indexer.js`:
   - Import `identityBackfillStatus`, `backfillProjectIdentity` from
     `./backfillIdentity.js`.
   - New local function `runIdentityPreflight(project, log)`: calls
     `identityBackfillStatus(project.id)`; if the project's row shows
     `unlinked > 0`, calls `backfillProjectIdentity(project, { log })` once
     (try/catch — failure does not propagate), then re-checks
     `identityBackfillStatus` to see if anything is still unlinked (a
     successful backfill call can still leave rows unlinked, e.g. a symbol
     row that couldn't be joined to a `files` row). Returns the handoff
     object (shape below).
   - New call site in `runIndex()`, immediately after the existing
     `const identity = await reconcileIdentity(...)` line, gated by
     `config.uiEnabled` (same gate as hooks/i18n — this preflight exists
     specifically to unblock UI relation resolution), wrapped in its own
     try/catch so a bug in the preflight itself can't fail the code index
     either. Result stored in a new `identityPreflight` local, included in
     `runIndex()`'s returned stats object.
2. `docs/specs/ui-intelligence/contracts.md`: append a dated "Phase 1A-5"
   section — preflight pipeline position, handoff shape, the
   `UI_IDENTITY_INCOMPLETE` diagnostic-shape decision + rationale, resolve
   that pending-decision bullet.
3. `docs/specs/ui-intelligence/manifest.md`: flip 1A-5's `Status` to `done`.
4. New test file `test/identity.preflight.test.js` (real-DB integration
   style, following `test/identity.indexer.test.js` /
   `test/indexer.uiHooks.test.js`'s established pattern — no mocking
   framework in this codebase, so failure injection uses a genuinely
   unreachable-by-backfill DB state, not a monkeypatched `pool.query`):
   - preflight runs once per job (asserted via `backfillResult.files`
     matching the whole multi-file project in one pass, and via log-line
     count instead of a per-file count).
   - success path: symbols with `entity_id IS NULL` (simulated the same way
     `identity.indexer.test.js` simulates a pre-0006 install — nulling
     `symbol_key`/`body_fingerprint`/`entity_id` after an initial index) get
     backfilled; `identityPreflight.complete === true`, `diagnostics = []`.
   - still-incomplete-after-backfill path: a symbol row whose `file_id`
     doesn't resolve to a `files` row can never get a `symbol_key` from
     `backfillProjectIdentity`'s query (it inner-joins `files`), so it stays
     unlinked even after a successful backfill call — genuine, not
     mocked. Asserts `identityPreflight.complete === false`,
     `backfillRan === true`, and the single `diagnostics[0]` entry matches
     the agreed `{code, severity, affected_feature, message,
     recommended_action}` shape.
   - overall job still completes (`stats.failed === 0`) in that case.
   - `config.uiEnabled = false` → `identityPreflight` stays `null`, no
     backfill attempted even with unlinked symbols present (mirrors
     `test/indexer.uiElements.test.js`'s existing gating-test pattern).

## `UI_IDENTITY_INCOMPLETE` diagnostic shape decision (resolves the pending
cross-phase item)

**Decision: introduce the richer spec shape verbatim** —
`{code, severity, affected_feature, message, recommended_action}` — rather
than folding it into the existing `{error: e.message}` convention.

Rationale: REQ-027's own text is prescriptive, not just "emit some
diagnostic" — it says the system "MUST emit a diagnostic **naming the
affected feature and recommending** `waycontext backfill-identity`". The
existing `{error: e.message}` shape used by docs/history/rules/hooks/i18n
has no field for either of those; it's a log-and-move-on breadcrumb for a
human reading indexer output, not a structured fact a later phase (1A-6, and
eventually 1A-9's MCP-surface tests / §6.2.9's downstream consumers) can
branch on. Folding REQ-027's requirement into `{error}` would mean either
dropping `affected_feature`/`recommended_action`/`severity`/`code` (directly
contradicts REQ-027's wording) or overloading `error` with a formatted
string those fields would have to be re-parsed out of. Introducing the
richer shape as its own field costs nothing to the existing convention —
every other additive subsystem in `runIndex()` keeps its own
`{error: e.message}` breadcrumb untouched; this is additive, not a
replacement.

Scope of the decision: this resolves the shape question for
`UI_IDENTITY_INCOMPLETE` specifically, as scoped by the pending-decision
note. It does not mandate that other additive-subsystem failures
(docs/history/rules) adopt the richer shape — those failures have no
"affected feature" of their own to name (they *are* the feature) and no
recommended remediation command, so REQ-027's specific requirement doesn't
generalize to them.

## Handoff shape 1A-6 will consume

```js
// runIndex()'s stats.identityPreflight, and (until 1A-6 exists as a call
// site) the local `identityPreflight` variable in runIndex() itself, sitting
// immediately after reconcileIdentity() -- 1A-6's post-pass is expected to
// be added right after this local, in the same function, and read it
// directly rather than re-deriving identity completeness itself.
{
  complete: boolean,        // false => at least one symbol this run still
                             // lacks entity_id after preflight ran (or the
                             // preflight itself threw)
  backfillRan: boolean,     // true iff backfillProjectIdentity() was invoked
                             // this run (identityBackfillStatus found >0
                             // unlinked before it)
  backfillResult: {files, symbols, entities} | null,  // backfillProjectIdentity()'s
                             // own return value when it ran and didn't throw;
                             // null if it never ran or threw
  diagnostics: [            // empty array when complete === true
    {
      code: "UI_IDENTITY_INCOMPLETE",
      severity: "warning",
      affected_feature: "ui_relations",  // fixed string: at preflight time,
                             // no specific DEFINED_BY/HANDLED_BY relation is
                             // known yet -- 1A-6 is where per-relation
                             // specificity becomes possible, if it wants it
      message: string,      // human-readable, names the project and the
                             // unlinked-symbol count
      recommended_action: "waycontext backfill-identity",
    }
  ],
}
// null (not run at all) when config.uiEnabled is false.
```

`identityPreflight === null` and `identityPreflight.complete === false` are
both signals 1A-6 should treat the same way for gating purposes: do not
assume identity is complete unless `identityPreflight?.complete === true`.
When incomplete, 1A-6's own `DEFINED_BY`/`HANDLED_BY` writer is expected to
mark the affected relation rows `unresolved` (per REQ-027) rather than
omitting or retrying them, and may append its own more specific diagnostic
entries (same shape, e.g. `affected_feature` naming the actual symbol/owner)
onto its own result rather than mutating this one.

## Risk re-check (Locate/Plan complete)

Upfront: 0/0/1/1/0/0 (concurrency=1, blast=1). Nothing found in
Locate/Plan raises any dimension:
- Concurrency: confirmed safe under the existing `pg_advisory_lock`, same
  precondition 1A-3/1A-4 already relied on for their own project-wide
  post-passes — no new primitive.
- Blast radius: touches the shared `runIndex()` pipeline, but strictly
  additively (new local, new gated/try-catch block, one new field on the
  returned stats object) — same pattern as `hooks`/`i18n`/`history`/`rules`
  already established, not a new pattern.
- No new dependency, no new security surface, reversible (pure addition, no
  destructive migration), spec ambiguity resolved above rather than left
  open.

No escalation. Proceeding to Code.
