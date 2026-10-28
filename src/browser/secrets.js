/**
 * Secret provider (REQ-005, Q-003 A) and the redaction mechanism.
 *
 * The only source is env vars `WAYCONTEXT_BROWSER_SECRET_<NAME>`, read through
 * src/config.js. A profile names the suffix; no other variable is resolvable.
 * Call resolveSecret at the moment the value is typed into the page, never
 * earlier, and never put the result in a result, log, audit row or error.
 *
 * Redaction is a backstop, not the primary defence: every value handed out by
 * resolveSecret (and any value a caller registers) is remembered in-process, and
 * redact()/redactDeep()/redactError() replace it with [REDACTED]. Surfaces run
 * their outgoing text through these before logging or returning it.
 *
 * Secret values are registered for the life of the process. Cookie values are
 * not: they go through a scope (createSensitiveScope) owned by one session and
 * are forgotten when it is disposed, and only values that look like tokens
 * (isSensitiveCookieValue) are taken at all, so a cookie such as `env=staging`
 * does not redact the word "staging" everywhere.
 */
import { browserSecret, browserSecretEnvName } from "../config.js";
import { BrowserError } from "./errors.js";

export const REDACTED = "[REDACTED]";
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MIN_LEN = 3; // shorter values would shred ordinary text
const COOKIE_LONG = 16;
const COOKIE_MIXED = 8;

// value -> number of holders (the process-wide registration counts as one,
// never released; each scope that added it counts as one more).
const sensitive = new Map();
let ordered = null; // cached longest-first list; null after any change

function hold(value) {
  sensitive.set(value, (sensitive.get(value) ?? 0) + 1);
  if (sensitive.get(value) === 1) ordered = null;
}

function drop(value) {
  const n = sensitive.get(value);
  if (n === undefined) return;
  if (n > 1) sensitive.set(value, n - 1);
  else { sensitive.delete(value); ordered = null; }
}

const accepts = (value) => typeof value === "string" && value.length >= MIN_LEN;

/** Remember a value for the life of the process so redact() strips it. Ignores empty/very short strings. */
export function registerSensitive(value) {
  if (accepts(value)) hold(value);
}

/**
 * Whether a cookie value is worth redacting: at least 16 characters, or at
 * least 8 that mix letters and digits. Ordinary words and flags ("staging",
 * "admin", "true", "en-US") are not; realistic session ids and tokens are.
 */
export function isSensitiveCookieValue(value) {
  if (typeof value !== "string") return false;
  if (value.length >= COOKIE_LONG) return true;
  return value.length >= COOKIE_MIXED && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/**
 * A set of registrations owned by one session. `add(value)` registers a value,
 * `addCookies(cookies)` registers the sensitive-looking cookie values, and
 * `dispose()` (idempotent) releases exactly what this scope added; a value that
 * is also a resolved secret or held by another scope stays registered.
 */
export function createSensitiveScope() {
  let mine = [];
  return {
    add(value) {
      if (!mine || !accepts(value)) return;
      hold(value);
      mine.push(value);
    },
    addCookies(cookies) {
      for (const c of cookies ?? []) if (isSensitiveCookieValue(c?.value)) this.add(c.value);
    },
    dispose() {
      if (!mine) return;
      for (const v of mine) drop(v);
      mine = null;
    },
  };
}

/** Forget all remembered values (tests). */
export function clearSensitive() {
  sensitive.clear();
  ordered = null;
}

function assertName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.startsWith(browserSecretEnvName(""))) {
    throw new BrowserError("invalid_secret_name", `secret names are the suffix of ${browserSecretEnvName("<NAME>")}: A-Z, 0-9, _`);
  }
}

/** Whether the secret is set. Does not register or return the value. */
export function hasSecret(name) {
  assertName(name);
  return browserSecret(name) !== undefined;
}

/**
 * The secret value. Throws `secret_missing` (message names the variable only)
 * when unset or empty, `invalid_secret_name` for anything but a bare suffix.
 */
export function resolveSecret(name) {
  assertName(name);
  const value = browserSecret(name);
  if (value === undefined) {
    throw new BrowserError("secret_missing", `${browserSecretEnvName(name)} is not set`);
  }
  registerSensitive(value);
  return value;
}

/** Replace every remembered sensitive value in `text`. Longest first. */
export function redact(text) {
  if (typeof text !== "string" || sensitive.size === 0) return text;
  ordered ??= [...sensitive.keys()].sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of ordered) out = out.split(v).join(REDACTED);
  return out;
}

/** Deep copy with redact() applied to every string (keys included are kept). */
export function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

/** A copy of `err` safe to log or throw: same class code, redacted message and stack. */
export function redactError(err) {
  const out = new BrowserError(err?.code ?? "error");
  out.message = redact(String(err?.message ?? err));
  out.name = err?.name ?? "Error";
  if (err?.code !== undefined) out.code = err.code;
  out.stack = redact(String(err?.stack ?? out.message));
  return out;
}
