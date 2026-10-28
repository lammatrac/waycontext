# P6 plan — human-only browser-login CLI (REQ-017)

Files (worktree `.worktrees/browser-session-manager`):
- `src/browser/loginCapture.js` (new): `captureLogin`, `promptForEnter`, `DEFAULT_LOGIN_TIMEOUT_SECONDS`.
- `src/browser/sessionManager.js`: extract the REQ-011 check into exported `verifyAuthenticated(runtime, def, {waitMs})`; the manager's inner `verify` delegates (no behaviour change).
- `src/browser/errors.js`: add thrown codes `verification_failed`, `login_timeout`, `login_cancelled`.
- `src/cli.js`: `case "browser-login"` (human-only, not in `operations`); `src/completion.js`: MANUAL_COMMANDS entry; `test/fixtures/help.txt` regenerated.
- Tests: `test/browser.login.test.js` (fake adapter, 15), `test/browser.login.playwright.test.js` (real Chromium, headed when a display exists, 3).

Gate re-score: reversibility low, security surface medium (headed browser, saved state; reuses P2 store + P3 guard, no new secret handling since the human types credentials), concurrency low, blast radius low (one small shared refactor), infra none, ambiguity low after settling the completion signal. No dimension rose to high.

Decision: completion = human presses Enter (injected `waitForDone`), bounded by a timeout; no polling.
