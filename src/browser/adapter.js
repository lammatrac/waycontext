/**
 * Runtime adapter contract (CON-002). BSM policy, the registry and the state
 * machine talk only to an object with this shape; `playwrightAdapter.js` is the
 * sole module that imports Playwright, and `fakeAdapter.js` is the test double.
 *
 * Adapter
 *   createSession(opts) -> Promise<RuntimeSession>
 *     opts: { sessionId: string,
 *             allowedOrigins: string[],          // exact-origin allowlist (REQ-004)
 *             storageState?: object,             // Playwright storageState to seed the new context
 *             headed?: boolean,                  // visible browser window (REQ-017); default headless
 *             onBlocked?: (event) => void,       // navigation guard report, see blockedEvent()
 *             onClosed?: (reason) => void }      // "crashed" | "disconnected": runtime died under the session
 *     Throws BrowserError runtime_unavailable | runtime_launch_failed.
 *   close() -> Promise<void>                     // closes every session and browser process
 *
 * RuntimeSession (one isolated browser context, REQ-008)
 *   goto(url) -> Promise<{ url, status }>        // throws origin_blocked if the guard blocked it
 *   url() -> Promise<string>
 *   fill(selector, value) / click(selector) -> Promise<void>
 *   exists(selector, { timeoutMs? }) -> Promise<boolean>
 *   textContent(selector) -> Promise<string|null>
 *   containsText(text) -> Promise<boolean>
 *   storageState() -> Promise<object>            // cookies + localStorage (never sessionStorage)
 *   screenshot({ fullPage? }) -> Promise<Buffer>  // PNG; viewport only unless fullPage
 *   isAlive() -> boolean
 *   close() -> Promise<void>                     // idempotent; closes the context and its pages
 *
 * Navigation guard: every main-frame navigation (initial, redirect hop, script
 * driven, popup) is checked with isOriginAllowed() against allowedOrigins and
 * aborted before the document loads. A block (1) calls onBlocked exactly once
 * with a blockedEvent, and (2) rejects an in-flight goto() with origin_blocked.
 * The adapter never touches the database; the caller turns events into audit rows.
 */
import { BrowserError } from "./errors.js";

export const ADAPTER_METHODS = Object.freeze(["createSession", "close"]);
export const SESSION_METHODS = Object.freeze([
  "goto", "url", "fill", "click", "exists", "textContent", "containsText",
  "storageState", "screenshot", "isAlive", "close",
]);
export const BLOCK_KINDS = Object.freeze(["navigation", "redirect", "script", "popup"]);

export function assertAdapterShape(adapter) {
  for (const m of ADAPTER_METHODS) {
    if (typeof adapter?.[m] !== "function") throw new TypeError(`runtime adapter is missing ${m}()`);
  }
  return adapter;
}

/**
 * Guard report. `url` is reduced to origin + path: query strings and fragments
 * routinely carry tokens and must not reach the audit log.
 */
export function blockedEvent({ sessionId, url, kind }) {
  let origin = "";
  let safe = String(url);
  try {
    const u = new URL(url);
    origin = u.origin === "null" ? "" : u.origin;
    safe = `${u.origin === "null" ? u.protocol : u.origin}${u.pathname}`;
  } catch { /* leave unparseable urls as given; they are blocked anyway */ }
  return { sessionId, url: safe, origin, kind };
}

/** The `origin_blocked` rejection. `.blocked` carries the same event the callback got. */
export function originBlockedError(event) {
  const err = new BrowserError("origin_blocked", `${event.origin || event.url} is not an allowed origin (${event.kind})`);
  err.blocked = event;
  return err;
}

/** Calls the guard callback; a throwing callback must never un-block a navigation. */
export function reportBlocked(onBlocked, event) {
  if (typeof onBlocked !== "function") return;
  try {
    const r = onBlocked(event);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch { /* swallowed on purpose */ }
}
