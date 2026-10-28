STATUS: DONE

Verified
- `npm test` in the worktree: 939 tests, 938 pass, 0 fail, 1 skipped (pre-existing). P2 baseline was 914/913/0/1, so +25 tests, all passing.
- Real-Chromium integration tests RAN (not skipped) against local `http.createServer` fixtures (allowed origin A, foreign origin B on a different port): allowed load + primitives; direct, redirect (and chain), `window.location`, popup and `file:` navigations blocked with the foreign server receiving zero requests; same-origin redirect chains and popups still work; two sessions share no cookies; storageState seeding; teardown leaves no chromium process (checked via `ps`); runtime death reports `onClosed("disconnected")`.
- Unit tests: missing playwright-core / missing Chromium -> `runtime_unavailable` with install command; other launch failure -> `runtime_launch_failed`; no module load until first `createSession`; CON-002 (only `playwrightAdapter.js` imports playwright).
- Browser verification: no WayContext UI; headless Playwright Chromium integration tests are the browser-observable check. claude-in-chrome not applicable.

Not verified / caveats
- Allowed redirects are followed by the adapter (abort + vetted `page.goto(next)`), so a 307/308 POST redirect degrades to GET and the page URL history is not the browser's native chain. Popup redirects use a 50 ms blank-popup lookup (a legit popup opened within 50 ms of a blocked one could be closed).
- After a blocked script navigation the page sits on Chromium's `chrome-error://` page, not the previous document.
- Redirect-race (`goto` seeing `_redirectP` before the abort rejects) was fixed by ordering, covered by the same-origin chain test but not red-first separately.
- TDD honoured red-first for the fake and playwright test files; the main-frame fetch/redirect approach was reached by test-driven iteration against real Chromium.
- No README/CHANGELOG entry for the optional dependency (P4+ docs).

Installed: `playwright-core@1.64.1` copied into main repo `node_modules/` (only that package; node_modules is a symlink); `package-lock.json` updated lock-only; Chromium 1248 + headless shell downloaded to `~/.cache/ms-playwright` via `node node_modules/playwright-core/cli.js install chromium`.
Merge: skipped (P4-P6 pending).
