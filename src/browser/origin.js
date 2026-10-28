/**
 * Exact-origin matching: the allowlist trust boundary (REQ-004, CON-003).
 *
 * An origin is allowed only when scheme, host and port all equal an allowlist
 * entry after URL normalization. There is deliberately no substring, suffix,
 * wildcard or registrable-domain logic here -- every one of those is a way for
 * `staging.example.test.evil.test` or `evil.test/?u=staging.example.test` to
 * slip through. Anything unparseable or non-http(s) is refused.
 */
import { BrowserError } from "./errors.js";

/**
 * Canonical origin of an allowlist entry. Throws `invalid_origin` unless the
 * entry is a bare http(s) origin: no wildcard, path, query, fragment or
 * credentials, because an entry that silently drops those would not mean what
 * its author wrote.
 */
export function normalizeOrigin(entry) {
  if (typeof entry !== "string" || entry.includes("*")) {
    throw new BrowserError("invalid_origin", `${JSON.stringify(entry)} is not an exact origin (wildcards are not allowed)`);
  }
  let url;
  try {
    url = new URL(entry);
  } catch {
    throw new BrowserError("invalid_origin", `${JSON.stringify(entry)} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserError("invalid_origin", `${entry} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new BrowserError("invalid_origin", `${entry} must be a bare origin (scheme, host, optional port)`);
  }
  return url.origin;
}

/** True only if `url` is http(s) and its origin exactly equals one of `allowedOrigins`. */
export function isOriginAllowed(url, allowedOrigins) {
  if (typeof url !== "string" || !Array.isArray(allowedOrigins)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return allowedOrigins.some((entry) => {
    try {
      return normalizeOrigin(entry) === parsed.origin;
    } catch {
      return false;
    }
  });
}
