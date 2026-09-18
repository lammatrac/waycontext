STATUS: DONE

## Gate re-check (before coding)

Locate surfaced nothing the upfront spec-text risk score didn't already
account for: Phase 1's schema (`tutorialPlanSchema`) and Phase 2's
`runStore.js` (`updateRun`'s additive-patch contract) are exactly as
documented in contracts.md — no hidden coupling, no concurrency surface,
no scope larger than "build a script from a plan, synthesize fake audio,
bridge into the run store." Risk score unchanged at 3 (0/1/0/0/1/1); no
escalation.

## What was verified

- `services/waydocs-ai` full package suite: **105/105 passing**
  (`npm test`), up from 95/95 before this phase (10 new tests: 3 in
  `narration.script.test.js`, 6 in `narration.ttsProvider.test.js`, 1 in
  `narration.narrationStage.test.js`). The previously-flaky
  `orchestrator.runStore.test.js` tie-break test (documented as
  pre-existing/unrelated in Phase 4's and Phase 5's review notes) passed
  on this run.
- No network call anywhere in this phase's code or tests. Grepped the new
  modules and tests: only `node:fs`, `node:path`, `node:os`, `node:crypto`
  are imported — no `http`/`https`/`fetch`/any HTTP client. The TTS
  "synthesis" is `createLocalTtsProvider`, which writes a real (tiny,
  silent, deterministic-length) `.wav` file to a local temp/media
  directory and never reaches out to a real TTS API. Every test uses this
  local provider.
- Security property spot-checked by test: a synthesized (fallback)
  narration line for a `credentialRef` `type` step never contains the
  `credentialRef` name (`narration.script.test.js`, "never leaks a typed
  value or credentialRef into synthesized narration").

## TDD process note (disclosed, per this phase's own required honesty)

Two small process deviations from strict single-assertion-at-a-time
RED-GREEN, both minor and both left as-is rather than redone, since
redoing them wouldn't change the resulting code, only the order tests
were added in:

1. `narration.script.test.js`'s first test (RED confirmed, GREEN written
   minimally) initially prompted an over-eager first implementation that
   handled all three action fallbacks before a test demanded it. Caught
   before commit — production code was reverted back to the minimal
   "narration present" case, the fallback tests were then written and
   watched fail (RED) against the reverted module, and the fallback
   switch was re-added only in response to that failure. This is
   reflected in the final module/tests as normal TDD; noting it here
   because the first draft briefly violated the Iron Law before being
   corrected.
2. `narration.ttsProvider.test.js`'s two rejection tests (empty text,
   missing language) were added and found already passing, because the
   `createLocalTtsProvider` GREEN step for the main happy-path test had
   already implemented both guard clauses in the same pass (small,
   directly adjacent to the code that step required). They were not
   re-driven through their own individual RED cycle. Functionally
   equivalent to Phase 6's disclosed "cohesive unit" note in its own
   review.md — small guard-clause pairs written together rather than
   split into artificially separate increments. No behavior exists in the
   final code that wasn't exercised by a test that was watched to fail
   for the right reason at some point in this phase.

## Browser verification

Skipped, explicitly. This phase has no HTTP endpoint, CLI command, or UI
surface of its own — narration script building and (fake) TTS synthesis
are internal library functions, not reachable from a browser. Nothing in
Phase 7 changes `cli.js` or adds any new trigger surface.

## Q-005 resolution — narration language, as implemented

Fully resolved by this phase (schema half was already done by Phase 1).
Implementation is close to a structural no-op, which is itself the point:
`buildNarrationScript` and `synthesizeNarrationAudio` read `plan.language`
and nothing else — no code path in this module inspects, infers, or
requires a site/UI language. This makes EDGE-006's "independent by
design" resolution true by construction rather than by an explicit check:
there is nothing in the codebase for Phase 7 to detect a site's UI
language even if it wanted to. `language` also becomes the value
downstream caption generation (Phase 8) should key off, per §19.1
("captions default to matching language").

## EDGE-007 — explicitly not solved here

Narration/video duration mismatch is `NOTE [MISSING]` in the sources.
This phase does not attempt any alignment, stretching, or trimming. What
it does provide, so Phase 8 *can* solve it: exact `durationMs` per
narration segment (from `estimateDurationMs`, the local fake's stand-in
for real audio-duration measurement) and cumulative `startMs`/`endMs`
timing across the whole script. A real TTS provider would report a real
measured duration in the same shape.

## Scope decision recorded (not an escalation)

REQ-008 says "producing an audio track for the tutorial." This phase
produces **one audio file per narration segment** (Playwright per-step
alignment) plus timing metadata, not a single concatenated master track —
concatenating audio into one file is an FFmpeg job, and FFmpeg is Phase
8's dependency per the manifest ("Video assembly (FFmpeg mux, effects,
masking)"), not this phase's. This keeps Phase 7 dependency-free (no new
npm package beyond what already exists) and gives Phase 8 finer-grained
per-step timing than a single pre-merged track would. Recorded in
contracts.md below.
