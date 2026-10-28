# P5 plan — Navigate and screenshot ops

Files (worktree .worktrees/browser-session-manager):
- src/browser/ops.js: add browserNavigateOp, browserCaptureScreenshotOp via a guardedSession() helper over guarded() + manager.withSession; login-redirect detection (isLoginUrl).
- src/browser/sessionManager.js: withSession callback also receives `stateDir` and `rootPath` (additive).
- src/browser/adapter.js, playwrightAdapter.js, fakeAdapter.js: screenshot({ fullPage }); playwright goto settles Chromium's chrome-error page after a blocked navigation so the session stays usable.
- src/operations.js, src/completion.js, test/fixtures/help.txt, test/operations.test.js: register ops, help, writers list.
- Tests: test/browser.navigateOps.test.js (fake adapter), test/browser.navigateOps.playwright.test.js (real Chromium).

Gate re-score: reversibility 0, security 2 (as manifest; guard already in P3, redaction/guarded reused), concurrency 1 (busy lock from P4), blast radius 1, infra 0, ambiguity 1. No escalation.
