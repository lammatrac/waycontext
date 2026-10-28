STATUS: DONE

Verified (worktree, uncommitted per instructions):
- `npm test`: 996 tests, 995 pass, 0 fail, 1 skipped (P4 baseline 987/986/0/1; +9 new).
- test/browser.navigateOps.test.js (fake adapter, 8): registry flags, navigate ok, origin_blocked direct + via redirect (audited, session READY), login redirect and 401 -> EXPIRED then session_not_ready, screenshot file/mode/ref/artifact row/no bytes/full_page, cross-project session_not_found, kill switch, AC-005 secret scan over the new ops.
- test/browser.navigateOps.playwright.test.js (real Chromium + local fixtures, 1; run 4x stable): READY, allowed page, two foreign navigations blocked with zero foreign-server requests and session still READY, screenshot (exists, 0600, under state dir outside the repo, PNG magic, artifact row, full_page), then server-side invalidation -> EXPIRED/state_expired -> session_not_ready.
- Stdio MCP in one process (start, navigate, screenshot, blocked navigate, status, close) against a local fixture: all as expected, 0 foreign requests; the PNG (1280x720) showed "BSM Fixture Dashboard" heading in green and the line "navigate+screenshot demo", i.e. the fixture page.
- claude-in-chrome not applicable: the target is a headless Playwright Chromium, not the user's Chrome.

Bug found and fixed along the way: after a blocked navigation Chromium commits chrome-error a moment later and interrupted the next goto; the adapter now settles it before raising origin_blocked.
Not verified: CLI use (one-shot CLI cannot hold a session; ops are reachable but only meaningful in a long-lived process).
