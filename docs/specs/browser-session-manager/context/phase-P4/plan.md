# P4 plan — Session manager and lifecycle ops

Files (in `.worktrees/browser-session-manager`):
- `src/browser/sessionManager.js` (new): state machine, start/status/close/withSession/closeProfileSessions/shutdown, ownership/liveness, idle timer, audit wiring (onBlocked, onClosed).
- `src/browser/ops.js`: per-process manager, `guarded()` (kill switch + redaction), three op handlers, removal-hook registration, `shutdownBrowserSessions`.
- `src/operations.js`: three registry entries (MCP+CLI only). `src/completion.js` OP_HELP, `test/fixtures/help.txt` regenerated.
- `src/config.js`: `browserIdleTimeoutSeconds` (BROWSER_IDLE_TIMEOUT_SECONDS, default 900).
- `src/cli.js`, `src/server.js`: shutdown on exit / signals so no browser outlives its owner.
- Tests: `test/browser.sessionManager.test.js`, `test/browser.sessionOps.test.js`, `test/browser.sessionManager.playwright.test.js`; `test/operations.test.js` writers list; `test/browser.adapter.playwright.test.js` leak test scoped to own children.

Gate re-check (reversibility/security/concurrency/blast/infra/ambiguity): no dimension rose above the manifest score. Concurrency stays moderate: single-process in-memory entries,
synchronous `closing`/`busy` flags set before any await, DB UPDATEs guarded against leaving terminal states. No new infra or dependencies.

New contracts: see the P4 section of contracts.md.
