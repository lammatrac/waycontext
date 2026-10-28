/**
 * The Playwright runtime adapter (CON-002: the only module that imports
 * `playwright-core`). Contract in `adapter.js`.
 *
 * - REQ-007: Playwright is imported lazily on the first createSession(); a
 *   missing package or Chromium binary is `runtime_unavailable` with the
 *   install command, and nothing else in WayContext is affected.
 * - REQ-008: every session is a new BrowserContext (no shared cookies/storage).
 *   Browser processes are shared per mode (headless / headed) and closed when
 *   their last session closes, so teardown leaves no process behind.
 * - REQ-015: a context-level route checks every main-frame document request
 *   (initial, redirect hop, script-driven, popup) against the allowlist and
 *   aborts a disallowed one before it reaches the network. Subframes and
 *   subresources are not restricted in the MVP (spec § 10).
 *
 * The adapter never writes to the database; blocks are reported via onBlocked.
 */
import { BrowserError } from "./errors.js";
import { isOriginAllowed } from "./origin.js";
import { blockedEvent, originBlockedError, reportBlocked } from "./adapter.js";

export const INSTALL_HINT = "npm install playwright-core && npx playwright install chromium";

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const SETTLE_LOAD_TIMEOUT_MS = 2_000;
const SETTLE_QUIET_MS = 200;
const MAX_REDIRECTS = 20;

const defaultLoader = () => import("playwright-core");

function firstLine(err) {
  return String(err?.message ?? err).split("\n")[0].slice(0, 300);
}

function unavailable(why) {
  return new BrowserError("runtime_unavailable", `${why}. Install with: ${INSTALL_HINT}`);
}

export function createPlaywrightAdapter({ loader = defaultLoader, launchOptions = {}, actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS } = {}) {
  let chromiumPromise = null;
  const browsers = new Map(); // "headless" | "headed" -> { promise, refs, sessions:Set }
  const sessions = new Set();

  function loadChromium() {
    chromiumPromise ??= (async () => {
      let mod;
      try {
        mod = await loader();
      } catch (err) {
        throw unavailable(`playwright-core could not be loaded (${firstLine(err)})`);
      }
      const chromium = mod?.chromium ?? mod?.default?.chromium;
      if (!chromium) throw unavailable("playwright-core did not provide chromium");
      return chromium;
    })();
    chromiumPromise.catch(() => { chromiumPromise = null; }); // retry after the user installs it
    return chromiumPromise;
  }

  async function acquireBrowser(headed) {
    const key = headed ? "headed" : "headless";
    let entry = browsers.get(key);
    if (!entry) {
      entry = { refs: 0, sessions: new Set(), promise: null };
      entry.promise = (async () => {
        const chromium = await loadChromium();
        try {
          const browser = await chromium.launch({ ...launchOptions, headless: !headed });
          browser.on("disconnected", () => {
            if (browsers.get(key) === entry) browsers.delete(key);
            for (const s of [...entry.sessions]) s._died("disconnected");
          });
          return browser;
        } catch (err) {
          if (err instanceof BrowserError) throw err;
          const msg = firstLine(err);
          if (/Executable doesn't exist|playwright install|download new browsers/i.test(msg)) {
            throw unavailable(`Chromium is not installed (${msg})`);
          }
          throw new BrowserError("runtime_launch_failed", `Chromium failed to launch: ${msg}`);
        }
      })();
      browsers.set(key, entry);
      entry.promise.catch(() => { if (browsers.get(key) === entry) browsers.delete(key); });
    }
    entry.refs++;
    try {
      return { entry, key, browser: await entry.promise };
    } catch (err) {
      entry.refs--;
      throw err;
    }
  }

  async function releaseBrowser(entry, key) {
    entry.refs--;
    if (entry.refs > 0) return;
    if (browsers.get(key) === entry) browsers.delete(key);
    try { await (await entry.promise).close(); } catch { /* already gone */ }
  }

  return {
    async createSession(options = {}) {
      const { entry, key, browser } = await acquireBrowser(Boolean(options.headed));
      let context;
      try {
        context = await browser.newContext({
          ...(options.storageState ? { storageState: options.storageState } : {}),
          serviceWorkers: "block", // a service worker could answer navigations outside the route
          acceptDownloads: false,
        });
        const session = new PlaywrightSession({ options, browser, context, actionTimeoutMs, release: () => releaseBrowser(entry, key), sessions, entry });
        await session._init();
        sessions.add(session);
        entry.sessions.add(session);
        return session;
      } catch (err) {
        try { await context?.close(); } catch { /* ignore */ }
        await releaseBrowser(entry, key);
        throw err;
      }
    },

    async close() {
      await Promise.all([...sessions].map((s) => s.close()));
      for (const [key, entry] of [...browsers]) {
        browsers.delete(key);
        try { await (await entry.promise).close(); } catch { /* ignore */ }
      }
    },
  };
}

class PlaywrightSession {
  constructor({ options, browser, context, actionTimeoutMs, release, sessions, entry }) {
    this.options = options;
    this._browser = browser;
    this._context = context;
    this._timeout = actionTimeoutMs;
    this._release = release;
    this._sessions = sessions;
    this._entry = entry;
    this._alive = true;
    this._released = false;
    this._closing = null;
    this._page = null;
    this._popups = new Set();
    this._blocks = []; // every block, in order; ops compare against their start index
    this._inGoto = false;
  }

  async _init() {
    const allowed = this.options.allowedOrigins ?? [];
    await this._context.route("**/*", (route) => this._guard(route, allowed));
    this._context.on("page", (p) => {
      if (p !== this._page) this._popups.add(p);
    });
    this._page = await this._context.newPage();
    this._page.on("framenavigated", (frame) => {
      if (frame.parentFrame()) return;
      const url = frame.url();
      if (url === "about:blank" || url.startsWith("chrome-error:") || isOriginAllowed(url, allowed)) return;
      this._record(url, "navigation"); // backstop for a non-http document the route never saw
      this._page.goto("about:blank").catch(() => {});
    });
    this._page.on("crash", () => this._died("crashed"));
    // A main page closed by anyone but close() (the human closing the window or
    // tab) leaves nothing to drive: it is a death like a crash. close() sets
    // _alive first, so its own context teardown never reports here. Pages also
    // close when the whole browser goes away: one round trip to the context tells
    // the two apart, and a dead browser is reported as "disconnected".
    this._page.on("close", () => {
      if (!this._alive) return;
      this._context.cookies().then(
        () => this._died("page_closed"),
        () => this._died("disconnected"),
      );
    });
  }

  _record(url, kind) {
    const event = blockedEvent({ sessionId: this.options.sessionId, url, kind });
    this._blocks.push(event);
    reportBlocked(this.options.onBlocked, event);
    return event;
  }

  /** Main-frame document requests only; everything else passes straight through. */
  _frameInfo(request) {
    try {
      const frame = request.frame();
      return { isMain: !frame.parentFrame(), page: frame.page() };
    } catch {
      // A popup's first request is issued before its frame exists: only a new top-level page does that.
      return { isMain: true, page: null };
    }
  }

  async _guard(route, allowed) {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue().catch(() => {});
    const { isMain, page } = this._frameInfo(request);
    if (!isMain) return route.continue().catch(() => {});
    const isPopup = page !== this._page;
    const url = request.url();
    if (!isOriginAllowed(url, allowed)) {
      const kind = isPopup ? "popup" : request.redirectedFrom() ? "redirect" : this._inGoto ? "navigation" : "script";
      return this._abort(route, url, kind, isPopup, page);
    }
    // Chromium follows a navigation's redirects internally and never re-routes the hops, so
    // route.continue() would leave redirects unguarded. Fetch the document without following
    // redirects instead: a non-redirect response is served as-is (one request, no replay); an
    // allowed redirect is aborted and the browser is re-navigated to its vetted target, which comes
    // through this guard as a fresh request; a disallowed one never leaves this process.
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch {
      return route.abort("failed").catch(() => {});
    }
    const status = response.status();
    const location = status >= 300 && status < 400 ? response.headers().location : null;
    if (!location) return route.fulfill({ response }).catch(() => {});
    let next;
    try { next = new URL(location, url).href; } catch { next = location; }
    if (!isOriginAllowed(next, allowed)) return this._abort(route, next, "redirect", isPopup, page);
    this._follow(next, isPopup ? null : page); // before the abort, so goto() sees `_redirectP` when it rejects
    await route.abort("aborted").catch(() => {});
  }

  /** Re-navigate to an already vetted redirect target; goto() awaits `_redirectP` so callers see the final page. */
  _follow(next, page) {
    const hops = (this._hops = (this._hops ?? 0) + 1);
    const go = async (p) => {
      try {
        return await p.goto(next, { waitUntil: "load", timeout: 30_000 });
      } catch {
        return null; // a block is already in _blocks; a nested redirect replaced _redirectP
      }
    };
    if (hops > MAX_REDIRECTS) return;
    if (page) {
      this._redirectP = go(page);
      return;
    }
    this._redirectP = new Promise((resolve) => {
      setTimeout(() => {
        const popup = this._context.pages().find((p) => p !== this._page && p.url() === "about:blank");
        resolve(popup ? go(popup) : null);
      }, 50);
    });
  }

  async _abort(route, url, kind, isPopup, page) {
    this._record(url, kind);
    await route.abort("blockedbyclient").catch(() => {});
    if (isPopup) this._closeBlankPopups(page);
  }

  _closeBlankPopups(page) {
    if (page) return void page.close().catch(() => {});
    setTimeout(() => {
      for (const p of this._context.pages()) {
        if (p !== this._page && p.url() === "about:blank") p.close().catch(() => {});
      }
    }, 50);
  }

  _died(reason) {
    if (!this._alive) return;
    this._alive = false;
    this._sessions.delete(this);
    this._entry.sessions.delete(this);
    try { this.options.onClosed?.(reason); } catch { /* ignore */ }
  }

  _live() {
    if (!this._alive) throw new BrowserError("runtime_launch_failed", "browser session is closed");
  }

  /** Wait for in-flight script navigations / popups to hit the guard, then throw if any blocked since `from`. */
  async _settle(from) {
    await this._page.waitForLoadState("load", { timeout: SETTLE_LOAD_TIMEOUT_MS }).catch(() => {});
    await new Promise((r) => setTimeout(r, SETTLE_QUIET_MS));
    if (this._blocks.length > from) throw originBlockedError(this._blocks[from]);
  }

  /**
   * After an aborted navigation Chromium commits its chrome-error page a moment
   * later; a goto issued before that lands is interrupted by it. Let it land so
   * the session stays usable.
   */
  async _settleAborted() {
    await this._page.waitForLoadState("load", { timeout: SETTLE_LOAD_TIMEOUT_MS }).catch(() => {});
    await new Promise((r) => setTimeout(r, SETTLE_QUIET_MS));
  }

  async goto(url) {
    this._live();
    const from = this._blocks.length;
    if (!isOriginAllowed(url, this.options.allowedOrigins)) throw originBlockedError(this._record(url, "navigation"));
    this._inGoto = true;
    this._hops = 0;
    this._redirectP = null;
    let response = null;
    try {
      try {
        response = await this._page.goto(url, { waitUntil: "load", timeout: 30_000 });
      } catch (err) {
        if (!this._redirectP) throw err;
      }
      while (this._redirectP) {
        const p = this._redirectP;
        this._redirectP = null;
        response = (await p) ?? response;
      }
    } catch (err) {
      if (this._blocks.length > from) {
        await this._settleAborted();
        throw originBlockedError(this._blocks[from]);
      }
      throw new BrowserError("runtime_launch_failed", `navigation failed: ${firstLine(err)}`);
    } finally {
      this._inGoto = false;
    }
    if (this._blocks.length > from) {
      await this._settleAborted();
      throw originBlockedError(this._blocks[from]);
    }
    await this._settle(from);
    return { url: this._page.url(), status: response?.status() ?? 0 };
  }

  async url() { this._live(); return this._page.url(); }

  async fill(selector, value) {
    this._live();
    await this._page.fill(selector, value, { timeout: this._timeout });
  }

  async click(selector) {
    this._live();
    const from = this._blocks.length;
    await this._page.click(selector, { timeout: this._timeout });
    await this._settle(from);
  }

  async exists(selector, { timeoutMs = 0 } = {}) {
    this._live();
    if (timeoutMs <= 0) return (await this._page.locator(selector).count()) > 0;
    try {
      await this._page.waitForSelector(selector, { state: "attached", timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async textContent(selector) {
    this._live();
    return this._page.locator(selector).first().textContent({ timeout: this._timeout }).catch(() => null);
  }

  async containsText(text) {
    this._live();
    const body = await this._page.locator("body").textContent({ timeout: this._timeout }).catch(() => "");
    return (body ?? "").includes(text);
  }

  async storageState() { this._live(); return this._context.storageState(); }
  async screenshot({ fullPage = false } = {}) { this._live(); return this._page.screenshot({ type: "png", fullPage: fullPage === true }); }
  isAlive() { return this._alive; }

  /** Idempotent. Releases the shared browser exactly once, whether or not the session died first. */
  close() {
    this._closing ??= (async () => {
      this._alive = false;
      this._sessions.delete(this);
      this._entry.sessions.delete(this);
      try { await this._context.close(); } catch { /* browser may already be gone */ }
      if (!this._released) {
        this._released = true;
        await this._release();
      }
    })();
    return this._closing;
  }
}
