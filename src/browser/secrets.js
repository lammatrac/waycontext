/**
 * Secret provider (REQ-005, Q-003 A) and the redaction mechanism.
 *
 * The only source is env vars `WAYCONTEXT_BROWSER_SECRET_<NAME>`, read through
 * src/config.js. A profile names the suffix; no other variable is resolvable.
 * Call resolveSecret at the moment the value is typed into the page, never
 * earlier, and never put the result in a result, log, audit row or error.
 *
 * Redaction is a backstop, not the primary defence: every value handed out by
 * resolveSecret (and any value a caller registers, e.g. cookie values read from
 * a saved state) is remembered in-process, and redact()/redactDeep()/
 * redactError() replace it with [REDACTED]. Surfaces run their outgoing text
 * through these before logging or returning it.
 */
import { browserSecret, browserSecretEnvName } from "../config.js";
import { BrowserError } from "./errors.js";

export const REDACTED = "[REDACTED]";
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MIN_LEN = 3; // shorter values would shred ordinary text

const sensitive = new Set();

/** Remember a value so redact() strips it. Ignores empty/very short strings. */
export function registerSensitive(value) {
  if (typeof value === "string" && value.length >= MIN_LEN) sensitive.add(value);
}

/** Forget all remembered values (tests). */
export function clearSensitive() {
  sensitive.clear();
}

function assertName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.startsWith("WAYCONTEXT_BROWSER_SECRET_")) {
    throw new BrowserError("invalid_secret_name", "secret names are the suffix of WAYCONTEXT_BROWSER_SECRET_<NAME>: A-Z, 0-9, _");
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
  let out = text;
  for (const v of [...sensitive].sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
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
