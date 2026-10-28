/**
 * In-memory runtime adapter for unit tests of later phases (CON-002). It runs
 * the same guard as the real adapter (isOriginAllowed on the initial url, every
 * redirect hop, a scripted navigation and popups) against a declarative site
 * map, so session-manager tests can exercise origin_blocked without a browser.
 *
 * pages: { [url]: { redirect?, scriptNavigateTo?, popup?, selectors?: {[sel]: text},
 *                   text?, status? } }   (unlisted urls are plain 200 pages)
 */
import { BrowserError } from "./errors.js";
import { isOriginAllowed } from "./origin.js";
import { blockedEvent, originBlockedError, reportBlocked } from "./adapter.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export function createFakeAdapter({ pages = {} } = {}) {
  const sessions = new Set();
  let launchFailure = null;
  const adapter = {
    sessions,
    pages,
    failNextLaunch(code = "runtime_launch_failed") { launchFailure = code; },
    openSessionCount: () => sessions.size,
    async createSession(options = {}) {
      if (launchFailure) {
        const code = launchFailure;
        launchFailure = null;
        throw new BrowserError(code, "fake adapter launch failure");
      }
      const s = new FakeSession(options, pages, () => sessions.delete(s));
      sessions.add(s);
      return s;
    },
    async close() {
      await Promise.all([...sessions].map((s) => s.close()));
    },
  };
  return adapter;
}

class FakeSession {
  constructor(options, pages, onGone) {
    this.options = options;
    this._pages = pages;
    this._onGone = onGone;
    this._url = "about:blank";
    this._alive = true;
    this._popups = 0;
    this.calls = [];
  }

  _block(url, kind) {
    const event = blockedEvent({ sessionId: this.options.sessionId, url, kind });
    reportBlocked(this.options.onBlocked, event);
    return originBlockedError(event);
  }

  _live() {
    if (!this._alive) throw new BrowserError("runtime_launch_failed", "fake session is closed");
  }

  pageCount() { return 1 + this._popups; }
  isAlive() { return this._alive; }

  async goto(url) {
    this._live();
    this.calls.push(["goto", url]);
    const allowed = this.options.allowedOrigins;
    if (!isOriginAllowed(url, allowed)) throw this._block(url, "navigation");
    let current = url;
    for (let hops = 0; this._pages[current]?.redirect; hops++) {
      if (hops > 10) throw new BrowserError("runtime_launch_failed", "too many redirects");
      current = new URL(this._pages[current].redirect, current).href;
      if (!isOriginAllowed(current, allowed)) throw this._block(current, "redirect");
    }
    const page = this._pages[current] ?? {};
    if (page.scriptNavigateTo) {
      if (!isOriginAllowed(page.scriptNavigateTo, allowed)) throw this._block(page.scriptNavigateTo, "script");
      current = page.scriptNavigateTo;
    }
    if (page.popup && !isOriginAllowed(page.popup, allowed)) throw this._block(page.popup, "popup");
    if (page.popup) this._popups++;
    this._url = current;
    return { url: current, status: (this._pages[current] ?? page).status ?? 200 };
  }

  async url() { this._live(); return this._url; }
  _page() { return this._pages[this._url] ?? {}; }
  async fill(selector, value) { this._live(); this.calls.push(["fill", selector, value]); }
  async click(selector) { this._live(); this.calls.push(["click", selector]); }
  async exists(selector) { this._live(); return Object.hasOwn(this._page().selectors ?? {}, selector); }
  async textContent(selector) { this._live(); return this._page().selectors?.[selector] ?? null; }
  async containsText(text) { this._live(); return (this._page().text ?? "").includes(text); }
  async storageState() { this._live(); return { cookies: [], origins: [] }; }
  async screenshot(opts = {}) { this._live(); this.calls.push(["screenshot", opts]); return PNG_1X1; }

  /** Test hook: the runtime died under the session. */
  simulateCrash() {
    if (!this._alive) return;
    this._alive = false;
    this._onGone();
    try { this.options.onClosed?.("crashed"); } catch { /* ignore */ }
  }

  async close() {
    if (!this._alive) return;
    this._alive = false;
    this._onGone();
  }
}
