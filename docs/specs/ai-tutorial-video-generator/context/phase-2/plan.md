# Phase 2 plan — Orchestration service shell & trigger interface

## Q-001 decision (owned by this phase)

Adopt § 19.1's proposed resolution: WayDocs AI ships as a **separate
orchestration service** that consumes WayContext as an MCP client, not as
new tools on the WayContext MCP server. Rationale carried over from the
spec (L902-908): WayContext is read-only code intelligence with no state;
WayDocs AI has runs, approvals, media files, credentials, and third-party
LLM/TTS calls — a different lifecycle and risk profile. Keep WayContext a
dependency, not a host.

**Evidence from the actual repo (this is the WayContext MCP server itself)
that reinforces this choice**: root `package.json` `"files"` whitelists
`src/` for npm publish as the `waycontext` package (engineering-intel MCP
server). Phase 1 put `src/tutorial/schema.js` inside that same `src/`
tree, provisionally. If WayDocs AI's orchestration code stayed there, a
credentials/media-handling, third-party-LLM-calling service would ship
inside the published `waycontext` npm package — exactly the "different
risk profile, don't host it" problem Q-001's resolution warns against, just
one level down (package boundary, not MCP-tool-registration boundary).

**Decision**: create a new top-level directory, `services/waydocs-ai/`,
as its own package (own `package.json`, own `src/`, own `test/`), outside
`src/`. It is not part of the `waycontext` npm publish set. It resolves
`zod` via Node's directory-walking `node_modules` resolution against the
repo root for now (monorepo-style, no npm workspaces yet — noted in
contracts.md as a follow-up for whichever phase first needs to deploy
this service independently).

Consequence: relocate Phase 1's schema module from `src/tutorial/schema.js`
to `services/waydocs-ai/src/tutorial/schema.js` (and its test), via `git mv`
to preserve history. Phase 1's contracts.md section gets a note (not a
rewrite) pointing at the new path.

## Trigger interface

Spec explicitly leaves the trigger/read-result surface undefined
(§6.2.3 NOTE MISSING, §8 API NOTE MISSING) and only commits to one
concrete trigger for now: "Generate mode trigger: an operator request at
handoff time" (§6.2.7). Maintenance-mode (CI-on-deploy) trigger is
explicitly flagged "(later phase)" — out of scope here.

Chosen shape, minimal and dependency-free:
- A file-backed run store (`services/waydocs-ai/src/orchestrator/runStore.js`)
  so a run created by one CLI invocation can be read back by a later one
  (in-memory would not survive process exit, which the two-step
  trigger/read-status flow requires). Runs persist as one JSON file per
  run under a runs directory (default `services/waydocs-ai/.runs/`,
  overridable via `WAYDOCS_AI_RUNS_DIR`).
- Coarse `status` enum (`pending|running|succeeded|failed`) owned by this
  phase, plus an open `stage` string later phases (4/6/9) can set without
  renegotiating this contract.
- A thin CLI (`services/waydocs-ai/src/cli.js`) wrapping the store:
  `run <target>`, `status <runId>`, `list`. This is the concrete
  "operator request" trigger for Generate mode.

Out of scope for this phase (left as open follow-ups, noted in
contracts.md): actual pipeline stage logic (Phase 4 outline, Phase 6
execution, Phase 9 approval), queueing/concurrency, HTTP/CI trigger for
Maintenance mode, and any MCP-client wiring to WayContext itself (this
phase stands up the shell that later phases will call into and extend,
not the WayContext-consuming logic).

## Files

- `git mv src/tutorial/schema.js services/waydocs-ai/src/tutorial/schema.js`
- `git mv test/tutorial.schema.test.js services/waydocs-ai/test/tutorial.schema.test.js`
- New: `services/waydocs-ai/package.json`
- New: `services/waydocs-ai/.gitignore` (`.runs/`)
- New (TDD): `services/waydocs-ai/src/orchestrator/runStore.js`,
  `services/waydocs-ai/test/orchestrator.runStore.test.js`
- New (TDD): `services/waydocs-ai/src/cli.js`,
  `services/waydocs-ai/test/cli.test.js`
- Update: `docs/specs/ai-tutorial-video-generator/contracts.md`
  (Phase 1 section note + new Phase 2 section + Q-001 resolved)

## Gate re-check

No new risk surfaced by Locate that the upfront score (9, checkpoint:
yes) didn't already anticipate. The repo-structure evidence above
*reinforces* the security/blast-radius reasoning behind Q-001's proposed
answer rather than contradicting it — nothing here escalates. Proceeding
with implementation under the existing checkpoint (checkpoint = report to
human at the end via the existing spec-phase-runner flow, not a blocking
gate before code, per this project's process notes).
