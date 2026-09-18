# Cross-Phase Contracts — WayDocs AI (AI Tutorial Video Generator)

Source spec: `tasks/context/ai-tutorial-video-generator/spec.md`.
Manifest: `docs/specs/ai-tutorial-video-generator/manifest.md`.

This file is filled in by each phase as it completes — recording the actual
shape it settled on (schema fields, function/module names, endpoints, state
transitions) so later phases don't have to re-read the full spec or an
earlier phase's implementation to integrate with it. Each phase should append
a dated section named after itself; do not rewrite another phase's section.

## Phase 1 — tutorial-plan.json schema & interface contract
_(done)_

**Module:** ~~`src/tutorial/schema.js`~~ **relocated by Phase 2** to
`services/waydocs-ai/src/tutorial/schema.js` — see "Phase 2 update" note
below. (zod-based, follows the existing `src/reasoning/schema.js`
convention: a `validate*` function that parses and fills defaults, throws
on invalid shape; a `new*` convenience constructor; sub-schemas exported
for reuse). Tests: ~~`test/tutorial.schema.test.js`~~ relocated to
`services/waydocs-ai/test/tutorial.schema.test.js` (12 tests, `node:test`,
unchanged content — only the path moved, via `git mv`).

Location was **provisional** — Q-001 (delivery shape: new MCP tools on the
existing WayContext server vs. a separate orchestration service) was still
open and owned by Phase 2. Putting the schema in this repo's `src/` was
the only choice that didn't foreclose either outcome at the time.

> **Phase 2 update:** Q-001 resolved as "separate orchestration service"
> (see the new `## Phase 2` section and the "Pending cross-phase
> decisions" entry below). Phase 2 relocated this module out of `src/`
> entirely, into a new sibling package `services/waydocs-ai/`, because
> `src/` is what the root `package.json` publishes as the `waycontext`
> npm package — leaving a credentials/media-handling, third-party-LLM-
> calling module inside it would recreate, at the package-publish level,
> exactly the "different risk profile, don't host it on WayContext"
> problem Q-001's resolution is about. All imports of
> `tutorialPlanSchema` / `stepSchema` / `validateTutorialPlan` /
> `newTutorialPlan` by later phases must use the new path; the exports
> and the `tutorial-plan.json` shape below are unchanged by the move.

### Exports

```js
import {
  tutorialPlanSchema,   // zod schema for the whole plan
  stepSchema,            // zod schema for one step (discriminated union on `action`)
  validateTutorialPlan,  // (data) => plan; parses + fills defaults; throws on invalid shape
  newTutorialPlan,       // ({ title, language, steps, schemaVersion? }) => plan; convenience constructor
} from "services/waydocs-ai/src/tutorial/schema.js"; // path updated by Phase 2 — see note above
```

### `tutorial-plan.json` finalized shape

```jsonc
{
  "schemaVersion": 1,           // int, positive, default 1 — see "Schema versioning" below
  "title": "string",            // required, non-empty
  "language": "vi",             // required, string, min length 2 — see "language" below
  "steps": [
    // discriminated union on `action`; exactly one of the three shapes below.
    // `steps` must have at least 1 entry.

    { "action": "goto", "url": "string (required, non-empty)", "narration": "string (optional)" },

    { "action": "click", "target": "string (required, non-empty — visible text, e.g. \"Publish\")", "narration": "string (optional)" },

    {
      "action": "type",
      "target": "string (required, non-empty)",
      "value": "string (optional)",
      "credentialRef": "string (optional)",
      "narration": "string (optional)"
      // exactly one of value / credentialRef must be present — see Q-009 below
    }
  ]
}
```

Field types/names are final for this artifact; any later phase that needs
to extend the shape (new step field, new action) must append a note here
rather than editing this section.

### Action vocabulary — binding for all consumers

Only `goto`, `click`, `type` are plan-level-encoded actions (§6 Rules
L308-310 establishes these three explicitly). `scroll`, `wait`, `login`
are named in the spec but explicitly as execution-layer concerns, **not**
plan-level actions — the Rules section states they lack plan-level
encoding. `stepSchema` therefore only accepts the three. Phase 6 (runner)
must not expect a `login`/`scroll`/`wait` action to appear in a validated
plan; any such behavior is the runner's own, not something the plan
encodes. If a later phase concludes `login` genuinely needs plan-level
encoding after all, that requires revisiting this schema, not silently
special-casing an unvalidated field.

### Q-009 — credential-ref resolution (as implemented)

Adopted the § 19.1 default's *substance* (plans reference credentials by
name/env-var, never a literal value) but implemented it by extending the
existing `type` step rather than by adding a `login` action, because
adding `login` to the schema would contradict §6 Rules' explicit
statement that `login` is execution-layer-only. Concretely:

- A `type` step takes **either** `value` (a literal string, for
  non-secret fields) **or** `credentialRef` (a string naming a secret in
  whatever store Phase 5 defines — e.g. an env var name), **never both,
  never neither**. Validated via `superRefine` on the step union.
- `credentialRef` is a *name*, not a value — the schema itself never
  carries a secret. Resolution of the name to an actual value at
  execution time is Phase 5's responsibility (secrets-resolution
  mechanism) and Phase 6's responsibility (the runner calls it when it
  hits a step with `credentialRef` set).
- Video-masking of the keystrokes typed for a `credentialRef` step is
  Phase 8's responsibility (Q-009 also covers this; out of schema scope).
- **This is a deviation in mechanism, not in intent**, from § 19.1's
  literal wording (which frames the resolution in terms of a `login`
  step referencing "a credential"). Recorded here so Phase 5/6/8 build
  against `type` + `credentialRef`, not a `login` action that doesn't
  exist in this schema.

### Schema versioning — Phase 1's decision

Spec flags this as `NOTE [MISSING]` with no § 19.1 resolution to inherit.
Phase 1 adds `schemaVersion` (int, positive, default `1`) because plans
are committed to Git and replayed by a runner that the spec itself says
will evolve (§13). Only version `1` exists today; no migration logic
exists yet. A later phase introducing schema changes must bump this and
is responsible for the runner's version-compatibility handling (naturally
falls to Phase 6 or Phase 10/hardening, not decided here).

### `language` field

Kept as a free non-empty string (min length 2), not a closed enum of
`["vi", "en"]`, because REQ-013 explicitly flags the full supported
language set as unestablished (NOTE AMBIGUOUS, Q-005) — a closed enum
would force a schema change per new language. One language per plan
(scalar field, not an array), consistent with Q-005's v1 default ("one
language per plan"); captions/narration-language handling per Q-005 is
Phase 7's concern, not this schema's.

### Deviation summary (for the orchestrator / human checkpoint)

No deviation from § 19.1's *intent* on anything this phase touches. One
implementation-level deviation from § 19.1's literal wording: Q-009's
credential handling is implemented via `type` + `credentialRef` rather
than a `login` action, because the schema-adjacent §6 Rules text (also in
this phase's slice) explicitly excludes `login` from plan-level encoding.
Both source passages are in this phase's own spec slice, so this was
resolved within-phase rather than escalated.

## Phase 2 — Orchestration service shell & trigger interface
_(done)_

### Q-001 decision — delivery shape

**Adopted § 19.1's proposed resolution as-is**: WayDocs AI is a **separate
orchestration service** that consumes WayContext as an MCP client — not
new tools on the existing WayContext MCP server. Rationale from the spec
(L902-908), confirmed rather than contradicted by inspecting this repo's
actual layout: WayContext is read-only code intelligence with no state;
WayDocs AI has runs, approvals, media files, credentials, and third-party
LLM/TTS calls — a different lifecycle and risk profile. WayContext stays
a dependency, not a host.

**Repo-structure evidence that reinforced this** (found during Locate,
not in the spec slice): the root `package.json`'s `"files"` field
whitelists `src/` for npm publish as the `waycontext` package. Phase 1
had provisionally put the schema inside that same `src/` tree. Leaving
WayDocs AI's orchestration code there would mean a credentials-handling,
third-party-API-calling service ships inside the published
code-intelligence npm package — the same problem Q-001's resolution
warns against, one level down (package boundary vs. MCP-tool-registration
boundary). This is a below-the-spec-text implementation detail, not a
deviation from § 19.1's intent.

**Concretely:** a new top-level directory `services/waydocs-ai/` was
created as its own package (own `package.json`, `src/`, `test/`), a
sibling of `src/`, not nested inside it. It is not part of the
`waycontext` npm publish set (not listed in root `package.json`
`"files"`). Phase 1's schema module was relocated into it (see the
Phase 1 section's "Phase 2 update" note above) via `git mv`, preserving
git history.

**Dependency resolution note (flag for whichever phase deploys this
service independently):** `services/waydocs-ai/package.json` declares
`zod` as its own dependency, but no `npm install` was run inside it for
this phase — it currently resolves `zod` via Node's directory-walking
`node_modules` resolution up to the repo root, monorepo-style. There is
no npm-workspaces linkage yet. This works today because everything runs
out of one checkout, but it means `services/waydocs-ai` is not yet
`npm install`-able on its own. Whoever first needs to deploy/ship this
service standalone (plausibly Phase 6 or later, when real dependencies
like Playwright/FFmpeg/an LLM/TTS client get added) should either add npm
workspaces at the repo root or give this package its own installed
`node_modules`.

### Module & service layout

```
services/waydocs-ai/
  package.json          # name "waydocs-ai", private, own test script
  .gitignore             # .runs/, node_modules/
  src/
    cli.js                # trigger interface entry point (see below)
    tutorial/
      schema.js            # relocated from Phase 1, exports unchanged
    orchestrator/
      runStore.js           # run persistence + status/stage transitions
  test/
    cli.test.js
    orchestrator.runStore.test.js
    tutorial.schema.test.js   # relocated from Phase 1, content unchanged
```

Run tests for this service from `services/waydocs-ai/`: `npm test`
(`node --test test/*.test.js`) — separate from the root repo's own
`npm test`, consistent with this being a separate deploy unit.

### Trigger interface — binding for later phases

The spec leaves the trigger/read-result surface fully open (§6.2.3, §8:
both `NOTE [MISSING]`) and only commits to one concrete trigger for v1:
"Generate mode trigger: an operator request at handoff time" (§6.2.7).
Maintenance mode (CI-on-deploy, automatic regeneration) is explicitly
flagged in the spec as "(later phase)" — **not implemented here**, and
not decided beyond "will need its own trigger path eventually" (probably
HTTP, given the CI context) — a later phase's concern.

**Run persistence** — `services/waydocs-ai/src/orchestrator/runStore.js`:

```js
import { triggerRun, getRun, listRuns, updateRun, RUN_STATUSES }
  from "services/waydocs-ai/src/orchestrator/runStore.js";

triggerRun({ target, requestedBy?, notes? }, { runsDir? })  // -> run record; throws if target is empty/missing
getRun(id, { runsDir? })                                     // -> run record | null
listRuns({ runsDir? })                                       // -> run record[], newest first
updateRun(id, { status?, stage?, ...anyOtherFields }, { runsDir? })
  // -> updated run record; merges patch, appends to history, throws if id
  //    unknown or status not in RUN_STATUSES

RUN_STATUSES = ["pending", "running", "succeeded", "failed"]
```

One JSON file per run, under `runsDir` (default
`services/waydocs-ai/.runs/`, override via env var
`WAYDOCS_AI_RUNS_DIR`) — file-backed specifically so a run created by one
process/CLI invocation can be read back by a later one; an in-memory
store would not survive the process exiting, which the CLI's two-step
trigger-then-check-status flow requires. This is a placeholder
persistence mechanism for the shell, not a decision that this will remain
file-based — Phase 10 (hardening: idempotency, observability) owns
whether this becomes a real DB/queue.

**Run record shape** (this is the contract — later phases extend by
adding fields via `updateRun`'s patch, never by renaming existing ones):

```jsonc
{
  "id": "uuid",
  "target": "string",              // what to document — Phase 4 (Q-002) decides what's a valid target, not this module
  "trigger": { "type": "operator", "requestedBy": "string | null" },
  "notes": "string | null",
  "status": "pending",             // one of RUN_STATUSES — coarse, generic
  "stage": null,                   // free-form string | null — phase-specific detail (see below)
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "history": [ { "status": "...", "stage": "... | null", "at": "ISO8601" } ]
}
```

**`status` vs. `stage` — important for Phases 4/6/9:** `status` is
intentionally coarse (`pending|running|succeeded|failed`) and is owned by
this phase — do not add new values to `RUN_STATUSES` without updating
this contract. `stage` is deliberately free-form (any string or `null`)
and is *not* enumerated here on purpose: Phase 4 (outline generation),
Phase 6 (execution), and Phase 9 (approval gate) each set whatever
stage-specific value they need (e.g. `"outline"`, `"awaiting_approval"`,
`"executing"`, `"assembling"`) via `updateRun(id, { stage: "..." })`
without renegotiating this module's contract. Phase 9 in particular:
approval-gate states (`awaiting_approval` / `approved` / `rejected`, per
Q-006) belong in `stage`, not as new `status` values — `status` only
tracks whether the run is still in flight, done, or failed outright.

**CLI (the actual Generate-mode trigger)** —
`services/waydocs-ai/src/cli.js`, also exports `main(argv) -> exitCode`
for testing without spawning a process:

```
waydocs-ai run <target> [--requested-by NAME] [--notes TEXT]   # triggers a run, prints it as JSON
waydocs-ai status <runId>                                       # prints one run as JSON, exit 1 if unknown
waydocs-ai list                                                 # prints every run as JSON, newest first
waydocs-ai help
```

`package.json` declares `"bin": { "waydocs-ai": "src/cli.js" }`, mirroring
this repo's own `waycontext`/`waycontext-mcp` bin convention, but this bin
is not wired up for global install anywhere yet — invoke via
`node services/waydocs-ai/src/cli.js <command>` for now.

### What's explicitly NOT in this phase's scope

Left for the phases that own them — do not assume any of this exists yet:

- Any actual pipeline stage logic (outline generation = Phase 4, guardrails
  = Phase 3, execution = Phase 6, approval = Phase 9, assembly = Phase 8).
- Any WayContext MCP-client wiring — this phase stands up the shell later
  phases call into; it does not itself call WayContext.
- Queueing, concurrency control, run-duration budgets, frequency limits
  (spec flags all of these as `NOTE [MISSING]`, §6.2.7 L424-426) — not
  addressed; a single-run-at-a-time, no-limits assumption is implicit and
  unchecked in the current shell.
- Maintenance-mode's CI/HTTP trigger (explicitly "later phase" per spec).
- Authentication/authorization on the trigger interface — the CLI runs
  with whatever OS-level access the operator already has; no additional
  authz layer exists. Phase 9 (approval-trigger authorization surface,
  per the manifest's Q-001 dependency note) should revisit this when it
  defines who can approve/reject.

### Browser verification

Skipped — this phase has no browser-observable surface. It is a CLI +
file-backed service shell with no HTTP endpoint, web UI, or anything else
reachable from a browser. Verified instead via `npm test` (26/26 passing
in `services/waydocs-ai`) and manual CLI smoke-checks during development
(covered by `test/cli.test.js`, which exercises the real compiled CLI via
`child_process.execFileSync`, not a mock).

## Phase 3 — Staging / destructive-action safety guardrails
_(done)_

**Module:** `services/waydocs-ai/src/safety/guardrails.js` (new, in the
same `services/waydocs-ai/` package Phase 2 established — not in this
repo's root `src/`, for the same publish-boundary reason as Phase
1/2). Pure, synchronous, dependency-free (only `node:url`) — no coupling
to Playwright, an approval store, or a reset-hook implementation, so it
can be built and tested before Phase 6/9/10 exist. Tests:
`services/waydocs-ai/test/safety.guardrails.test.js` (24 tests,
`node:test`). Full suite for the package: 50/50 passing
(`npm test` in `services/waydocs-ai`).

### Exports

```js
import {
  GuardrailViolation,      // Error subclass; `.details` carries structured context

  // Q-003 mechanism 1: staging-URL allowlist
  isStagingUrl,             // (url, allowlist) => boolean; fails closed (empty/unset allowlist => false)
  assertStagingTarget,      // (url, allowlist) => void; throws GuardrailViolation if not staging (AC-007)
  loadStagingAllowlist,     // (options?) => string[]; options.allowlist, else WAYDOCS_AI_STAGING_ALLOWLIST env var (comma-separated), else []

  // Q-003 mechanism 2: destructive actions require an approved plan
  isDestructiveStep,        // (step, pattern?) => boolean; keyword heuristic over target/value/narration
  assertStepPermitted,      // (step, { planApproved, index? }) => void; throws unless (!destructive || planApproved === true)

  // Q-008 guardrail half: fixture/seed reset precondition
  assertFixturesReset,      // (run) => void; throws unless run.fixturesReset === true

  // Combined run-start gate
  assertRunGuardrails,      // ({ plan, run, allowlist }) => void; asserts fixtures reset + every goto step's URL is staging
} from "services/waydocs-ai/src/safety/guardrails.js";
```

### Q-003 decision (as implemented)

Adopted § 19.1's proposed resolution's *substance* as-is: two independent
mechanisms.

1. **Staging-URL allowlist**, checked against **every `goto` step's URL**
   in the plan — not a single run-level "target" URL, because Phase 2's
   run record `target` field is a free-text description of what to
   document (e.g. `"Deleting a post"`), not a URL; the plan's `goto` steps
   are the only URLs a run actually visits. Hostname match, exact or
   `*.suffix` wildcard. **Fails closed**: an empty or unconfigured
   allowlist means nothing is classified staging, so nothing runs — this
   makes AC-007 observable without requiring separate "is this
   production" detection logic (there is no target-classification input
   other than "is it on the allowlist").
   Allowlist source: explicit `{ allowlist: [...] }` option, else the
   `WAYDOCS_AI_STAGING_ALLOWLIST` env var (comma-separated), else `[]` —
   mirrors Phase 2's `WAYDOCS_AI_RUNS_DIR` convention exactly.

2. **Destructive-step permission gated on plan approval.** A step is
   classified "destructive" via a keyword heuristic
   (`/\b(delete|remove|destroy|cancel|refund)\b|\bpublish\b|\b(pay|charge|purchase|checkout|order)\b/i`)
   over `target`/`value`/`narration`, since Phase 1's schema has no
   explicit destructive flag on a step and adding one is out of this
   phase's scope (would mean re-opening the Phase 1 schema contract).
   `assertStepPermitted(step, { planApproved })` throws unless the step
   is non-destructive **or** `planApproved === true`. **Deliberately does
   not read Phase 9's approval-gate `stage` value itself** (Phase 9 isn't
   built yet, and its exact `stage` string per Q-006 isn't finalized) —
   this module takes a plain boolean, and Phase 6 is responsible for
   deriving `planApproved` from whatever Phase 9 ships (per Phase 2's
   contract: approval states live in `run.stage`, not `run.status`).
   This resolves EDGE-002: an approved plan containing "Delete property"
   executes; an unapproved one attempting the same step is refused.

**Enforcement point:** both mechanisms are enforced as precondition/gate
functions the *runner* (Phase 6) is expected to call — `assertRunGuardrails`
once at run start (fixtures-reset + every goto URL), `assertStepPermitted`
per step immediately before executing it. Nothing in this phase drives a
browser or calls Playwright itself; these are checkable gates, not
enforcement baked into any UI.

**Known gap (not resolved by this phase):** AC-007 also names "an account
that is not the designated test account" as a reason a run must not
execute. Phase 1's `tutorial-plan.json` schema has no account/identity
field (only `credentialRef`, a secret *name* on `type` steps) — there is
nothing for this phase to check account identity against. Only the
staging-URL half of AC-007 is implemented. Whichever phase defines
account/identity (plausibly Phase 5's secrets-resolution design, since a
credential store could itself scope credentials to "designated test
account" entries) should close this gap and extend
`assertRunGuardrails`/add a new assert function at that point — not
silently assumed solved by the URL check alone.

### Q-008 guardrail-half decision (as implemented)

This phase owns the **precondition check**, not the reset mechanism
itself (Phase 10 owns that). New run-record field, extending Phase 2's
run record via `updateRun`'s patch mechanism (no renames, per that
contract):

```jsonc
{
  // ...existing Phase 2 run-record fields...
  "fixturesReset": false,        // boolean, default/absent = false — set by Phase 10's reset hook
  "fixturesResetAt": null        // ISO8601 | null — set alongside fixturesReset: true
}
```

`assertFixturesReset(run)` throws `GuardrailViolation` unless
`run.fixturesReset === true`. **Phase 10, when it builds the actual
reset-hook implementation and its failure handling, is expected to call**
`updateRun(id, { fixturesReset: true, fixturesResetAt: new Date().toISOString() })`
**after a successful reset**, and must leave `fixturesReset` false/absent
on failure so this guardrail continues to block execution. This makes
Q-008's "run-level repeatability, not plan-level idempotency" promise a
checkable precondition Phase 6 can enforce before driving a browser,
without this module knowing anything about how the reset actually
happens (script, API call, DB restore, etc. — all Phase 10's choice).

### Deviation summary (for the orchestrator / human checkpoint)

No deviation from § 19.1's *intent*. Two implementation-level choices not
spelled out in § 19.1's literal wording, both recorded above: (1) the
staging check runs against every `goto` step's URL rather than a single
run-level target, because no single run-level URL exists in this
system's actual shape (Phase 2's `run.target` is descriptive text); (2)
`planApproved` is an opaque boolean input rather than this module reading
Phase 9's stage value directly, to avoid coupling to an unbuilt phase's
not-yet-finalized vocabulary. Both are within this phase's own
discretion — nothing here required escalation (see review.md's Gate
re-check).

### Browser verification

Skipped, explicitly — this phase is a policy/guardrail module with no
HTTP endpoint, CLI command, or UI surface of its own; nothing
browser-observable exists for it yet (Phase 6, which will actually call
these gates while driving Playwright, isn't built). Verified via
`npm test` in `services/waydocs-ai` (50/50 passing, including this
phase's 24 new tests).

## Phase 4 — Documentation Agent (WayContext understanding & outline generation)
_(done)_

**Module:** `services/waydocs-ai/src/outline/outlineGenerator.js` (new, in
the same `services/waydocs-ai/` package Phases 2/3 established). Pure
grouping/formatting logic plus a thin async orchestration layer over an
injected, duck-typed WayContext UI-index client — no live MCP transport
wiring in this phase (see "Not in this phase's scope" below). Tests:
`services/waydocs-ai/test/outline.outlineGenerator.test.js` (18 tests,
`node:test`). Full package suite: 85/86 passing — the 1 failure is a
pre-existing, unrelated flaky test in Phase 2's
`test/orchestrator.runStore.test.js` (`createdAt`-based sort has a
same-millisecond tie-break bug); reproduced with none of this phase's
files present, so not this phase's regression. Left for whichever phase
next touches `runStore.js` to fix.

### Q-002 decision (as implemented) — "what deserves a tutorial"

**Locate finding that narrows §19.1's literal proposal:** none of
WayContext's five UI-index MCP tools (`find_ui_element`,
`get_ui_context`, `resolve_ui_reference`, `trace_ui_action`,
`find_ui_source` — `src/ui/uiQueries.js`/`src/operations.js` in the main
`waycontext` project) can *enumerate* every UI screen/element in a
project. All five are resolve-by-hint (`find_ui_element`/
`resolve_ui_reference`, which require a text/screen/role hint) or
lookup-by-id (`get_ui_context`/`trace_ui_action`/`find_ui_source`, which
require an already-known `element_id`) operations — confirmed also
against `get_modules`/`get_project_overview`, which are directory/
symbol-level only, no UI entities. §19.1's wording ("derive the candidate
workflow list from WordPress UI structure already extracted by
find_ui_element/get_ui_context") reads as if these tools can produce a
list on their own; in the code as it exists today, they cannot.

**Adopted, adapted to that reality:**
- **No automatic business-entity extraction** (§19.1's core instruction,
  kept as-is) — this phase never infers "Users/Properties/Contracts" from
  anything beyond what WayContext's UI index already resolves.
- **Data source is WayContext's UI-index tools only**, per §19.1 — but
  since they can't enumerate, v1 discovery is **seed-driven confirmation**:
  an operator/config-supplied list of seed hints (`{ section, workflow,
  text, screen? }` — "check whether this workflow exists") is confirmed/
  ranked against `find_ui_element`, then enriched via `get_ui_context`.
  Nothing here drives a browser (REQ-005/AC-004 satisfied: zero direct
  browser calls, every candidate traceable to a WayContext query).
- **False-positive control:** a candidate is only ever proposed when
  `ownership === "application"` (excludes WordPress-core/framework-owned
  elements — the same signal `find_ui_source`'s `not_relevant` field
  uses). A seed can surface as a **miss**, never as a **wrong** workflow.
- **Miss/false-positive tradeoff (this phase's answer to Q-002's
  question):** false positives are structurally near-zero (ownership
  filter + WayContext's own match_score floor). Misses are the real,
  expected cost: a workflow the operator never seeds, or one outside
  WayContext's UI-index coverage (Increment 1A, PHP-emitted UI only),
  never appears. Every miss is recorded (`outline.misses`, with a
  `reason` of `not_found` or `framework_only`), not silently dropped —
  EDGE-005 ("proposes something not worth documenting, or omits something
  that is") is handled by surfacing misses for the human reviewer at
  Phase 9's outline-approval gate, not by trying to eliminate them
  algorithmically. **No numeric miss-rate target is set** — the spec
  itself declines to set one (Q-002: "no automated detection criterion is
  established") and this phase doesn't invent one; the mitigation is the
  human gate, not a threshold.
- This is a deviation in **mechanism** from §19.1's literal wording (seed-
  confirmation instead of unqualified "derive... from existing outputs"),
  not in **intent** (still WayContext-only, still no entity extraction).
  Recorded here, per the Gate step, as an in-phase resolution rather than
  an escalation — see `context/phase-4/review.md`'s Gate re-check for the
  full reasoning.

### Exports

```js
import {
  OutlineGenerationError,   // Error subclass; `.details` carries structured context

  isApplicationOwned,       // (candidate) => boolean; ownership === "application"
  pickBestCandidate,        // (candidates) => candidate | null; highest match_score among application-owned, tie-break by element_id

  generateOutline,          // (client, seeds, options?) => Promise<outline>
  formatOutlineText,        // (outline) => string; REQ-006's "Section → Workflow1, Workflow2" format

  runOutlineStage,          // (runId, seeds, { client, runsDir?, generatedAt? }) => Promise<updatedRun>
} from "services/waydocs-ai/src/outline/outlineGenerator.js";
```

**`client`** — duck-typed WayContext UI-index client, injected by the
caller (no concrete MCP transport is wired up by this phase):
```js
{
  findUiElement(text, screen?) => Promise<{ enabled, status, candidates }>,
  getUiContext(elementId)?     => Promise<object>,   // optional; enrichment is skipped if omitted
}
```
Shape matches the real `find_ui_element`/`get_ui_context` MCP tool output
(`src/ui/uiQueries.js`/`src/ui/referenceResolver.js` in the main
`waycontext` project) — a candidate carries `element_id`, `match_score`,
`ownership`, `visible_text`, `screens: [{ route, page_title, menu_title,
... }]`, etc. Tests use a fake implementing this same shape.

**`seeds`** — `[{ section: string, workflow: string, text: string, screen?: string }, ...]`,
at least one required. `section`/`workflow`/`text` are all required
non-empty strings; throws `OutlineGenerationError` otherwise.

**Outline shape** (`generateOutline`'s return value, and `run.outline`
after `runOutlineStage`):
```jsonc
{
  "generatedAt": "ISO8601",
  "sections": [
    {
      "title": "Getting Started",
      "workflows": [
        {
          "title": "Login",                 // from seed.workflow
          "elementId": "el-login",           // WayContext element_id
          "matchScore": 0.8,
          "sourceText": "Log In",            // candidate's visible_text
          "screen": "Login",                 // page_title || menu_title || route, or seed.screen
          "route": "/wp-login.php",
          "context": { /* get_ui_context output, or null if client omits getUiContext */ }
        }
      ]
    }
  ],
  "misses": [
    { "section": "...", "workflow": "...", "text": "...", "screen": "... | null", "reason": "not_found" | "framework_only" }
  ],
  "stats": { "seedCount": 2, "matchedCount": 1, "missCount": 1 }
}
```
Sections preserve first-seen seed order; workflows within a section
preserve seed order.

### Bridge into Phase 2's run store

`runOutlineStage(runId, seeds, { client, runsDir?, generatedAt? })` calls
`generateOutline` then `updateRun(runId, { stage: "outline", outline })`
(`services/waydocs-ai/src/orchestrator/runStore.js`, Phase 2) — using the
`stage: "outline"` value Phase 2's contract already reserved for this
phase, and adding `run.outline` as a pure additive field via `updateRun`'s
patch mechanism (no renames of existing run-record fields).

### Relationship to Phase 1's `tutorial-plan.json` schema

This phase's output is a **pre-plan candidate outline**, not a
`tutorial-plan.json` (Phase 1's schema: concrete `goto`/`click`/`type`
steps). The outline names *which* workflows are candidates and roughly
*where* they live (`elementId`/`screen`/`route`/`context`); turning an
approved outline into an executable plan with concrete step sequences is
a distinct, later stage this phase does not attempt — REQ-005/REQ-006 as
given to this phase are about identifying and describing candidates, the
narrower reading, not authoring plan steps. Whichever phase builds that
translation (plausibly folded into Phase 6, or a dedicated planning step
before it) consumes `outline.sections[].workflows[]` as its input and
`services/waydocs-ai/src/tutorial/schema.js`'s `newTutorialPlan` as its
output target.

### What's explicitly NOT in this phase's scope

- **Real MCP-client transport** to a live WayContext server (stdio
  spawn/connect, request/response marshalling for `find_ui_element`/
  `get_ui_context`). This phase defines and tests against the duck-typed
  `client` interface only — there's no running WayContext server + indexed
  project available inside this phase's TDD loop to wire and test a real
  transport against. Whichever phase first needs a live call (plausibly
  Phase 6) implements an adapter satisfying this interface.
- **Where seed hints come from** — operator-typed input, a config file, a
  future automatic-discovery heuristic layered on top. This phase only
  defines the seed shape and what happens once one is checked against
  WayContext.
- **Numeric miss/false-positive thresholds** — deliberately not set (see
  Q-002 decision above); mitigated by the human outline-approval gate
  (Phase 9), not an algorithmic cutoff.
- Turning an approved outline into a `tutorial-plan.json` (see
  "Relationship to Phase 1's schema" above).

### Browser verification

Skipped, explicitly — this phase is an internal analysis/generation
module with no HTTP endpoint, CLI command, or UI surface of its own (and
no live MCP transport is wired up yet to exercise even indirectly).
Verified via `npm test` (18/18 new tests passing; see `review.md` for the
one pre-existing, unrelated failure elsewhere in the package).

## Phase 5 — Credential handling & secrets resolution
_(done)_

**Module:** `services/waydocs-ai/src/secrets/credentialStore.js` (new, in
the same `services/waydocs-ai/` package Phases 2-4 established). Pure,
dependency-free (no new npm packages) — reads only an injectable
`env`/`store` object, defaulting to `process.env`. Tests:
`services/waydocs-ai/test/secrets.credentialStore.test.js` (18 tests,
`node:test`, fake/dummy ref names and values only — no real secret
anywhere in the module, tests, or this contracts entry). Full package
suite: 85/86 passing — the 1 failure is Phase 2's pre-existing, unrelated
flaky `listRuns ... newest first` test (same-millisecond `createdAt`
tie-break bug), not this phase's regression.

### Q-009 resolution — credential-name → value (as implemented)

Adopted § 19.1's proposed default as-is: an **env-var-backed secrets
store**. This phase is the other half of the contract Phase 1 already
built (Phase 1's `type` step schema: `credentialRef` is a *name*, never a
literal value, mutually exclusive with `value`) — it resolves that name
to an actual value at execution time.

**Mechanism:** every credential lives in an environment variable named
`${CREDENTIAL_ENV_PREFIX}${credentialRef}`, where `CREDENTIAL_ENV_PREFIX
= "WAYDOCS_AI_CREDENTIAL_"` — mirroring Phase 2's `WAYDOCS_AI_RUNS_DIR`
and Phase 3's `WAYDOCS_AI_STAGING_ALLOWLIST` env-var-config convention.
`credentialRef` must match `^[A-Z][A-Z0-9_]*$` (uppercase snake-case
identifier, e.g. `TEST_ACCOUNT_PASSWORD`) — enforced at resolution time,
not by reopening Phase 1's schema (which imposes no format constraint on
the string). **This namespacing is the actual security control**: a
`credentialRef` sourced from an AI-authored, Git-committed
`tutorial-plan.json` can only ever resolve to a variable an operator
deliberately created under this prefix — it structurally cannot read an
arbitrary unrelated environment variable (`PATH`, `AWS_SECRET_ACCESS_KEY`,
etc.), because nothing in this module reads `process.env` unscoped.

### Exports

```js
import {
  CredentialResolutionError, // Error subclass; `.details.reason` + structured context (names only, never a value)
  CREDENTIAL_ENV_PREFIX,      // "WAYDOCS_AI_CREDENTIAL_"

  isValidCredentialRef,       // (ref) => boolean; ^[A-Z][A-Z0-9_]*$
  credentialEnvVarName,       // (credentialRef) => string; throws CredentialResolutionError("invalid_credential_ref") on bad shape

  createEnvCredentialStore,   // (env = process.env) => { get(credentialRef) => string | undefined }
  resolveCredential,          // (credentialRef, { store }?) => string; throws CredentialResolutionError("invalid_credential_ref" | "credential_not_found")

  isCredentialStep,           // (step) => boolean; step.action === "type" && typeof step.credentialRef === "string"
  assertCredentialsResolvable, // (plan, { store }?) => void; throws CredentialResolutionError("credentials_unresolvable", { missing: [refName, ...] }) if any type-step credentialRef in plan.steps fails to resolve

  redactSecret,                // (text, secretValue) => string; replaces every occurrence of secretValue with "[REDACTED]"; no-op if secretValue is empty/undefined
} from "services/waydocs-ai/src/secrets/credentialStore.js";
```

### No-logging guarantee (binding for Phase 6/7/8)

- `resolveCredential`/`assertCredentialsResolvable`/`credentialEnvVarName`
  never call `console.*` or write to any file. They only ever return a
  value or throw.
- Every thrown `CredentialResolutionError`'s `.details` carries only
  *names* — `credentialRef` (already non-secret: it's committed in
  `tutorial-plan.json` in Git) and `envVarName` (a deterministic function
  of the ref) — **never** the resolved value, on any path including
  "not found" (nothing to leak there by construction).
- No export enumerates or dumps the store's contents — only
  look-up-by-name (`resolveCredential`) and an existence check
  (`assertCredentialsResolvable`, which reports missing *names*, not
  values) are exposed.
- `redactSecret` is provided as a defense-in-depth scrub helper for
  callers, but **this module cannot enforce that callers use it** —
  see "What Phase 6 must do" and "What Phase 7/8 must know" below for
  what that requires of them.

### What Phase 6 (runner) must do with this

1. At run start (alongside Phase 3's `assertRunGuardrails`), call
   `assertCredentialsResolvable(plan)` to fail fast if any referenced
   credential is missing, before driving the browser at all.
2. When executing a `type` step, check `isCredentialStep(step)` (or
   equivalently `step.credentialRef != null`) — if true, call
   `resolveCredential(step.credentialRef)` to get the value to type, and
   **use it only to drive the Playwright input** — never place the
   returned value into any object passed to `updateRun` (Phase 2's run
   record is a JSON file on disk; putting a secret there would defeat
   this entire phase), never into narration text, never into a log line
   or console output. If a resolved value must appear in an error message
   or log for debugging, run it through `redactSecret(text, resolvedValue)`
   first.
3. `resolveCredential`/`assertCredentialsResolvable` throw
   `CredentialResolutionError` (not `GuardrailViolation` — a distinct
   error class, since this isn't a Phase-3-owned guardrail) — Phase 6
   should catch/handle it distinctly if it wants a different failure
   `stage`/message than a guardrail violation.

### What Phase 8 (video masking) must know

- Phase 5 does **not** track timing/frame/region metadata for
  credential-derived keystrokes — that requires observing the actual
  Playwright recording session, which only Phase 6 (the runner) can do.
  Phase 8 must get "which steps/time-ranges were credential-derived" from
  whatever recording metadata Phase 6 emits, not from this module.
- What Phase 5 *does* give Phase 8 (indirectly, via Phase 1's schema plus
  this phase's `isCredentialStep` convenience): the *validated plan*
  itself already flags which `type` steps are credential-derived
  (`step.credentialRef` is set) — this was true as of Phase 1, this phase
  didn't need to add anything to the plan shape for that. `isCredentialStep`
  is exported so Phase 6/8 don't each reimplement that check.
- Phase 5 never resolves a value for masking purposes and never persists
  one — masking must work from *what was typed and when*, recorded by
  Phase 6 at execution time, not by re-resolving the credential later.

### AC-007 "designated test account" gap — still open, reassigned

Phase 3 flagged this as a known gap and speculated Phase 5 might close
it. **Decision: not closed here.** Closing it requires *runtime*
verification that the account actually authenticated during a live
browser session matches the intended test account — that needs to
observe browser/session state, which only Phase 6 (the actual runner) can
do. This phase can confirm a named credential's value *exists* in the
store; it cannot confirm what account that value logs into at runtime.
Reassigning ownership to **Phase 6** rather than leaving it ambiguous.
Phase 3's `guardrails.js` (already `done`) was deliberately left
unedited — adding an assertion there that this phase can't actually
satisfy would be scope creep without closing the real gap.

### Explicitly out of scope (deliberate, not silently dropped)

- **`.env` file loading.** This package's declared `engines` floor is
  Node ≥20, which has built-in `--env-file` support — local/dev use of a
  `.env` is already possible without this module doing any custom
  parsing. Not built here.
- **A real external secrets manager** (Vault, AWS Secrets Manager, etc.).
  §19.1's adopted default is env-var-backed; the `store` parameter on
  `resolveCredential`/`assertCredentialsResolvable` exists specifically so
  a later phase can swap in a different backend without changing the call
  shape Phase 6 depends on, but building one is not this phase's job.
- **Phase 6 runner integration and Phase 8 masking/timing metadata** —
  this phase only builds the resolution primitive; wiring it into actual
  step execution and recording belongs to those phases (see above).

### Deviation summary (for the orchestrator / human checkpoint)

No deviation from § 19.1's *intent* (env-var-backed secrets store,
credential referenced by name only). One implementation-level addition
beyond the literal § 19.1 wording: the `WAYDOCS_AI_CREDENTIAL_` env-var
namespace prefix and the `^[A-Z][A-Z0-9_]*$` ref-format requirement — not
spelled out in § 19.1, but necessary to make "env-var-backed" actually
safe (otherwise a `credentialRef` could name any environment variable,
not just an intended credential). This is a within-phase implementation
decision, not an escalation — it directly serves § 19.1's and Q-009's
stated intent (credentials never appear as literals, exposure is
contained) rather than contradicting it. The AC-007 test-account-identity
gap (Phase 3's) was evaluated and explicitly reassigned to Phase 6 above,
not silently left unresolved.

### Browser verification

Skipped, explicitly — this phase is an internal secrets-resolution module
with no HTTP endpoint, CLI command, or UI surface (Phase 6, which would
actually use this while driving Playwright, isn't built yet). Verified
via `npm test` (18/18 new tests passing; 85/86 for the full package, the
1 failure being Phase 2's pre-existing unrelated flake — see
`context/phase-5/review.md`).

## Phase 6 — Playwright execution runner & recording
_(done)_

**Module:** `services/waydocs-ai/src/execution/executor.js` (new, in the
same `services/waydocs-ai/` package Phases 2-5 established). Adds
`playwright` (`^1.63.0`) as this package's first real runtime dependency
beyond `zod` — `services/waydocs-ai/package-lock.json` is new as of this
phase (the package had no lockfile before). Tests:
`services/waydocs-ai/test/execution.executor.test.js` (9 tests,
`node:test`) plus a local-only test fixture,
`services/waydocs-ai/test/fixtures/loginFixtureServer.js` (a plain Node
`http` server bound to `127.0.0.1` on an OS-assigned ephemeral port —
never a real network target). Full package suite:
**95/95 passing**.

### Exports

```js
import {
  ExecutionError,          // Error subclass; `.details.reason` + structured context (never a secret value)

  executeTutorialPlan,      // (rawPlan, run, options?) => Promise<{ status: "succeeded", run, recording, credentialSteps }>
  verifyDesignatedAccount,  // (page, designatedAccount) => Promise<void>; AC-007 primitive, throws ExecutionError("designated_account_mismatch")
} from "services/waydocs-ai/src/execution/executor.js";
```

`executeTutorialPlan(rawPlan, run, options)`:
- `rawPlan` — anything `validateTutorialPlan` (Phase 1) accepts; validated
  first, before any guardrail/credential/browser work.
- `run` — an existing run record from Phase 2's `runStore.js` (e.g. from
  `triggerRun`). Must already have `fixturesReset: true` (Phase 3's
  precondition) or this throws before launching a browser.
- `options`: `{ allowlist, credentialStore, planApproved, runsDir,
  mediaDir, browserType, launchOptions, actionTimeoutMs,
  designatedAccount }` — see the module's JSDoc for each. Notably:
  `planApproved` defaults to `run.stage === "approved"` (Phase 9's
  eventual approval-gate stage value — **Phase 9 must actually set
  `stage: "approved"`** for this default to do anything meaningful; until
  then callers must pass `planApproved: true` explicitly for any plan
  containing a destructive step, or that step will be refused).

On success: returns `{ status: "succeeded", run: <updated>, recording:
{ videoPath, tracePath }, credentialSteps: [{ stepIndex, startedAt,
endedAt }] }` and leaves `run.status = "succeeded"`, `run.stage =
"executed"`. On any failure, **always throws** (never returns a
"failed" result) and always leaves the run record in a terminal state
first — see "Run-record fields this phase adds" below for exactly what
`stage`/`failureReason`/`changed` will be, keyed by failure type.

### Integration — what this phase actually calls, from whom

1. **Phase 1** `validateTutorialPlan` — called first, unconditionally,
   before any guardrail, credential, or browser work.
2. **Phase 3** `assertRunGuardrails` (fixtures-reset + every `goto` step's
   URL against the staging allowlist) called once, pre-flight, before a
   browser is launched. `assertStagingTarget` is **also** re-checked
   individually right before each `goto` step's `page.goto()` call as
   execution proceeds (per Phase 3's contract — not just the upfront
   pass). `assertStepPermitted` (destructive-step gate) is called once
   per step, for every step (not just `goto`/`click`), immediately before
   that step's action is attempted.
3. **Phase 5** `assertCredentialsResolvable(plan)` called once, pre-flight
   (fails fast before any browser work if a referenced `credentialRef` is
   missing). `resolveCredential(step.credentialRef)` is called **only**
   inside the `type` step handler, at the moment of use — the resolved
   value is passed straight to Playwright's `locator.fill()` and is never
   assigned to anything that reaches `updateRun`'s patch or a thrown
   error's `.details`. If a step-level error occurs on a credential-derived
   `type` step, the error message is passed through `redactSecret(message,
   value)` before being wrapped and thrown, per Phase 5's contract.
4. **Phase 2** `updateRun` — called at every state transition: pre-flight
   failure (`status: "failed", stage: "blocked"`), run start
   (`status: "running", stage: "executing"`), and the terminal outcome
   (`succeeded` / `changed` / `failed`, see below). `run.status`/`stage`
   vocabulary usage matches Phase 2's contract exactly — no new `status`
   values were added to `RUN_STATUSES`.

### Q-004 decision (as implemented) — this phase's own open question

Adopted §19.1's proposed **signal** (an unresolvable `target` mid-
execution IS the "changed" signal — no separate diffing mechanism needed)
but **not** its literal "re-plan" verb: re-planning requires an AI
planning pass, and REQ-004 (in this phase's own spec slice) explicitly
states this module must be deterministic Playwright execution only, never
its own AI-vision/planning judgment call. Concrete behavior: on a
Playwright action timeout resolving a step's `target`/`url` (a
`TimeoutError`, or any error matching `/Timeout .*exceeded/i`), the run
**aborts immediately** — no skip, no blind continuation to later steps —
and the run record is updated with:

```jsonc
{
  "status": "failed",
  "stage": "changed",
  "changed": { "stepIndex": 1, "action": "click", "target": "...", "reason": "target_unresolved" }
}
```

This is EDGE-001's Generate-mode behavior "for free," exactly as §19.1
anticipated. **This is the signal Phase 10 (Maintenance-mode /
regeneration hardening) must key its re-plan trigger off** — `run.stage
=== "changed"` plus `run.changed`. This phase does not itself invoke any
re-planner or the Documentation Agent (Phase 4) again; it only produces
the signal and stops. A non-timeout error (e.g. a real network/DNS
failure on a `goto`) is **not** classified as "changed" — it falls into
the generic `stage: "failed", failureReason: "execution_failed"` bucket
instead, since that's a different failure class than "the UI changed out
from under the plan" (§6.2.5 declines to establish a full taxonomy; this
phase only distinguishes what Q-004 required it to).

### AC-007 designated-test-account gap — partially closed here

Phase 3 flagged this gap; Phase 5 investigated and explicitly reassigned
it to this phase, since only a live browser session can observe which
account is actually logged in. **Implemented as an explicit, operator-opt-in
check**, not an automatic one:

```js
options.designatedAccount = { checkAfterStepIndex: 2, expectedText: "testuser" }
```

After the step at `checkAfterStepIndex` executes, the runner asserts
`expectedText` is visible on the page
(`page.getByText(expectedText, { exact: false }).count() > 0`); on
mismatch it throws `ExecutionError("designated_account_mismatch")`
**before any further step runs** (including a subsequent destructive
one), and the run record gets `stage: "blocked"`, `failureReason:
"designated_account_mismatch"`. The underlying primitive,
`verifyDesignatedAccount(page, designatedAccount)`, is exported and
independently unit-tested against a duck-typed fake `page` (only
`.getByText(text, opts).count()` required), so a later phase (e.g. a
maintenance-mode wrapper) can reuse it without going through the full
step loop.

**Why opt-in, not automatic — and what's still open:** nothing upstream
gives this phase anything to key automatic detection off. Phase 1's
schema has no account/identity field and no "this step completes login"
marker; Phase 5 confirmed it can only verify a credential *value* exists,
not what account that value authenticates as at runtime. Closing the
config-free case would require a Phase 1 schema revision (e.g. a
plan-level `expectedAccount` field, or marking which step is "the login
step") — out of this phase's scope, since a schema change belongs to
whichever phase owns schema evolution, not the runner. **Recorded as: closed
for operators who configure `designatedAccount`; open for fully automatic,
config-free detection.**

### Recording — output location & format (binding for Phase 8)

Playwright's own built-in tracing and video recording — no bespoke
recording pipeline. Per run, under
`<mediaDir>/<runId>/` (default `services/waydocs-ai/.media/`, overridable
via `mediaDir` option or `WAYDOCS_AI_MEDIA_DIR` env var, mirroring the
`WAYDOCS_AI_RUNS_DIR`/`WAYDOCS_AI_STAGING_ALLOWLIST` convention; `.media/`
is gitignored, same as `.runs/`):

- **Video** — `.webm`, Playwright's `context.newContext({ recordVideo: {
  dir } })`. Filename is Playwright-generated (not renamed by this
  module); the actual path is returned via `page.video().path()` and
  surfaced as `result.recording.videoPath` / `run.recording.videoPath`.
- **Trace** — `trace.zip` at a fixed name inside the run's media
  directory (`context.tracing.start({ screenshots: true, snapshots: true
  })` / `.stop({ path })`), surfaced as `result.recording.tracePath` /
  `run.recording.tracePath`. Openable with `npx playwright show-trace
  <path>` for step-by-step screenshot/DOM/network replay.
- **Credential-step timing metadata** — `result.credentialSteps` /
  `run.credentialSteps`: `[{ stepIndex, startedAt, endedAt }]` (ISO8601
  timestamps), one entry per credential-derived `type` step that
  successfully executed. **No value, no typed characters, nothing
  resolved from the secret — only which step index and when.** This is
  exactly what Phase 5's contract said Phase 8 needs and can only come
  from this phase (Phase 5 deliberately doesn't track it): **Phase 8 must
  read `run.credentialSteps` to know which time-ranges in the video to
  mask**, correlating `startedAt`/`endedAt` against the video's own
  timeline (this phase does not attempt any frame/pixel-region
  computation itself — out of scope, Phase 8's job per Q-009).
- Recording is attempted (and `videoPath`/`tracePath` populated when
  successfully produced) on **every** outcome that reaches the browser
  stage — success, `"changed"`, or a generic runtime failure — so a
  failed run can still be inspected. Pre-flight failures (invalid plan,
  guardrail violation, unresolvable credential) happen **before** a
  browser is ever launched, so no recording exists for those — `run`
  simply has no `recording` field in that case.

### Run-record fields this phase adds

Extending Phase 2's run record via `updateRun`'s patch mechanism (no
renames of existing fields, per that contract):

```jsonc
{
  // ...existing fields (Phase 2, 3)...
  "stage": "executing" | "executed" | "changed" | "blocked" | "failed",
  "failureReason": "invalid_plan" | "guardrail_violation" | "credentials_unresolvable"
                  | "credential_not_found" | "invalid_credential_ref"
                  | "designated_account_mismatch" | "execution_failed" | undefined,
                  // present on every non-"changed" failure; absent on success or "changed"
                  // (which uses the `changed` field below instead)
  "changed": { "stepIndex": 1, "action": "click", "target": "...", "reason": "target_unresolved" } | undefined,
                  // present only when stage === "changed" (Q-004)
  "recording": { "videoPath": "string | null", "tracePath": "string | null" } | undefined,
                  // present whenever a browser was launched, regardless of outcome
  "credentialSteps": [{ "stepIndex": 0, "startedAt": "ISO8601", "endedAt": "ISO8601" }]
                  // present whenever a browser was launched; empty array if the plan had no credential steps
}
```

`stage` values `"executing"`/`"executed"` are this phase's own (mirrors
Phase 4's `"outline"` pattern); `"changed"` and `"blocked"` are new stage
values this phase introduces for its own failure classes — still within
Phase 2's "stage is free-form, phase-owned" contract, not a `status`
change. `status` itself only ever takes Phase 2's existing values
(`running`/`succeeded`/`failed`) — no new `RUN_STATUSES` entries were
added.

### What Phase 7/8/9/10 need from this phase

- **Phase 7 (narration/TTS)** — nothing new consumed from this phase
  directly; narration text comes from Phase 1's plan steps
  (`step.narration`), unaffected by execution.
- **Phase 8 (video assembly/masking)** — consumes `run.recording.videoPath`
  (the raw video to mux/edit) and `run.credentialSteps` (which time-ranges
  to mask/blur, per Q-009's video-masking half — see "Recording" above).
  Trace files are for human/operator debugging, not part of the assembly
  pipeline.
- **Phase 9 (approval gate)** — this phase reads `run.stage === "approved"`
  as its default `planApproved` source (see `executeTutorialPlan`'s
  options above) — Phase 9 must set exactly that stage string for
  approved runs, or explicitly document a different one and update this
  default.
- **Phase 10 (hardening)** — owns building the actual re-plan trigger off
  this phase's `stage: "changed"` / `run.changed` signal (Q-004), and
  owns the fixture/seed reset-hook implementation this phase's pre-flight
  `assertRunGuardrails` call depends on (`run.fixturesReset`, set by
  Phase 10, checked by Phase 3, enforced here).

### Browser verification

`claude-in-chrome` does not apply — this phase has no browser-observable
UI of its own (it is a headless, automated runner). Verified instead per
this phase's brief: a true end-to-end test
(`executeTutorialPlan runs a full goto+type(value)+type(credentialRef)+click
flow against a local fixture`) that starts a local-only fixture HTTP
server (`127.0.0.1`, ephemeral port), builds a real plan via Phase 1's
`newTutorialPlan` exercising `goto`+`type`(literal)+`type`(`credentialRef`,
dummy test secret)+`click`, runs it through `executeTutorialPlan`, and
asserts on the fixture server's own recorded state (which username it saw
land on `/dashboard`) plus the presence/non-emptiness of the produced
video/trace files on disk — not merely that no exception was thrown. See
`context/phase-6/review.md` for the full verification list, the Gate
re-check, and a disclosed TDD-process note (pre-flight guardrail/
credential/schema-validation tests went through strict RED-GREEN against
a not-yet-existing module; the browser-driving step-loop/recording logic
was written as one cohesive unit and verified passing on first run rather
than split into incrementally-compilable slices, since a real Playwright
browser session doesn't have an inspectable "half-built" intermediate
state).

## Phase 7 — Narration script & TTS synthesis
_(done)_

**Module:** `services/waydocs-ai/src/narration/` (new, in the same
`services/waydocs-ai/` package Phases 2-6 established). Three files, no
new npm dependency (only `node:fs`/`node:path`/`node:os`/`node:crypto`):

```
services/waydocs-ai/src/narration/
  script.js          # narration-script builder
  ttsProvider.js      # TTS synthesis interface + local fake provider
  narrationStage.js   # bridge into Phase 2's run store
```

Tests: `services/waydocs-ai/test/narration.script.test.js` (3),
`narration.ttsProvider.test.js` (6), `narration.narrationStage.test.js`
(1) — 10 new tests, `node:test`. Full package suite: **105/105 passing**
(`npm test` in `services/waydocs-ai`; was 95/95 before this phase).

### Narration-script builder

```js
import { buildNarrationScript } from "services/waydocs-ai/src/narration/script.js";

buildNarrationScript(plan) // plan: a validated tutorial-plan.json (Phase 1)
// => {
//   language: "vi",              // === plan.language, verbatim
//   lines: [
//     { stepIndex: 0, action: "goto", text: "...", source: "plan" | "synthesized" },
//     ...
//   ]
// }
```

- One line per `plan.steps` entry, same order/index.
- `text` is `step.narration` verbatim when present and non-blank
  (`source: "plan"`); otherwise a templated fallback per action
  (`source: "synthesized"`):
  - `goto` → `Navigate to <url>.`
  - `click` → `Click "<target>".`
  - `type` → `Enter information into "<target>".`
- **Security guarantee, binding for Phase 8:** the synthesized fallback
  for a `type` step **never** includes `step.value` or
  `step.credentialRef` — narration text ends up in an audio track and,
  via Phase 8, likely in burned-in captions in the published video, so it
  must not leak whatever was typed. Verified by test
  (`never leaks a typed value or credentialRef into synthesized
  narration`).
- `plan` is not re-validated by this function — callers pass an
  already-validated plan (same pattern Phase 6 uses).

### TTS synthesis interface

```js
import {
  TtsSynthesisError,     // Error subclass; `.details.reason` ("empty_text" | "missing_language")

  DEFAULT_WORDS_PER_MINUTE, // 150
  estimateDurationMs,        // (text, wordsPerMinute?) => ms; deterministic, floors at 500ms

  createLocalTtsProvider,    // (defaults?) => { synthesizeSpeech(text, opts) => Promise<{audioPath, durationMs, language, voice}> }
  synthesizeNarrationAudio,  // (script, { provider, voice?, outputDir?, language? }) => Promise<narration>
} from "services/waydocs-ai/src/narration/ttsProvider.js";
```

**Provider interface — binding for any implementation, fake or real:**
```js
synthesizeSpeech(text, { language, voice?, outputDir? }) => Promise<{ audioPath: string, durationMs: number, language: string, voice: string }>
```
Throws `TtsSynthesisError` (`.details.reason`: `"empty_text"` |
`"missing_language"`) on invalid input.

**`createLocalTtsProvider`** — the fake used by every test and by any
caller until a real provider exists. Writes a real, valid, silent PCM
`.wav` file (mono, 8kHz, 16-bit, all-zero samples) to `outputDir` (default
`services/waydocs-ai/.media/narration/`), sized in duration via
`estimateDurationMs` (word-count / `DEFAULT_WORDS_PER_MINUTE`, floored at
500ms). **No network call, no external binary, no paid API** — genuine
bytes on disk, not a mock object.

**What a real provider implementation (out of scope for this phase) must
satisfy**, to be a drop-in replacement for `createLocalTtsProvider`:
1. Same async signature: `synthesizeSpeech(text, { language, voice?,
   outputDir? }) => Promise<{ audioPath, durationMs, language, voice }>`.
2. `audioPath` must be a real file on disk after the promise resolves
   (any audio format is fine — downstream Phase 8 already needs an
   FFmpeg dependency and can transcode).
3. `durationMs` must be the **actual measured duration** of the produced
   audio, not an estimate — `estimateDurationMs`'s word-count heuristic is
   explicitly a stand-in only the local fake uses.
4. Must select an actual voice/model appropriate to `language` (this is
   what makes AC-006 — "language vi → narration audio in Vietnamese" —
   literally true for a real provider; the local fake only carries
   `language` through as metadata, since it doesn't synthesize real
   speech).
5. Must throw on invalid input using `TtsSynthesisError` (or a caller
   should wrap its errors into one) so callers keep one error-handling
   path across fake/real providers.
6. Must not require any change to `synthesizeNarrationAudio` or
   `runNarrationStage` — both only call `provider.synthesizeSpeech(...)`.

**`synthesizeNarrationAudio(script, { provider, voice?, outputDir?,
language? })`** — runs every line of a script (from
`buildNarrationScript`) through `provider`, producing timed segments:
```jsonc
{
  "language": "vi",
  "voice": "default",
  "totalDurationMs": 5200,
  "segments": [
    {
      "stepIndex": 0, "action": "goto", "text": "...", "source": "plan",
      "audioPath": "/.../<uuid>.wav",
      "durationMs": 2500, "startMs": 0, "endMs": 2500
    },
    { "stepIndex": 1, ..., "startMs": 2500, "endMs": 5200, ... }
  ]
}
```
Segments are sequential and non-overlapping (`startMs`/`endMs` chain
cumulatively) — this is a **timeline assumption for Phase 8 to align
against the recorded video**, not a claim that narration audio is
pre-concatenated into one file (see "Scope decision" below).

### Bridge into Phase 2's run store

```js
import { runNarrationStage } from "services/waydocs-ai/src/narration/narrationStage.js";

runNarrationStage(runId, plan, { provider, runsDir?, mediaDir?, voice?, generatedAt? })
  // => Promise<updatedRun>; calls updateRun(runId, { stage: "narrated", narration: {...} })
```

Mirrors Phase 4's `runOutlineStage` pattern exactly: build the artifact,
then `updateRun`'s additive-patch mechanism records it on the run (no
renames of existing run-record fields, per Phase 2's contract). New
`stage` value `"narrated"` — still within Phase 2's "stage is free-form,
phase-owned" contract. Audio files land under
`<mediaDir>/<runId>/narration/` when `mediaDir` is passed (mirrors Phase
6's `<mediaDir>/<runId>/` recording convention).

### Output artifact shape Phase 8 needs (binding)

After `runNarrationStage`, `run.narration` is:
```jsonc
{
  "language": "string",           // === plan.language
  "voice": "string",
  "totalDurationMs": 0,
  "segments": [
    { "stepIndex": 0, "action": "goto"|"click"|"type", "text": "string", "source": "plan"|"synthesized",
      "audioPath": "string", "durationMs": 0, "startMs": 0, "endMs": 0 }
  ],
  "generatedAt": "ISO8601"
}
```
Phase 8 should:
- Mux/align each `segments[]` entry's `audioPath` onto the video using
  `startMs`/`endMs` as the intended timeline position (per-step, not one
  pre-merged track — see "Scope decision" below).
- Build captions directly from `segments[].text` + `startMs`/`endMs`,
  honoring `run.narration.language` (Q-005: "captions default to matching
  `language`") — no separate caption-text generation needed, this is the
  same text already synthesized to audio.
- Reconcile EDGE-007 (narration duration vs. recorded action duration
  mismatch) itself — this phase only supplies accurate per-segment
  `durationMs`/`startMs`/`endMs`; it performs no stretching, trimming, or
  video-speed adjustment. Cross-reference `run.credentialSteps` (Phase 6)
  by `stepIndex` if a masked video segment's timing needs to line up with
  a narration segment's timing — the two are keyed by the same
  `stepIndex`, but this phase does not itself correlate them.

### Scope decision (recorded, not an escalation)

REQ-008 says "producing an audio track for the tutorial." This phase
produces **one audio file per narration segment**, not a single
concatenated master track — concatenation/muxing into one track requires
FFmpeg, which is Phase 8's dependency per the manifest ("Video assembly
(FFmpeg mux, effects, masking)"), not this phase's. Keeps Phase 7
dependency-free and gives Phase 8 per-step timing granularity it needs
for masking/caption alignment anyway.

### Q-005 — multi-language scope (fully resolved as of this phase)

Schema half (Phase 1): `language` is a required scalar string field on
the plan, min length 2, not a closed enum. **This phase's half, as
implemented:** `buildNarrationScript`/`synthesizeNarrationAudio` read
`plan.language` and nothing else — no code path in this module reads,
infers, or requires a site/UI language. This makes EDGE-006's "narration
language independent of site UI language, by design" true by
construction: there is no mechanism in this module that could couple the
two even accidentally. Captions (Phase 8) inherit `language` from
`run.narration.language`, per §19.1. One language per plan, no
multi-variant plans (v1 scope, unchanged from Phase 1). **Q-005 is now
fully resolved** — see the "Pending cross-phase decisions" entry below.

### What's explicitly NOT in this phase's scope

- A real TTS provider (OpenAI TTS or otherwise) — see "What a real
  provider implementation must satisfy" above. No network call exists
  anywhere in this phase's code or tests.
- Audio concatenation into a single master narration track — Phase 8's
  FFmpeg job (see "Scope decision" above).
- EDGE-007 (narration/video duration alignment) — this phase only
  supplies accurate timing metadata; alignment logic is Phase 8's.
- Multi-language / multi-variant plans — out of v1 scope per Q-005,
  unchanged from Phase 1.
- Wiring `runNarrationStage` into any CLI command or automatic pipeline
  sequencing (e.g. calling it automatically after Phase 6's execution
  stage) — this phase provides the callable stage function only, the same
  way Phase 4's `runOutlineStage` was provided without being wired into
  `cli.js`.

### Browser verification

Skipped, explicitly — this phase is an internal library (narration-script
building + local fake TTS synthesis) with no HTTP endpoint, CLI command,
or UI surface of its own. Verified via `npm test` (105/105 passing).

## Phase 8 — Video assembly (FFmpeg mux, effects, masking)
_(done)_

**Modules:** `services/waydocs-ai/src/assembly/` (new, in the same
`services/waydocs-ai/` package Phases 2-7 established). No new npm
dependency — shells out to the real `ffmpeg`/`ffprobe` binaries via
`node:child_process` (`execFile`), not `fluent-ffmpeg` or any other
wrapper package (see "FFmpeg dependency choice" below). `package.json` is
unchanged by this phase.

```
services/waydocs-ai/src/assembly/
  masking.js        # pure: derive video-relative mask ranges (Q-009)
  captions.js         # pure: build an SRT string from narration segments
  filterGraph.js        # pure: build the ffmpeg -filter_complex + argv
  ffmpegRunner.js         # thin execFile wrapper: runFfmpeg/probeDurationSec/probeVideoDimensions
  videoAssembler.js         # orchestrates the above; assembleVideo(...)
  assemblyStage.js           # bridges into Phase 2's run store
```

Tests: `services/waydocs-ai/test/assembly.masking.test.js` (7),
`assembly.captions.test.js` (3), `assembly.filterGraph.test.js` (7),
`assembly.ffmpegRunner.test.js` (4), `assembly.videoAssembler.test.js` (6),
`assembly.assemblyStage.test.js` (3) — 30 new tests, `node:test`. Full
package suite: **135/135 passing**. Real `ffmpeg`/`ffprobe` 4.4.2 **were
available in this environment and actually used** for every integration
test (verified via `ffmpeg -version`/`ffprobe -version` before starting) —
no stubbing anywhere; tests use small local synthetic inputs only (a
`testsrc` lavfi-generated video, real silent `.wav` segments from Phase
7's own `createLocalTtsProvider`), no network access.

### FFmpeg dependency choice

Shell out to the real binaries directly, not `fluent-ffmpeg` (or similar).
Rationale: mirrors this package's existing convention (Phase 6 depends on
the real Playwright engine, not a thin wrapper); `fluent-ffmpeg` is
unmaintained, and this is a security-relevant module (masking) where an
extra unmaintained dependency is a cost without a clear benefit over a
~60-line `execFile` wrapper (`ffmpegRunner.js`).

### Exports

```js
// masking.js -- Q-009's video-masking half
import { AssemblyError, deriveVideoStartedAt, computeMaskRanges }
  from "services/waydocs-ai/src/assembly/masking.js";
// deriveVideoStartedAt(run) => ISO8601; finds run.history's
//   {status:"running", stage:"executing"} entry (see "Masking mechanism
//   and precision" below for why this, not a real recording-start timestamp).
// computeMaskRanges(credentialSteps, videoStartedAt, { paddingMs? }) =>
//   [{ stepIndex, startSec, endSec }]; paddingMs defaults to 1500.

// captions.js
import { buildSrt } from "services/waydocs-ai/src/assembly/captions.js";
// buildSrt(narrationSegments) => SRT-formatted string ("" if empty)

// filterGraph.js -- pure, no process spawned
import { buildMainFilterGraph, buildMainArgs }
  from "services/waydocs-ai/src/assembly/filterGraph.js";
// buildMainArgs({ videoPath, narrationSegments, maskRanges,
//   cursorHighlights?, zoomRegions?, frameWidth?, frameHeight?,
//   audioTargetDurationSec?, videoExtraPadSec?, captionsPath?, outputPath })
//   => string[] (ffmpeg argv, ready for execFile("ffmpeg", args))

// ffmpegRunner.js
import { runFfmpeg, probeDurationSec, probeVideoDimensions }
  from "services/waydocs-ai/src/assembly/ffmpegRunner.js";
// runFfmpeg(args) => Promise<void>; throws AssemblyError("ffmpeg_failed", {args, stderr})
// probeDurationSec(filePath) => Promise<number> (seconds)
// probeVideoDimensions(filePath) => Promise<{width, height}>

// videoAssembler.js -- the orchestrator
import { assembleVideo, AssemblyError }
  from "services/waydocs-ai/src/assembly/videoAssembler.js";
// assembleVideo({ videoPath, narration, credentialSteps, videoStartedAt,
//   outputDir, options?: { paddingMs?, captions?, cursorHighlights?, zoomRegions? } })
//   => Promise<{ outputPath, durationMs, maskedRanges, captionsPath }>

// assemblyStage.js -- bridge into Phase 2's run store
import { runAssemblyStage, AssemblyError }
  from "services/waydocs-ai/src/assembly/assemblyStage.js";
// runAssemblyStage(runId, { runsDir?, mediaDir?, assemblyOptions?, generatedAt? })
//   => Promise<updatedRun>; calls updateRun(runId, { stage: "assembled", assembly })
```

### Inputs consumed (binding, matches Phase 6/7's contracts exactly)

- `run.recording.videoPath` (Phase 6) — the raw `.webm` to mux.
- `run.narration` (Phase 7) — `{ language, voice, totalDurationMs, segments:
  [{ stepIndex, action, text, source, audioPath, durationMs, startMs, endMs }] }`.
  `segments` may be empty (handled — see "Zero-narration case" below).
- `run.credentialSteps` (Phase 6) — `[{ stepIndex, startedAt, endedAt }]`
  (ISO8601 wall-clock timestamps, never a value/keystroke).
- `run.history` (Phase 2) — used only to derive `videoStartedAt` (see next
  section); no other history entry is read.

### Masking mechanism and precision (Q-009's video-masking half)

**Temporal correlation:** Phase 6 records no "video recording started"
wall-clock timestamp anywhere on the run. The closest available signal is
`run.history`'s `{status:"running", stage:"executing"}` entry, which Phase
6 writes immediately before launching the browser/context (and therefore
before video recording actually starts) — see contracts.md, Phase 6,
"Integration". `deriveVideoStartedAt(run)` uses that entry's `at` as
`videoStartedAt`. This is an **approximation**: browser + context launch
take a small, variable number of ms after that timestamp, so a credential
step's true video-relative position is not exact.

**Mitigation, consistent with the phase brief's "over-masking is
acceptable, under-masking is not":** `computeMaskRanges` pads every
derived range by `paddingMs` (default **1500ms**) on both ends before
`filterGraph.js` burns in the mask. This is applied on the *time* axis,
mirroring the brief's guidance for the *spatial* axis (below).

**Spatial precision: full-frame only, not region-specific.** Phase 6
records no cursor position, element bounding box, or any other
screen-region metadata for a credential-derived `type` step — confirmed
against Phase 6's contract, which explicitly limits `credentialSteps` to
`{stepIndex, startedAt, endedAt}`. There is nothing for this phase to
scope a mask to a sub-region of the frame. Per the phase brief's explicit
instruction, the mask is **always full-frame** (`drawbox=x=0:y=0:w=iw:h=ih`)
for the padded time range — the safe default.

**Limitation recorded for Phase 6/10:** if Phase 6 (or a later hardening
pass) is extended to emit (a) a precise video-recording-start timestamp
and (b) cursor/element screen coordinates at the moment a credential field
is focused, this phase's masking could become both temporally exact (no
padding needed) and spatially scoped (mask only the input field's region
instead of the whole frame). Neither exists today; both are Phase 6/10's
choice to add, not something this phase can infer.

**Verification:** masking correctness was proven with real pixel
measurement, not just "no exception thrown" — see `review.md`. A sampled
frame inside a masked (padded) range measured near-black; a frame outside
it did not.

### REQ-010 scope decisions (recorded as an in-phase deviation, not an escalation)

REQ-010's own `NOTE [AMBIGUOUS]` (in this phase's own spec slice) leaves
open whether cursor highlight/zoom/captions/intro-outro are unconditional,
configurable, or content-conditional. Resolved in-phase:

- **Masking** — always applied over credential-derived ranges. Not
  optional (Q-009 is a security requirement, not a cosmetic effect).
- **Captions** — always built from `run.narration.segments[].text` +
  `startMs`/`endMs` when segments exist (default on via `options.captions`,
  `!== false`), embedded as a **soft `mov_text` subtitle stream**, not
  burned in — so caption text can never visually cover a masked region and
  a viewer can toggle it. `options.captions: false` disables it.
- **Cursor highlight** — implemented and tested (real ffmpeg, see
  `review.md`), **opt-in only**: `options.cursorHighlights:
  [{startMs,endMs,x,y,radius?}]`. A bordered `drawbox` overlay gated by
  `enable='between(t,S,E)'`. Off by default — nothing upstream records
  cursor coordinates, so there is no automatic source data; this is
  honestly scoped as "the assembler can apply it if told where", not
  "the assembler infers cursor position".
- **Zoom** — implemented and tested (real ffmpeg), **opt-in only**:
  `options.zoomRegions: [{startMs,endMs,rect:{x,y,w,h}}]`. A time-gated
  `crop` (rect expressed via nested `if(between(t,S,E),...)`) rescaled back
  to the original frame size (`scale=frameWidth:frameHeight`) so the output
  stream's resolution never changes mid-video. Off by default, same
  "no automatic source data" reasoning as cursor highlight.
- **Intro/outro — NOT implemented, scoped out.** Originally planned as an
  opt-in concat pass (see `plan.md`), dropped after weighing effort against
  this phase's own risk budget (Total 3, no checkpoint) and the complete
  absence of any upstream phase producing intro/outro content or even a
  convention for where such an asset would live. Whichever phase first
  needs this (plausibly Phase 9 for a branded wrapper, or a later polish
  phase) should add it as a distinct post-processing concat step consuming
  `run.assembly.outputPath` as its main input — no reopening of this
  phase's `videoAssembler.js` internals required.

### EDGE-007 (narration/video duration mismatch) — resolved by padding, never truncation

`buildMainArgs` never emits `-shortest`. The shorter of {recorded video,
narration total} is padded to match the longer:
- Audio shorter than video → `apad=whole_dur=<targetDurationSec>` extends
  the mixed narration track with silence.
- Video shorter than narration → `tpad=stop_mode=clone:stop_duration=<extraSec>`
  extends the video by freezing/repeating its last frame.
`videoAssembler.js` computes `targetDurationSec = max(probed video
duration via ffprobe, narration.totalDurationMs / 1000)` and passes the
appropriate one of `audioTargetDurationSec`/`videoExtraPadSec` through.
Neither track's content is ever cut to fit the other — no lost narration
audio, no lost recorded action, at the cost of a possible frozen-frame or
silent tail. Verified by test: a short video + long narration assembled
output's duration reaches (not falls short of) the narration length.

### Zero-narration case

`assembleVideo` and the underlying filter graph handle
`narration.segments.length === 0` (e.g. a plan whose narration stage never
ran) without hanging or erroring: the audio track becomes a bounded
`anullsrc=...:duration=<targetDurationSec>` (an explicit `duration` is
required here specifically — an unbounded `anullsrc` with no narration
`amix`/`apad` step downstream would make ffmpeg encode forever, which this
phase's TDD process actually caught during GREEN, see `review.md`).

### Output artifact shape (binding for Phase 9/10)

After `runAssemblyStage`, `run.assembly` is:
```jsonc
{
  "outputPath": "string",     // absolute path to a real tutorial-final.mp4
  "durationMs": 0,             // probed via ffprobe on the actual output file
  "maskedRanges": [{ "stepIndex": 0, "startSec": 0, "endSec": 0 }],
  "captionsPath": "string | null",  // the .srt file, or null if captions were disabled/no narration
  "generatedAt": "ISO8601"
}
```
`run.stage` becomes `"assembled"` — still within Phase 2's "stage is
free-form, phase-owned" contract, no `RUN_STATUSES` change. Files land
under `<mediaDir>/<runId>/assembly/tutorial-final.mp4` (and
`.../assembly/captions.srt` when captions are enabled) when `mediaDir` is
passed to `runAssemblyStage`, mirroring Phase 6/7's
`<mediaDir>/<runId>/...` convention exactly.

**What Phase 9 (approval gate) needs from this:** `run.assembly.outputPath`
is the single artifact to show/link for human approval — a real, playable
`.mp4` file with video, mixed narration audio, and (if narration existed) a
soft caption track, already muxed and already masked. Phase 9 does not need
to touch `run.recording`, `run.narration`, or `run.credentialSteps`
directly; everything relevant has already been folded into `run.assembly`.

**What Phase 10 (hardening) should know:** the temporal-masking-precision
and spatial-masking-precision limitations above are the two concrete,
named gaps this phase leaves open, both requiring a Phase 6 change (a real
recording-start timestamp; cursor/element coordinates at credential-input
time) to close, not a Phase 8 change.

### What's explicitly NOT in this phase's scope

- A real TTS provider producing non-silent audio — irrelevant to this
  phase; `assembleVideo` only consumes whatever `narration.segments[]`
  gives it (`audioPath`/`startMs`/`endMs`), agnostic to how it was
  produced (Phase 7's concern).
- Intro/outro concatenation — see "REQ-010 scope decisions" above.
- Wiring `runAssemblyStage` into `cli.js` or any automatic pipeline
  sequencing (calling it automatically after Phase 6/7's stages) — same
  pattern as Phase 4/7's stage functions, callable-only, not wired up.
- Closing the temporal/spatial masking-precision gaps — explicitly
  reassigned to Phase 6/10 above, not silently left unresolved.

### Browser verification

Skipped, explicitly — this phase is a headless assembly pipeline
(`videoAssembler.js`/`assemblyStage.js`) with no HTTP endpoint, CLI
wiring, or UI surface of its own; `runAssemblyStage` is a callable stage
function only, following Phase 4/7's pattern. Verified instead via 30 new
`node:test` tests (135/135 for the full package) including real-ffmpeg
integration tests that pixel-sample the actual output video to prove
masking, verify caption/audio/video stream presence via `ffprobe`, and
verify duration-padding behavior on the real produced file — see
`review.md` for the full list.

## Phase 9 — Approval lifecycle & publish gate
_(done)_

**Module:** `services/waydocs-ai/src/approval/approvalGate.js` (new, in the
same `services/waydocs-ai/` package Phases 2-8 established). Pure, no new npm
dependency — only imports Phase 2's `runStore.js` (`getRun`/`updateRun`).
Tests: `services/waydocs-ai/test/approval.approvalGate.test.js` (14 tests)
and `services/waydocs-ai/test/cli.approval.test.js` (5 tests, real CLI
subprocess via `execFileSync`, same pattern as Phase 2's `cli.test.js`) — 19
new tests, `node:test`. Full package suite: **154/154 passing** (was 135/135
before this phase).

### Q-006 decision (as implemented) — approval gate semantics

Adopted § 19.1's proposed resolution **as-is**, no deviation: mandatory and
non-bypassable in v1 (REQ-016 upgraded SHOULD -> MUST); reviewer actions are
approve or reject only — no partial/edit-in-place approval, no single-step
re-run (honored by construction: this module exposes no such function); a
rejected run returns to the **planning** stage (`run.stage = "planning"`),
for both gates alike, matching the resolution text verbatim. This is safe
because Phase 2's `updateRun` merges patches additively and never deletes
fields — a rejection never discards `run.outline`/`run.narration`/
`run.assembly`/etc., only `stage` (plus a new `approvals[]` entry) changes,
so a human reviewing a rejected run can still see everything the pipeline
already produced.

**"Mandatory/non-bypassable" is enforced as**: there is no code path in this
module, or anywhere else in the package, that sets `run.stage` to `"approved"`
or `"published"` except `approveRun`. Two precondition-assertion functions
(mirroring Phase 3's `guardrails.js` pattern exactly — pure, synchronous,
throw-only) exist for future callers to enforce this at the point of use:
`assertOutlineApproved(run)` and `assertPublishApproved(run)` (the latter is
AC-008's literal statement made checkable). Neither is wired into Phase 6 or
any real "publish" action by this phase — see "Known integration gap" below.

### Two gate points, one reusable primitive

Per the phase brief, built as a single parameterized gate applied at both
pipeline points via Phase 2's `stage` transitions, not two bespoke
implementations:

```js
import {
  ApprovalError,          // Error subclass; `.details.reason` + structured context
  APPROVAL_GATES,          // { outline: {...}, publish: {...} } -- the gate table below
  requestApproval,         // (runId, gateName, options?) => updated run; readyStage -> awaitingStage; idempotent if already awaiting
  approveRun,               // (runId, gateName, { approvedBy?, runsDir? }?) => updated run; awaitingStage -> approvedStage
  rejectRun,                 // (runId, gateName, { rejectedBy?, reason?, runsDir? }?) => updated run; awaitingStage -> rejectedStage ("planning")
  assertOutlineApproved,       // (run) => void; throws ApprovalError("outline_not_approved") unless run.stage === "approved"
  assertPublishApproved,        // (run) => void; throws ApprovalError("publish_not_approved") unless run.stage === "published" (AC-008)
} from "services/waydocs-ai/src/approval/approvalGate.js";
```

`options` on `requestApproval`/`approveRun`/`rejectRun` accepts `runsDir`
(passed straight through to Phase 2's `getRun`/`updateRun`, same convention
as every other stage function in this package) alongside the gate-specific
keys above.

**Gate table** (`APPROVAL_GATES`):

| gate      | `readyStages`   | `awaitingStage`               | `approvedStage` | `rejectedStage` |
|-----------|-----------------|--------------------------------|-------------------|-------------------|
| `outline` | `["outline"]`   | `"awaiting_outline_approval"`  | `"approved"`       | `"planning"`      |
| `publish` | `["assembled"]` | `"awaiting_approval"`          | `"published"`      | `"planning"`      |

- **`outline` gate** — Q-002's outline-approval gate: opens once Phase 4's
  `runOutlineStage` has set `run.stage === "outline"`. Its pass/fail criterion
  (per this phase's brief) is Phase 4's own Q-002 resolution: the human
  reviewer looks at `run.outline.sections` (and `run.outline.misses`) — only
  `ownership === "application"` candidates were ever proposed by Phase 4, so
  there is nothing new for this gate to check beyond the human's own
  judgment. **`approvedStage` is literally `"approved"` — not a free
  naming choice.** Phase 6's `executor.js` (already `done`) already ships
  with `planApproved` defaulting to `run.stage === "approved"` (see `##
  Phase 6` above and `## Phase 3`'s Q-003 entry below) — this gate produces
  exactly that string so that existing default does something meaningful
  without Phase 6 needing to change.
- **`publish` gate** — REQ-016/AC-008's publish gate: opens once Phase 8's
  `runAssemblyStage` has set `run.stage === "assembled"`. `awaitingStage:
  "awaiting_approval"` matches spec §6.2.1's own state-table name verbatim.
  `approvedStage: "published"` matches the spec's own terminal state name.
  The artifact the reviewer inspects is `run.assembly.outputPath` (Phase 8's
  contract: "the single artifact to show/link for human approval").

Neither gate changes `run.status` — `status` stays whatever Phase 6/7/8 last
set it to (`"succeeded"`, in the normal path), per Phase 2's contract that
approval states live in `stage`, never as a new `RUN_STATUSES` value. No new
`status` value was added.

### New run-record field

Extending Phase 2's run record via `updateRun`'s additive-patch mechanism (no
renames, per that contract):

```jsonc
{
  // ...existing fields (Phases 2-8)...
  "approvals": [
    { "gate": "outline" | "publish", "decision": "approved" | "rejected",
      "by": "string | null", "reason": "string | null" /* only on reject */, "at": "ISO8601" }
  ]
}
```
Appended to (never replaced) by `approveRun`/`rejectRun` — a full audit trail
of every gate decision on the run, across however many planning/rejection
cycles it goes through.

### CLI (extends Phase 2's `cli.js`)

```
waydocs-ai request-approval <runId> --gate outline|publish
waydocs-ai approve <runId> --gate outline|publish [--approved-by NAME]
waydocs-ai reject <runId> --gate outline|publish [--rejected-by NAME] [--reason TEXT]
```
Same `parseFlags`/`printJson` conventions as `run`/`status`/`list`; exits
non-zero with a stderr message on any `ApprovalError` (unknown gate, run not
found, wrong current stage for the requested transition), mirroring
`status`'s existing exit-1-on-unknown-run behavior. No auth layer — same
trust boundary as every other command Phase 2 defined (OS-level access to
run the CLI is the only gate).

### Known integration gap (recorded, not fixed here — out of this phase's edit scope)

Phase 3/6's guardrail mechanism (`assertStepPermitted`, `## Phase 3` above)
only gates **destructive** steps on `planApproved` — it does not gate *all*
execution on outline approval. Q-002's resolution text says human sign-off
on the outline is required "before any recording," not just before
destructive steps within it. Phase 6's `executor.js` is already `done`, and
this phase's brief scopes it to building the gate mechanism, not rewiring an
already-shipped runner. `assertOutlineApproved(run)` is exported specifically
so whichever phase next touches `executor.js` (plausibly Phase 10) can add
one call (`assertOutlineApproved(run)` at the top of `executeTutorialPlan`,
alongside the existing `assertRunGuardrails`/`assertCredentialsResolvable`
pre-flight calls) to close this gap without reopening this phase's module.

### What Phase 10 (hardening) needs from this phase

- **Idempotency around approval state**: `requestApproval` is already
  idempotent (no-op if already `awaitingStage`); `approveRun`/`rejectRun` are
  **not** — calling either twice on an already-transitioned run throws
  `ApprovalError("not_awaiting_approval")` rather than silently no-op'ing,
  since a second approve/reject on the same gate-opening is itself a
  meaningful failure mode (e.g. a double CLI invocation, or two reviewers
  racing) Phase 10 may want to classify explicitly rather than swallow.
- **Failure taxonomy**: `ApprovalError.details.reason` is a closed set as of
  this phase — `"unknown_gate"`, `"run_not_found"`, `"not_ready_for_approval"`,
  `"not_awaiting_approval"`, `"outline_not_approved"`, `"publish_not_approved"`
  — Phase 10 should fold these into whatever unified failure taxonomy it
  builds (§6.2.5 declines to establish one; Phase 6 only distinguished
  `"changed"` vs. generic `"execution_failed"`; this phase adds its own
  small closed set on top, following the same `Error` subclass +
  `.details.reason` convention as `GuardrailViolation`/`CredentialResolutionError`/
  `ExecutionError`/`AssemblyError`/`TtsSynthesisError`/`OutlineGenerationError`).
- **Observability**: every gate decision is already durably recorded in
  `run.approvals[]` (who, what, when, why) and in Phase 2's own
  `run.history[]` (via `updateRun`'s history-append) — Phase 10 does not need
  to add new instrumentation to see approval activity, only to surface what
  already exists.
- **Wiring the outline -> `tutorial-plan.json` translation step and the
  `assertOutlineApproved` call into `executor.js`** — see "Known integration
  gap" above; not built by this phase, flagged for whichever phase (plausibly
  10) closes it.

### Deviation summary (for the orchestrator / human checkpoint)

No deviation from § 19.1's intent on anything this phase touches — Q-006 was
adopted as-is (see above). One implementation-level constraint not stated in
§ 19.1's literal wording but forced by an already-`done` phase's contract:
the outline gate's `approvedStage` must be the literal string `"approved"`,
because Phase 6 already ships with `planApproved` defaulting to `run.stage
=== "approved"`. This is not a deviation from anything — it's this phase
conforming to a contract an earlier phase already committed to, recorded here
so it's traceable. The destructive-steps-only vs. all-execution gating gap
(see "Known integration gap") was evaluated during the Gate re-check and
explicitly reassigned to Phase 10 rather than escalated or silently left
unresolved — see `context/phase-9/review.md`'s Gate re-check for the full
reasoning.

### Browser verification

Skipped, explicitly — this phase's only human-facing surface is the CLI
(`request-approval`/`approve`/`reject`), consistent with every prior phase's
reliance on Phase 2's CLI-only trigger interface; there is no HTTP endpoint
or web UI anywhere in this service. Verified via real CLI subprocess tests
(`test/cli.approval.test.js`, `execFileSync` against the actual compiled
CLI, not a mock) plus 14 unit tests on the gate primitive itself — 19 new
tests, 154/154 for the full package. See `context/phase-9/review.md`.

## Phase 10 — Hardening (idempotency, failure taxonomy, observability)
_(done — last phase of this spec)_

**Modules added:** `services/waydocs-ai/src/safety/fixtureReset.js`,
`services/waydocs-ai/src/execution/replanTrigger.js`,
`services/waydocs-ai/src/observability/failureTaxonomy.js` (all new, in
the same `services/waydocs-ai/` package Phases 2-9 established). No new
npm dependency (`fixtureReset.js` uses only `node:child_process`).
**Modules edited:** `src/execution/executor.js` (outline-approval gate +
failure-taxonomy wiring), `src/cli.js` (two new commands), `src/orchestrator/runStore.js`
(same-millisecond tie-break fix — see "Bonus fix" below). Tests:
`test/safety.fixtureReset.test.js` (8), `test/execution.replanTrigger.test.js`
(5), `test/observability.failureTaxonomy.test.js` (5),
`test/cli.hardening.test.js` (4), plus one new test each in
`test/execution.executor.test.js` (10 total) and
`test/orchestrator.runStore.test.js` (10 total). Full package suite:
**178/178 passing** (was 154/154 at the end of Phase 9), verified stable
across 3 consecutive full-suite runs. See `context/phase-10/review.md` for
the full verification list and Gate re-check.

### Item 1 — Q-008 reset-hook implementation (this phase's own module, anticipated by Phase 3)

**Built.** `services/waydocs-ai/src/safety/fixtureReset.js`:

```js
import {
  FixtureResetError,       // Error subclass; `.details.reason` + structured context
  resolveResetCommand,      // (options) => string | null; options.command, else WAYDOCS_AI_FIXTURE_RESET_CMD, else null
  createShellResetRunner,   // (command) => async () => void; shells out via execFile(..., { shell: true })
  resetFixtures,            // (runId, options) => Promise<updatedRun>
} from "services/waydocs-ai/src/safety/fixtureReset.js";
```

`resetFixtures(runId, { runner?, command?, runsDir? })`:
- `options.runner` — an injectable async `(run) => void`, the actual reset
  mechanism (script, API call, DB restore — this module never knows or
  cares which). Omit to shell out to `options.command` /
  `WAYDOCS_AI_FIXTURE_RESET_CMD` (mirrors this package's other
  `WAYDOCS_AI_*` env-var config convention — runs dir, media dir, staging
  allowlist, credential env prefix).
- **Success** → exactly what Phase 3 anticipated:
  `updateRun(runId, { fixturesReset: true, fixturesResetAt: <ISO8601> })`,
  which satisfies Phase 3's already-shipped, unmodified
  `assertFixturesReset(run)` precondition.
- **Failure** → leaves `fixturesReset` false/absent (so
  `assertFixturesReset` keeps blocking), records `status: "failed", stage:
  "blocked", failureReason: "fixture_reset_failed"` plus a structured
  `lastFailure` entry (item 4), and rethrows `FixtureResetError`.
- **Security note:** the reset command is operator-supplied config (env
  var or explicit option), never derived from AI-authored plan content —
  same trust boundary as this package's other `WAYDOCS_AI_*` env vars
  (Phase 5's credentials, Phase 3's staging allowlist). Evaluated
  explicitly during this phase's Gate re-check; not treated as a new
  security-relevant surface.
- **CLI:** `waydocs-ai reset-fixtures <runId>` (new command, mirrors Phase
  9's `approve`/`reject` CLI-command pattern).

**Not built:** any actual project-specific reset script/SQL/API call —
this module only defines the calling convention and run-record
bookkeeping, exactly as Phase 3 anticipated ("the reset hook itself...is
Phase 10's responsibility... script, API call, DB restore, etc. — all
Phase 10's choice"). An operator wires a real command via
`WAYDOCS_AI_FIXTURE_RESET_CMD` at deploy time.

**Q-008 is now fully resolved** — see "Pending cross-phase decisions" below.

### Item 2 — Q-004 re-plan trigger

**Built.** `services/waydocs-ai/src/execution/replanTrigger.js`:

```js
import {
  ReplanTriggerError,     // Error subclass; `.details.reason` + structured context
  REPLAN_TARGET_STAGE,     // "planning" -- Phase 9's own `rejectedStage` value
  needsReplan,              // (run) => boolean; stage === "changed" && run.changed present
  triggerReplan,             // (runId, options?) => Promise<updatedRun>
} from "services/waydocs-ai/src/execution/replanTrigger.js";
```

`triggerReplan(runId, { runsDir?, reason? })` moves `run.stage` from
`"changed"` to `"planning"` and appends to a new additive
`run.replanTriggers[]` audit trail (`{ changed, reason, at }` — mirrors
Phase 9's `run.approvals[]` pattern), never discarding the original
`run.changed` record (updateRun's additive-merge, per Phase 2's contract).
Throws `ReplanTriggerError("not_changed")` if the run isn't currently
carrying an actionable "changed" signal, `ReplanTriggerError("run_not_found")`
for an unknown id. **CLI:** `waydocs-ai replan <runId> [--reason TEXT]`.

**Deliberately does NOT itself re-invoke Phase 4's `runOutlineStage` or
any AI planning pass** — REQ-004 keeps planning judgment out of the
deterministic execution layer (Phase 6's own docstring/contract), and
deciding *what* to re-plan with (new seeds? the same outline
re-confirmed?) is an orchestration/product decision this module has no
information to make safely. What it delivers is the missing mechanical
piece: a real, callable, auditable trigger that turns an inert "changed"
signal into a stage transition — usable today by an operator via the CLI,
and by a future Maintenance-mode scheduler without any change to this
module's contract.

**Q-004 is now fully resolved** (signal + trigger both exist; the actual
AI re-plan pass itself remains explicitly out of scope of both Phase 6
and this phase, per REQ-004) — see "Pending cross-phase decisions" below.

### Item 3 — Outline-approval gap closed

**Built.** `src/execution/executor.js` now imports and calls Phase 9's
already-exported `assertOutlineApproved(run)` — no changes to
`approvalGate.js` itself, per Phase 9's own note that it left that module
unedited on purpose. Call site: immediately after plan-schema validation
(`validateTutorialPlan`), before the guardrails/credentials pre-flight
(`assertRunGuardrails`/`assertCredentialsResolvable`). On failure:
`status: "failed", stage: "blocked", failureReason: "outline_not_approved"`
(added to the existing `BLOCKED_REASONS` set) plus a `lastFailure` entry.

**Ordering choice (recorded):** plan-schema validation still runs first,
so an invalid plan is still reported as `"invalid_plan"` even on an
unapproved run (preserves Phase 6's original "invalid plan caught before
guardrails" test unmodified). Outline-approval is checked next, before
guardrails/credentials, so an unapproved run is reported for exactly that
reason rather than being masked by a downstream pre-flight failure it
would also happen to trip.

**Interaction with `planApproved` (recorded, not a new problem — a
pre-existing coupling made newly visible):** Phase 6's `planApproved`
default was already `run.stage === "approved"` (Phase 9's own contract:
"this gate must produce exactly that string so that existing default does
something meaningful"). Since the outline gate's `approvedStage` is also
the literal string `"approved"`, once a run clears the outline gate the
*default* `planApproved` becomes `true` automatically — there is still no
separate plan-approval gate in this system distinct from outline approval.
This is unchanged behavior from Phase 9, just newly load-bearing now that
outline approval is enforced unconditionally rather than only mattering
for destructive steps. A caller that needs to test/exercise the
destructive-step gate independent of outline approval must pass
`options.planApproved: false` explicitly to override the default (done in
`test/execution.executor.test.js`'s "refuses a destructive step..." test).
Whichever phase eventually builds a distinct plan-review gate (separate
from outline review) will need to change this default, not something
introduced or masked by this phase.

**Test-suite impact:** `test/execution.executor.test.js` gained a
`markOutlineApproved(run, runsDir)` helper (`updateRun(run.id, { stage:
"approved" }, { runsDir })`, mirrors the existing `markFixturesReset`
helper) applied to every test that exercises past pre-flight.

### Item 4 — Failure taxonomy & observability

**Built.** `services/waydocs-ai/src/observability/failureTaxonomy.js`:

```js
import {
  FAILURE_TAXONOMY,   // { GuardrailViolation, OutlineGenerationError, CredentialResolutionError,
                        //   ExecutionError, TtsSynthesisError, AssemblyError, ApprovalError,
                        //   FixtureResetError, ReplanTriggerError } -- each { source, phase }
  classifyError,        // (err) => { class, reason, known, phase }; never throws, incl. on null/undefined
  buildFailurePatch,      // (err) => { lastFailure: { class, reason, message, at } }; spread into an updateRun patch
} from "services/waydocs-ai/src/observability/failureTaxonomy.js";
```

New additive run-record field, via `updateRun`'s patch mechanism (no
renames, per Phase 2's contract):
```jsonc
{
  // ...existing fields (Phases 2-9)...
  "lastFailure": { "class": "GuardrailViolation", "reason": "...", "message": "...", "at": "ISO8601" } | undefined
}
```

**Wired into:** every failure branch of `executor.js` (invalid-plan,
outline-not-approved, guardrail/credential pre-flight, and the terminal
generic-error branch) and `fixtureReset.js`'s failure path.
**Deliberately NOT wired into** the `"changed"` (Q-004) branch of
`executor.js` (already has its own dedicated structured `run.changed`
field — would be redundant) or into Phase 3/5/9's own modules directly
(none of `guardrails.js`/`credentialStore.js`/`approvalGate.js` call
`updateRun` themselves; their errors are always caught by a caller —
`executor.js`, which now carries `buildFailurePatch`, covers 3/5's errors
end-to-end; Phase 9's `run.approvals[]` already durably records every gate
decision, per Phase 9's own "What Phase 10 needs" note — nothing new
needed there).

**No new logging/metrics/tracing framework was built.** §6.2.8
("Observability") and §15 ("Testing Requirements") are both explicit
`NOTE [MISSING]` in this phase's own spec slice — no metrics, logs,
traces, alerts, dashboards, or unit/integration-test *requirements* are
established by the sources. This module only consolidates what Phases
1/3/5/6/7/8/9 already built (their own `Error` subclass + `.details.reason`
convention) into one lookup table + classifier, and extends Phase 2's
existing `run.history`/`updateRun` surface with one additive field — per
this phase's own brief's explicit instruction not to invent a large new
framework.

### Bonus fix (not one of the 4 assigned items, done because time allowed)

**Fixed the pre-existing flaky `runStore.js` test**, flagged since Phase 2
and explicitly out of scope for every phase through Phase 9. Root cause:
`listRuns`'s sort compared `createdAt` (millisecond-resolution ISO8601)
only — two `triggerRun` calls landing in the same millisecond had
unspecified relative sort order. Fix: `runStore.js` now assigns a
same-process monotonic sequence number (`_createdSeq`, an internal field,
not part of the documented run-record contract other phases should read)
at `triggerRun` time, used purely as `listRuns`'s tie-breaker after
`createdAt`. Added a deterministic reproduction test (freezes `Date` so
the same-millisecond tie is guaranteed, rather than depending on real
timing) in `test/orchestrator.runStore.test.js`. Verified RED before the
fix, GREEN after, full suite stable across 3 consecutive runs.
**Known remaining limitation:** this does not make cross-process run
ordering fully monotonic (the counter resets per Node process) — an
accepted limitation of this placeholder file-backed store, unchanged from
Phase 2's original framing ("Phase 10... owns whether this becomes a real
DB/queue" — this fix addresses the specific flaky-test tie-break, not that
larger architectural question).

### Explicitly deferred / not built (recorded, not silently dropped)

- **Concurrency / locking** (§6.2.4 `NOTE [MISSING]`: two runs against the
  same staging dataset, no established concurrency model). Not one of
  this phase's 4 assigned items; no §19.1 resolution exists to anchor a
  design to (Q-008's resolution covers idempotency-via-reset, not
  concurrent-run locking). Building a locking/queueing mechanism here
  would be speculative infra beyond this phase's brief. **Still open** for
  whoever builds real multi-run scheduling.
- **EDGE-009** (non-WordPress / non-standard site support) — the spec
  itself establishes no behavior here and §19.1 offers no resolution to
  adopt. Nothing actionable; no code change, recorded for completeness
  only.
- **The outline → `tutorial-plan.json` translation step** (flagged open
  by Phase 9's "Known integration gap," reassigned loosely to "whichever
  phase next touches `executor.js`, plausibly 10") — **not built**. This
  phase's brief scoped item 3 to wiring the *approval check*, not building
  the translation step itself; building it would mean inventing a new,
  unspecified transformation (outline sections → concrete `goto`/`click`/
  `type` steps) with no contract anywhere in this spec to build against.
  **Still open.**
- No new console/metrics/tracing framework (see item 4 above) — an
  in-phase decision, not an oversight.

### Browser verification

Skipped, explicitly. This phase added two new CLI commands
(`reset-fixtures`, `replan`) to the existing CLI-only trigger interface —
same pattern as every prior phase's CLI additions. The `executor.js` edit
is a guard addition, not a new UI/HTTP surface. There is still no HTTP
endpoint or web UI anywhere in this service. Verified via real CLI
subprocess tests (`test/cli.hardening.test.js`, `execFileSync` against the
actual compiled CLI, including real shell commands via
`WAYDOCS_AI_FIXTURE_RESET_CMD=true`/`false`) plus 178/178 for the full
package. See `context/phase-10/review.md`.

### Closing note — spec complete, branch left unmerged for human review

This was **Phase 10 of 10 — the last phase of this spec**. Per the
orchestrating agent's explicit instruction, **no merge into `main` was
performed.** The branch `feature/ai-tutorial-video-generator` and the
worktree `.worktrees/ai-tutorial-video-generator` are left exactly as they
are, fully committed, for a human to review and merge themselves.

Every commit on `feature/ai-tutorial-video-generator` (branched from
`main` at `8fb9b21`), oldest to newest:

```
e755bbf feat: ai-tutorial-video-generator phase 1 — tutorial-plan.json schema & interface contract
1d7a774 feat: ai-tutorial-video-generator phase 2 — orchestration service shell & trigger interface
777743e feat: ai-tutorial-video-generator phase 3 — staging / destructive-action safety guardrails
d23cd5c feat: ai-tutorial-video-generator phase 4 — documentation agent (WayContext understanding & outline generation)
a6ab129 feat: ai-tutorial-video-generator phase 5 — credential handling & secrets resolution
07eda34 feat: ai-tutorial-video-generator phase 6 — Playwright execution runner & recording
59dbcc3 feat: ai-tutorial-video-generator phase 7 — narration script & TTS synthesis
e141f72 feat: ai-tutorial-video-generator phase 8 — Video assembly (FFmpeg mux, effects, masking)
ad94615 feat: ai-tutorial-video-generator phase 9 — approval lifecycle & publish gate
bc85df5 feat: ai-tutorial-video-generator phase 10 — hardening: idempotency, failure taxonomy, observability
```

## Pending cross-phase decisions

These are spec-level open questions (§ 19) with a proposed but unconfirmed
answer in § 19.1, each relied on by more than one phase. Do not treat the
§ 19.1 text as settled — the spec itself says nothing there overrides § 5–15
until accepted (L897–901). Whichever phase resolves one first should confirm
it with the human checkpoint and record the final answer here so later
phases don't re-litigate it.

- **Q-001 — delivery shape** — **RESOLVED by Phase 2** (spec L799-808,
  resolution L902-908 adopted as-is): WayDocs AI ships as a **separate
  orchestration service** (`services/waydocs-ai/`, this repo, sibling of
  `src/`) that consumes WayContext as an MCP client — not new tools on the
  existing WayContext MCP server. See `## Phase 2` above for the full
  rationale, including repo-structure evidence (npm-publish `"files"`
  boundary) that reinforced the spec's own reasoning. Phase 9: the
  approval-trigger authorization surface lives inside
  `services/waydocs-ai/` (this phase left authz itself unimplemented —
  see Phase 2's "not in scope" list).

- **Q-002 — "what deserves a tutorial"** — **RESOLVED by Phase 4** (spec
  L809-818, resolution L909-915 adopted in substance, adapted in
  mechanism): no automatic business-entity extraction; candidates come
  only from WayContext's UI-index tools. Adaptation: those tools
  (`find_ui_element`/`get_ui_context`/etc.) turned out to be resolve-by-
  hint/lookup-by-id only, not enumerable (a Locate finding, not visible
  from the spec text) — so v1 discovery is **seed-driven confirmation**
  (operator/config-supplied `{ section, workflow, text, screen? }` hints
  checked against WayContext) rather than unqualified automatic listing.
  False-positive control: only `ownership === "application"` candidates
  are ever proposed. **No numeric miss/false-positive threshold is set**
  — the spec itself declines to set one; mitigated by Phase 9's human
  outline-approval gate, not an algorithmic cutoff. See `## Phase 4` above
  for the full contract (`services/waydocs-ai/src/outline/
  outlineGenerator.js`: `generateOutline`/`runOutlineStage`/etc.) — Phase
  9's outline-approval gate's pass/fail criterion is: does the human
  approve `outline.sections`, informed by `outline.misses`.

- **Q-003 — destructive-action enforcement + prod detection** — **RESOLVED
  by Phase 3** (spec L820-829, resolution L917-925 adopted as-is in
  substance): two independent mechanisms — (1) a staging-URL allowlist
  checked against every `goto` step's URL, fails closed; (2) destructive
  steps (keyword-classified) permitted only when the caller asserts
  `planApproved: true`. See `## Phase 3` above for the full contract
  (`services/waydocs-ai/src/safety/guardrails.js`:
  `assertRunGuardrails`/`assertStepPermitted`/etc.). **AC-007's "designated
  test account" half**: not covered by Phase 3's schema-level check (no
  account/identity field exists in Phase 1's schema) — **partially closed
  by Phase 6**, which is the first phase able to observe live browser
  session state; see `## Phase 6` above for the opt-in
  `designatedAccount`/`verifyDesignatedAccount` mechanism and its
  remaining "fully automatic detection" gap. Phase 6 calls these gate
  functions at the moment it drives the browser (`assertRunGuardrails`
  once at run start, `assertStepPermitted` per step) and derives the
  `planApproved` boolean from `run.stage === "approved"` (Phase 9's
  eventual approval-gate `stage` value — Phase 9 must set exactly this).

- **Q-004 — change detection / re-plan vs. re-execute** — **FULLY RESOLVED**
  (spec L831-838, resolution L926-935 adopted in *signal*, not in literal
  verb). **Signal half RESOLVED by Phase 6**: an unresolvable `target`
  mid-execution (a Playwright action timeout) IS the "changed" signal — no
  separate diffing mechanism. Phase 6 aborts immediately (no skip, no blind
  continuation) and records `run.stage = "changed"` + `run.changed = {
  stepIndex, action, target, reason: "target_unresolved" }`, but does
  **not** itself re-plan — that requires an AI planning pass this
  execution-only module doesn't have (REQ-004). See `## Phase 6` above
  (`services/waydocs-ai/src/execution/executor.js`). **Trigger half
  RESOLVED by Phase 10**: `services/waydocs-ai/src/execution/replanTrigger.js`
  (`needsReplan`/`triggerReplan`) turns the signal into an actual stage
  transition (`"changed"` → `"planning"`, Phase 9's own `rejectedStage`
  value) plus an audit trail (`run.replanTriggers[]`), exposed via
  `waydocs-ai replan <runId>`. **Still open, by design, not an oversight**:
  neither phase re-invokes Phase 4's outline generator or any AI planning
  pass automatically — REQ-004 keeps that judgment out of the deterministic
  layers this system has built so far; an actual automatic Maintenance-mode
  re-plan pipeline (deciding what to re-plan with, then acting) remains
  future work with no contract yet to build against.

- **Q-005 — multi-language scope** — **FULLY RESOLVED** (spec L840-847,
  resolution L936-942, adopted as-is): one language per plan in v1, no
  multi-variant plans; captions inherit `language`; narration language
  independent of site UI language. **Schema half RESOLVED by Phase 1**:
  `language` is a required scalar string field (min length 2, not a closed
  enum) on `tutorial-plan.json`. **TTS/narration half RESOLVED by Phase
  7**: `services/waydocs-ai/src/narration/script.js` and `ttsProvider.js`
  read `plan.language` only — no code path anywhere in the module reads,
  infers, or requires a site/UI language, which makes EDGE-006's
  "independent by design" true by construction rather than by an explicit
  guard. See `## Phase 7` above for the full contract
  (`buildNarrationScript`/`synthesizeNarrationAudio`/`runNarrationStage`).
  Phase 8's caption generation is expected to build captions directly from
  `run.narration.segments[].text` + timing, inheriting
  `run.narration.language` — no separate caption-language decision left
  open.

- **Q-006 — approval gate semantics** — **RESOLVED by Phase 9** (spec
  L849-857, resolution L944-948, adopted as-is): mandatory/non-bypassable in
  v1 (REQ-016 SHOULD → MUST); approve/reject only, no partial/edit-in-place,
  no single-step re-run; a rejected run returns to the `"planning"` stage
  (for both gate points alike), which never discards prior pipeline
  artifacts since `updateRun` merges additively. See `## Phase 9` above
  (`services/waydocs-ai/src/approval/approvalGate.js`:
  `requestApproval`/`approveRun`/`rejectRun`/`assertOutlineApproved`/
  `assertPublishApproved`, plus new `waydocs-ai request-approval|approve|
  reject` CLI commands) for the full contract, including why the outline
  gate's `approvedStage` is forced to be the literal string `"approved"` by
  Phase 6's pre-existing `planApproved` default. **Depended on by:** Phase 4
  (the "rejected → planning" transition re-enters the outline stage Phase 4
  owns — Phase 9 only sets `stage: "planning"`; re-running Phase 4's
  `runOutlineStage` to actually produce a new outline is not automatic).
  **Still open, reassigned to Phase 10**: Phase 3/6's guardrail mechanism
  only gates *destructive* steps on plan approval, not *all* execution on
  outline approval as Q-002's "before any recording" wording implies — see
  Phase 9's "Known integration gap" above.

- **Q-008 — idempotency / staging state reset** — **FULLY RESOLVED** (spec
  L869-876, resolution L956-963): automated fixture/seed reset before each
  run, run-level repeatability instead of plan-level idempotency.
  **Guardrail half RESOLVED by Phase 3**: a new run-record field
  `fixturesReset` (boolean, + `fixturesResetAt` ISO8601) and a
  precondition function `assertFixturesReset(run)` (in
  `services/waydocs-ai/src/safety/guardrails.js`) that refuses to proceed
  unless the flag is `true` — see `## Phase 3` above. **Reset-hook
  implementation half RESOLVED by Phase 10**:
  `services/waydocs-ai/src/safety/fixtureReset.js`'s `resetFixtures(runId,
  options)` — an injectable reset mechanism (operator-configured shell
  command via `WAYDOCS_AI_FIXTURE_RESET_CMD`, or an injected `runner`),
  calling `updateRun(id, { fixturesReset: true, fixturesResetAt:
  <ISO8601> })` on success and leaving the flag false/absent + recording a
  structured failure on error, so Phase 3's guardrail keeps blocking
  execution on any reset failure. Exposed via `waydocs-ai reset-fixtures
  <runId>`. See `## Phase 10` above for the full contract. **Note:** this
  module defines the calling convention and bookkeeping, not a
  project-specific reset script itself — an operator supplies the real
  command at deploy time, exactly as Phase 3 anticipated.

- **Q-009 — credential handling** — **FULLY RESOLVED** (spec L878-886,
  resolution L964-969): plans reference credentials by name/env-var,
  resolved from a secrets store at execution time; password keystrokes are
  not recorded or are blurred in the final video. **Name→value resolution
  half RESOLVED by Phase 5** (schema half already resolved by Phase 1):
  env-var-backed store, namespaced under `WAYDOCS_AI_CREDENTIAL_<REF>` —
  see `## Phase 5` above (`services/waydocs-ai/src/secrets/credentialStore.js`:
  `resolveCredential`/`assertCredentialsResolvable`/etc.). **Timing metadata
  half RESOLVED by Phase 6**: `services/waydocs-ai/src/execution/executor.js`
  calls `assertCredentialsResolvable(plan)` pre-flight and `resolveCredential`
  per credential-derived `type` step at the moment of use only, never writing
  a resolved value into a run record, log, or narration text (verified by a
  test reading the persisted run JSON back off disk), and records
  `run.credentialSteps: [{ stepIndex, startedAt, endedAt }]` — see `## Phase
  6` above. **Video-masking half RESOLVED by Phase 8**:
  `services/waydocs-ai/src/assembly/masking.js` correlates
  `run.credentialSteps`' wall-clock timestamps against the video's own
  timeline (approximated via `run.history`'s `{status:"running",
  stage:"executing"}` entry, since Phase 6 records no exact
  recording-start timestamp) and `filterGraph.js` burns in a full-frame
  black mask over each padded time range (1500ms padding by default, to
  absorb the timestamp approximation — deliberately over-masking, per
  Q-009's "don't record raw input on password fields... or blur that
  region" intent). **Masking is temporally approximate (padded) and
  spatially full-frame only** (no cursor/element region data exists
  anywhere upstream to scope it more tightly) — both documented as open
  precision gaps for Phase 6/10 to close if Phase 6 is later extended to
  record a precise recording-start timestamp and/or on-screen input-field
  coordinates. See `## Phase 8` above for the full contract, including how
  masking correctness was verified (real pixel measurement on the actual
  assembled output, not just "no exception thrown").

- **Schema versioning** (spec L322-324 NOTE MISSING; §6.2.3 L366 NOTE
  MISSING): no source establishes a `tutorial-plan.json` schema-version
  field, yet plans are committed to Git and replayed by a runner that will
  evolve (§13, L627-629). Depended on by: Phase 1 (must decide whether to
  add a version field even though the spec doesn't require one), Phase 6
  (the runner is the schema's actual compatibility boundary).
