STATUS: DONE

Verified (worktree `.worktrees/browser-session-manager`):
- `npm test`: tests 987, pass 986, fail 0, skipped 1 (P3 baseline 939/938/0/1; +48 tests, same single skip). Run twice, stable.
- Unit tests with the fake adapter (34): lifecycle + audit, secret_missing with no launch, state_missing, verification/login boundary, EXPIRED, rejections, isolation, ownership (dead pid, live pid, remote host lease), runtime_lost, close idempotence, session_busy, idle timeout (also not tearing down an in-flight call), expire(), shutdown, profile-removal hook, AC-005 scan.
- Real Chromium e2e (7) against a local `http.createServer` form-login fixture: wrong password, fresh_login -> READY with state file 0600 outside the project root, saved_state -> READY without secrets, close leaves no child browser, site invalidation -> EXPIRED/state_expired, two sessions do not share cookies, disallowed login redirect -> FAILED with zero requests at the foreign server, SIGKILL of the browser -> runtime_lost, AC-005 scan over results/logs/stderr/DB rows/audit rows (no password, wrong password, cookie value or username).
- CLI end to end (fixture on 127.0.0.1, fake secrets): `browser_session_start` -> READY; `browser_session_status` from a new process -> `CLOSED` (the CLI process shutdown closed it, by design); `browser_session_close` -> `CLOSED`; state file mode 600. Same flow through the stdio MCP server in one process: READY -> status READY -> CLOSED.
- Browser check: claude-in-chrome is not applicable. The target is a headless Playwright Chromium driven by the adapter, not the user's Chrome, and the ops are MCP/CLI only; the real-Chromium e2e test and the CLI/MCP runs above are the observable check.

Not verified / caveats:
- A READY session started from a one-shot CLI command cannot be used by a later CLI command (separate processes); only a long-lived stdio MCP process holds sessions. This follows spec 6.2.2.
- Pid reuse on the same host reads as "alive" (session_not_in_this_process); remote-host liveness is lease-based only.
- `close` of an already-FAILED session returns status FAILED, not CLOSED (FAILED is terminal per 6.2.1).
- Edited the P3 leak test (`browser.adapter.playwright.test.js`) because parallel files made its system-wide process count flaky.
