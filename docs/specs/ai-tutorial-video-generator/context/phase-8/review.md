STATUS: DONE

## What was verified

- `npm test` in `services/waydocs-ai`: **135/135 passing** (105 pre-existing
  + 30 new from this phase: 7 `assembly.masking.test.js`, 3
  `assembly.captions.test.js`, 7 `assembly.filterGraph.test.js`, 4
  `assembly.ffmpegRunner.test.js`, 6 `assembly.videoAssembler.test.js`, 3
  `assembly.assemblyStage.test.js`). This run did not hit the pre-existing
  `orchestrator.runStore.test.js` same-millisecond flake (not this phase's
  code, per the assignment brief).
- **Real `ffmpeg`/`ffprobe` 4.4.2 were used throughout** — verified present
  in this environment (`ffmpeg -version` / `ffprobe -version` before
  starting), so no stubbing was needed anywhere. Every integration test in
  `assembly.videoAssembler.test.js` and `assembly.assemblyStage.test.js`
  spawns the real binaries against small local synthetic inputs (a
  `testsrc` lavfi-generated video, real silent `.wav` narration segments
  produced by Phase 7's own `createLocalTtsProvider`) — no network access
  anywhere.
- **Masking correctness was verified by actually measuring pixels**, not
  just by asserting no exception was thrown: the assembled output's frame
  brightness was sampled inside vs. outside a credential step's (padded)
  time range and asserted near-black (<15/255) inside vs. clearly non-black
  (>30/255) outside — see
  `assembly.videoAssembler.test.js`, "masks the frame during a credential
  step's time range but not outside it".
- EDGE-007 (narration/video duration mismatch) was verified both
  directions are handled without truncation: a short video + long
  narration test asserts the output duration reaches the narration length
  (video padded via `tpad`), and every other test implicitly exercises the
  video>=narration case (audio padded via `apad`). Confirmed `-shortest` is
  never present in the built argv (would silently truncate the longer
  track — the wrong failure mode for a "don't lose content" requirement).
- Captions (soft `mov_text` subtitle stream) verified present via
  `ffprobe`'s stream-type listing on the real output file, and the
  `.srt` file's existence/format verified separately by pure unit tests
  (`assembly.captions.test.js`).
- Opt-in cursor-highlight/zoom filters verified with one real-ffmpeg
  integration test proving the generated filter graph actually executes
  without breaking the pipeline (produces a valid video+audio output);
  their filter-string construction itself is unit-tested at the pure
  function level in `assembly.filterGraph.test.js`, including verifying no
  region/coordinate data comes from anywhere but the caller (nothing
  upstream produces it automatically).
- `runAssemblyStage`'s error paths (missing `run.recording`, missing
  `run.narration`) verified via `assert.rejects` against a real run created
  through Phase 2's `triggerRun`/`updateRun`.

## TDD process note

Followed strict RED-GREEN for every module: `masking.js`, `captions.js`,
`filterGraph.js`, `ffmpegRunner.js` (all pure or execFile-wrapper logic)
went through the full cycle with the test written and observed failing
(`ERR_MODULE_NOT_FOUND` / assertion failure) before the implementation
existed. `videoAssembler.js`'s integration tests were also written first
and observed failing (`ERR_MODULE_NOT_FOUND`), then the orchestration code
written to satisfy them — this surfaced two real bugs during the
GREEN step that the tests correctly caught:
1. An unbounded `anullsrc` lavfi source (used when a plan has zero
   narration segments) caused ffmpeg to hang indefinitely once `-shortest`
   was deliberately removed (see "EDGE-007" above) — fixed by giving
   `anullsrc` an explicit `duration`.
2. ffmpeg's positional option parsing rejected a captions `-i` added after
   the `-filter_complex`/`-map` flags that referenced it — fixed by
   reordering `buildMainArgs` so all `-i` inputs are declared before any
   `-filter_complex`/`-map`.
Both were caught by the integration tests failing for the right reason
(ffmpeg's own stderr, not a typo), not discovered later — exactly the
"watch it fail correctly" discipline TDD is meant to enforce.

## What wasn't verified / explicit limitations

- **Browser verification: skipped, explicitly.** This phase has no
  HTTP endpoint, CLI wiring, or UI surface — `runAssemblyStage` is a
  callable stage function only (same pattern as Phase 4/7's
  `runOutlineStage`/`runNarrationStage`), not wired into `cli.js` or any
  browser-reachable path. Nothing for `claude-in-chrome` to exercise.
- **Temporal masking precision is an approximation** — see "Gate re-check"
  in `plan.md` and the new contracts.md section: `videoStartedAt` is
  derived from `run.history`'s `{status:"running", stage:"executing"}`
  entry (written just before Phase 6 launches the browser/context), not
  from an actual "video recording started" timestamp, because Phase 6
  never records one. A fixed 1500ms padding on both ends of every mask
  range absorbs this imprecision — deliberately over-masking, per the
  phase brief's explicit "over-masking is acceptable, under-masking is
  not" instruction. Flagged in contracts.md for Phase 6/10 to potentially
  close by having Phase 6 emit a precise recording-start timestamp.
- **Spatial masking is full-frame only** — Phase 6 records no
  cursor/element screen coordinates, so there is no sub-region to mask to;
  full-frame is the documented safe default per the phase brief.
- Real TTS audio (Phase 7 still only has the local silent-`.wav` fake) —
  not this phase's concern; the assembler is TTS-provider-agnostic (it
  only consumes `narration.segments[].audioPath`/`startMs`/`endMs`,
  whatever produced them).
- Intro/outro clip concatenation (REQ-010) was scoped out of this phase's
  implementation after reconsidering time/value tradeoff against the
  phase's own risk budget (Total 3, no checkpoint) — see the deviation
  note in contracts.md. Cursor-highlight and zoom are implemented and
  tested; intro/outro is not.
