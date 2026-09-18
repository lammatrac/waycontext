# Phase 9 plan — Approval lifecycle & publish gate

## Spec slice recap

- §6.2.1 (L328-346): state table `... assembling -> awaiting approval -> published
  (Human approves)`. NOTE [MISSING]: no failure states, no defined behavior for a
  rejected run, no recovery for a stuck run.
- REQ-016 (L237-247): human-approval step before publishing SHOULD always remain;
  NOTE [AMBIGUOUS] on whether it's mandatory/non-bypassable — resolved by Q-006.
- AC-008 (L703-710): given a completed, assembled video, when no human has
  approved it, then it is not published.
- Q-006 (L849-857) + resolution (L944-948): mandatory/non-bypassable in v1;
  approve/reject only (no edit-in-place, no single-step re-run); rejected run
  returns to planning. Upgrades REQ-016 SHOULD -> MUST.
- Q-002 outline-gate tie-in (L909-915): require human sign-off on the *outline*
  before any recording — a distinct gate from the REQ-016 publish gate, sitting
  between "plan ready" and "recording" in the state table.

## Contracts this phase must honor (already committed, not renegotiable)

- Phase 2 `runStore.js`: `status` stays in `RUN_STATUSES` (`pending|running|
  succeeded|failed`) — approval states live in `stage`, which is free-form/
  phase-owned. `updateRun(id, patch)` merges additively, never renames fields.
- Phase 6 `executor.js` (already `done`, not edited by this phase): its
  `planApproved` option **defaults to `run.stage === "approved"` literally** —
  this phase's outline-approval gate's *approved* stage value MUST be exactly
  `"approved"`, not some other string, or Phase 6's default silently does
  nothing.
- Phase 8: `run.assembly.outputPath` is the artifact the publish gate is
  gating; `run.stage === "assembled"` is set by `runAssemblyStage` right
  before this phase's publish gate should open.
- Phase 4: `run.stage === "outline"` is set by `runOutlineStage` right before
  this phase's outline gate should open. Its pass/fail criterion (per this
  phase's brief) is Phase 4's own Q-002 resolution (only `ownership ===
  "application"` candidates are ever proposed) — i.e., the human reviews
  `outline.sections` (and `outline.misses`), nothing new to check here.

## Design

One reusable gate primitive, `services/waydocs-ai/src/approval/approvalGate.js`,
parameterized by a gate definition (`APPROVAL_GATES.outline` /
`APPROVAL_GATES.publish`), applied at both pipeline points instead of two
bespoke modules:

- `requestApproval(runId, gateName, options?)` — moves a run from its "ready"
  stage into that gate's `awaitingStage`. Idempotent if already awaiting.
- `approveRun(runId, gateName, options?)` — moves `awaitingStage` ->
  `approvedStage`. Records an entry in a new additive `run.approvals[]` field.
- `rejectRun(runId, gateName, options?)` — moves `awaitingStage` ->
  `rejectedStage` (Q-006: always `"planning"`). Same `run.approvals[]` record.
- `assertOutlineApproved(run)` / `assertPublishApproved(run)` — precondition
  assertions (AC-008's actual enforcement point), mirroring Phase 3's
  `guardrails.js` pattern: a function a future caller (execution / an eventual
  real "publish" action) is expected to call, not itself wired into Phase 6/8
  (which are already `done` and out of this phase's edit scope).

Gate table:

| gate    | readyStages | awaitingStage               | approvedStage | rejectedStage |
|---------|-------------|------------------------------|----------------|----------------|
| outline | `["outline"]` | `awaiting_outline_approval` | `approved`     | `planning`     |
| publish | `["assembled"]` | `awaiting_approval`       | `published`    | `planning`     |

`approvedStage: "approved"` for the outline gate is not a free choice — it's
forced by Phase 6's existing contract (see above). `awaitingStage:
"awaiting_approval"` for the publish gate matches spec §6.2.1's own state
name verbatim. Both `rejectedStage` values are `"planning"`, matching Q-006's
resolution text exactly ("a rejected run returns to planning"); this is safe
because `updateRun` never deletes fields — `run.outline`/`run.narration`/
`run.assembly`/etc. all remain inspectable after a rejection, only `stage`
changes.

Q-006 "approve/reject only, no partial/edit-in-place, no single-step re-run"
is honored by construction: the module exposes no edit/partial-approval
function, only whole-run approve/reject.

CLI (extends Phase 2's `cli.js`, same `parseFlags`/`printJson` conventions):

```
waydocs-ai request-approval <runId> --gate outline|publish
waydocs-ai approve <runId> --gate outline|publish [--approved-by NAME]
waydocs-ai reject <runId> --gate outline|publish [--rejected-by NAME] [--reason TEXT]
```

## Files

- New: `services/waydocs-ai/src/approval/approvalGate.js`
- New: `services/waydocs-ai/test/approval.approvalGate.test.js`
- Edit: `services/waydocs-ai/src/cli.js` (add `request-approval`/`approve`/`reject`
  commands + help text)
- New: `services/waydocs-ai/test/cli.approval.test.js` (real CLI subprocess
  tests, following `cli.test.js`'s `execFileSync` pattern)
- Append: `docs/specs/ai-tutorial-video-generator/contracts.md` (`## Phase 9`
  section + update `## Pending cross-phase decisions`)

## Known gap to record, not fix (out of this phase's edit scope)

Phase 3/6's guardrail mechanism only gates *destructive* steps on
`planApproved` — it does not gate *all* execution on outline approval. Q-002's
resolution says human sign-off on the outline is required "before any
recording," not just before destructive steps. Since Phase 6 (`executor.js`)
is already `done` and this phase's brief scopes it to building the gate
mechanism (not rewiring Phase 6), this is recorded as an open integration gap
in `contracts.md` for whichever phase next touches `executor.js` (plausibly
Phase 10) — `assertOutlineApproved(run)` is exported specifically so that
phase has a ready-made assertion to call at the top of `executeTutorialPlan`.

## Gate re-check (risk)

Upfront: Rev1/Sec1/Con0/Blast1/Infra1/Amb2 = 6, checkpoint yes.
After Locate: no new coupling, no new dependency, no concurrency concern (same
single-writer JSON-file pattern as every other phase). The one discovery (the
destructive-step-only gating gap above) is a pre-existing integration gap in
already-`done` code, not something this phase introduces or must fix — it's
recorded, not escalated. No dimension moves to "high". Proceeding to Code.
