# Phase 8 plan — Video assembly (FFmpeg mux, effects, masking)

## Gate re-check (risk re-score against real code)

Upfront score: Rev 0 / Sec 1 / Con 0 / Blast 0 / Infra 1 / Amb 1 = 3, no checkpoint.

Locate findings:
- `ffmpeg`/`ffprobe` 4.4.2 are present on this dev machine (`ffmpeg -version` /
  `ffprobe -version` both succeed, libvpx/libx264/libopus etc. all enabled) —
  real invocations are possible for tests, no stubbing needed.
- Phase 6's `run.credentialSteps` gives wall-clock ISO8601 `startedAt`/`endedAt`
  per credential step, but **no wall-clock "video recording started" timestamp**
  is recorded anywhere — only `run.history` entries (`{status, stage, at}`),
  the closest of which is the `{status:"running", stage:"executing"}` entry
  written immediately before the browser/context (and thus video recording)
  is launched. Using that as `videoStartedAt` is an approximation (browser
  launch + context creation happen a small, variable number of ms after that
  timestamp) — this is exactly the kind of thing the phase brief anticipated
  ("if Phase 6's metadata doesn't give you enough ... info, mask the full
  frame ... safe default"). I'm applying the same "over-mask, never
  under-mask" principle to the *temporal* axis too: pad every derived mask
  range by a fixed buffer (default 1500ms) on both ends to absorb this
  imprecision, and mask the full frame (not a sub-region) since Phase 6 also
  never records cursor/element screen coordinates.
- No infra risk surprises: ffmpeg is invoked via a child process (no new
  language runtime), and the only new npm dependency under consideration is
  a thin wrapper — decided against, see below.

None of this raises any dimension to "high". Proceeding without escalation.

## FFmpeg dependency choice

Shelling out to the real `ffmpeg`/`ffprobe` binaries via `node:child_process`
(`execFile`), not adding `fluent-ffmpeg` or any other wrapper package.
Rationale: this package's existing convention (Phase 6) is to depend directly
on the real underlying tool (Playwright) rather than a thin JS wrapper around
a CLI; `fluent-ffmpeg` is unmaintained (no commits in years) and would only
save some `execFile` boilerplate while adding a dependency-freshness/security
surface for a security-relevant module (masking). Verified `ffmpeg -version`
succeeds in this environment, so tests run against the real binary — no
stubbing needed, per the phase brief's ffmpeg-available branch.

## Modules

```
services/waydocs-ai/src/assembly/
  ffmpegRunner.js      # thin execFile wrapper around ffmpeg/ffprobe + probing
  masking.js            # pure: derive video-relative mask time-ranges from
                         # run.history + run.credentialSteps
  captions.js            # pure: build an SRT string from narration segments
  filterGraph.js          # pure: build the ffmpeg filter_complex + argv for
                           # mux + mask + captions + optional zoom/cursor-
                           # highlight/intro/outro
  videoAssembler.js        # orchestrates the above; assembleVideo(...)
  assemblyStage.js          # bridges into Phase 2's run store, mirrors
                             # Phase 4/7's runOutlineStage/runNarrationStage
```

## Scope decisions for REQ-010 (recorded as deviation, not escalation)

REQ-010's own NOTE [AMBIGUOUS] says the source doesn't state whether cursor
highlight/zoom/captions/intro-outro are unconditional, configurable, or
content-conditional. Resolving this in-phase (both source passages — REQ-010
and its NOTE — are in this phase's own spec slice):

- **Captions** — always built from `run.narration.segments[].text` +
  `startMs`/`endMs`, embedded as a soft `mov_text` subtitle stream (not
  burned in) so masking is never obscured by caption text and a viewer can
  toggle them. Default on, no data availability gap.
- **Masking** — always applied over credential-derived ranges; not optional
  (Q-009 is a security requirement, not a cosmetic effect).
- **Cursor highlight** — implemented as an opt-in filter capability
  (`cursorHighlights: [{startMs,endMs,x,y,radius?}]` option) using a
  bordered `drawbox` overlay gated by `enable='between(t,S,E)'`. Off by
  default: nothing upstream (Phase 6) records cursor coordinates, so there is
  no automatic source data — this is honestly scoped as "the assembler can
  apply it if told where", not "the assembler infers cursor position".
- **Zoom** — implemented as an opt-in filter capability
  (`zoomRegions: [{startMs,endMs,rect:{x,y,w,h}}]`) using a time-gated
  `crop` (variable rect expressed via `if(between(t,S,E),...)`) followed by
  a `scale` back to the original frame size, so the output stream keeps a
  constant resolution throughout. Off by default, same "no automatic source
  data" reasoning as cursor highlight.
- **Intro/outro** — implemented as opt-in (`introClipPath`/`outroClipPath`)
  video concatenation (scaled/padded to the main video's resolution,
  silent-audio-padded if the clip lacks an audio stream) via ffmpeg's
  `concat` filter. Off by default — no upstream phase produces intro/outro
  content.

## Test strategy (no network, real local ffmpeg)

- Pure helpers (`masking.js`, `captions.js`, filter-string builders in
  `filterGraph.js`) get plain `node:test` unit tests with no ffmpeg
  invocation at all.
- `videoAssembler.js`'s `assembleVideo` gets integration tests using:
  - a tiny synthetic test video generated via `ffmpeg -f lavfi -i
    testsrc=...` (no network, no external file)
  - real narration `.wav` segments produced by Phase 7's own
    `createLocalTtsProvider` (already network-free, already in this
    package)
  - assertions against the real output file: exists, valid via `ffprobe`,
    has both a video and an audio stream, duration roughly matches the
    longer of {video, narration}, and — for masking — a sampled frame
    inside the masked time range is (near-)solid black while a frame
    outside it is not.
- `assemblyStage.js` gets a unit test using the real `videoAssembler`
  (inputs are tiny, so this stays fast) against a real run created via
  Phase 2's `triggerRun`/`updateRun`.

## Output artifact (binding for Phase 9/10)

`run.assembly = { outputPath, durationMs, maskedRanges: [{stepIndex,
startSec, endSec}], captionsPath, generatedAt }`, `run.stage = "assembled"`.
`outputPath` is an actual `tutorial-final.mp4` file on disk under
`<mediaDir>/<runId>/assembly/`.
