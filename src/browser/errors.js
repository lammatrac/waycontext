/**
 * Rejection codes for the Browser Session Manager.
 *
 * A rejection is a thrown BrowserError whose message *starts with* its code
 * (`origin_blocked: https://evil.test is not an allowed origin`), so the MCP
 * `isError` text ("Error: <message>") and a CLI failure both carry the code
 * without either surface needing to know about this class. Code that branches
 * on a rejection reads `.code`, never the message.
 */

/** Thrown rejections (spec § 6.2.3 and REQ-001..004). */
export const ERROR_CODES = Object.freeze([
  "project_not_found",
  "profile_not_found",
  "invalid_profile",
  "invalid_origin",
  "origin_blocked",
  "environment_not_allowed",
  "auth_mode_mismatch",
  "browser_disabled",
  "surface_not_allowed",
  "session_not_found",
  "session_not_in_this_process",
  "session_not_ready",
  "session_busy",
  "invalid_secret_name",
  "secret_missing",
  "state_missing",
  "invalid_storage_ref",
  "invalid_state_dir",
  "runtime_unavailable",
  "runtime_launch_failed",
  "verification_failed",
  "login_timeout",
  "login_cancelled",
]);

/** `reason` values on a non-READY session result (spec § 6.2.3). Returned, not thrown. */
export const REASONS = Object.freeze([
  "runtime_unavailable",
  "secret_missing",
  "state_missing",
  "login_failed",
  "verification_failed",
  "state_expired",
  "runtime_lost",
  "idle_timeout",
]);

export class BrowserError extends Error {
  /**
   * @param {string} code  one of ERROR_CODES
   * @param {string} [detail]  human text; must never contain a secret value
   */
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BrowserError";
    this.code = code;
  }
}
