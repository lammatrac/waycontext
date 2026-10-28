STATUS: DONE

Verified: `npm test` (node --test test/*.test.js) in the worktree: 890 tests, 889 pass, 0 fail, 1 skipped (pre-existing skip).
Baseline before P1 was 841 tests / 840 pass / 1 skipped. New: 49 tests across five browser.*.test.js files.
TDD: each test file was run red (module missing / assertion) before its implementation.

Browser check: P1 has no browser-observable surface (schema, CLI, MCP op, policy library). The one web-facing
surface it touches, the HTTP catalogue/ops/mcp routes, is covered by real-server tests (createServer on an
ephemeral port: 403 on /v1/ops/browser_profile_list, catalogue/health/`/mcp` tools/list exclude browser_*).
No claude-in-chrome run.

Not verified: real-Postgres behaviour beyond the suite's DB; saved-state probe and removal hook are seams only (P2/P4).
Risks noted: new migration file is matched by .gitignore `*.sql`; fixed with `!src/migrations/*.sql`.
