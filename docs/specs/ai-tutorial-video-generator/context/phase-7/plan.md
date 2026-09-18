# Phase 7 plan — Narration script & TTS synthesis

## Scope (from spec slice + manifest)

- REQ-008: synthesize narration audio from a narration script via a TTS
  engine, producing an audio track for the tutorial.
- REQ-013 / AC-006: honor the plan's `language` field end-to-end (a `"vi"`
  plan produces narration flagged/synthesized as Vietnamese).
- EDGE-006: narration language and site UI language are independent by
  design (§19.1 resolution) — nothing in this module may read/derive a
  site UI language.
- EDGE-007: narration/video duration mismatch is explicitly NOTE [MISSING]
  in the sources — not solved here; this phase's job is to expose accurate
  per-segment `durationMs` timing so a later phase (8) can reconcile it
  against the recorded video length. No alignment/stretching logic here.
- Q-005: fully resolved as of this phase (Phase 1 already did the schema
  half). Implementation is close to a no-op: the module only ever reads
  `plan.language`, never inspects or infers a site/UI language from
  anything else.

## Files

New directory `services/waydocs-ai/src/narration/`:

1. `script.js` — narration-script builder.
   - `buildNarrationScript(plan)` → `{ language, lines: [{ stepIndex, action, text, source: "plan" | "synthesized" }] }`.
   - Uses `step.narration` verbatim where present (`source: "plan"`).
   - Synthesizes a generic templated fallback line per action
     (`goto`/`click`/`type`) where `narration` is absent (`source:
     "synthesized"`) — deliberately never includes `step.value` or
     `step.credentialRef` in the fallback text (security: narration ends
     up in an audio track / caption source that's part of the published
     video, so it must not leak typed values, consistent with Phase 5's
     no-logging guarantee for credentials and general good practice for
     any typed value).
   - No new external dependency; pure function over Phase 1's validated
     plan shape.

2. `ttsProvider.js` — the synthesis interface + local fake provider.
   - `TtsSynthesisError` — Error subclass, `.details` structured context.
   - `estimateDurationMs(text, wordsPerMinute?)` — deterministic duration
     estimate (word count / wpm), with a floor so empty-ish text still
     gets a duration.
   - `createLocalTtsProvider(options?)` → `{ synthesizeSpeech(text, { language, voice?, outputDir? }) => Promise<{ audioPath, durationMs, language, voice }> }`.
     Writes a real (tiny, silent, deterministic-length) `.wav` file to
     disk under `outputDir` — a genuine local artifact, not a mock —
     computed purely from `estimateDurationMs`. No network call, no
     external binary, no paid API. This is the interface a real provider
     (OpenAI TTS, etc.) must also satisfy.
   - `synthesizeNarrationAudio(script, { provider, language, voice?, outputDir? })`
     → per-line segments with `audioPath`, `durationMs`, `startMs`,
     `endMs` (cumulative), plus `totalDurationMs`.

3. `narrationStage.js` — bridge into Phase 2's run store, mirroring Phase
   4's `runOutlineStage` pattern.
   - `runNarrationStage(runId, plan, { provider, runsDir?, mediaDir?, voice?, generatedAt? })`
     → builds script, synthesizes audio, calls `updateRun(runId, { stage:
     "narrated", narration: {...} })`.

## Tests

`services/waydocs-ai/test/narration.script.test.js`,
`services/waydocs-ai/test/narration.ttsProvider.test.js`,
`services/waydocs-ai/test/narration.narrationStage.test.js` — `node:test`,
TDD red/green per unit. All audio synthesis goes through the local fake
provider; nothing touches the network.

## Contracts to append

- Narration-script builder interface + line shape.
- TTS provider interface (`synthesizeSpeech`) + local fake + what a real
  provider must satisfy (network call, language→voice mapping, real audio
  duration measurement instead of the word-count estimate).
- `runNarrationStage` bridge + `run.narration` shape for Phase 8.
- Q-005 marked fully resolved.
