# P3 plan — Browser runtime adapter

Files (worktree `.worktrees/browser-session-manager`):
- `src/browser/adapter.js` — adapter contract doc, `ADAPTER_METHODS`/`SESSION_METHODS`, `assertAdapterShape`, guard helpers (`blockedEvent`, `originBlockedError`, `reportBlocked`).
- `src/browser/fakeAdapter.js` — in-memory adapter running the same guard over a declarative site map.
- `src/browser/playwrightAdapter.js` — only importer of `playwright-core`; lazy load, per-session BrowserContext, refcounted browsers, route-based navigation guard.
- `src/browser/errors.js` — add `runtime_unavailable`, `runtime_launch_failed` to ERROR_CODES.
- `package.json` / `package-lock.json` — `optionalDependencies.playwright-core ^1.64.1`.
- Tests: `test/browser.adapter.fake.test.js`, `test/browser.adapter.playwright.test.js` (unit + real-Chromium integration with local fixture servers).

Gate: no dimension rose to high. Sec stays 2 (guard), Infra 2 (optional dep, Chromium). One technical finding (Chromium does not re-route redirect hops) was solved inside the adapter without scope change.
