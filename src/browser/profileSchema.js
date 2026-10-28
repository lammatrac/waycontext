/**
 * Browser profile definition: parsing, validation and the environment/auth-mode
 * policy checks (REQ-001, REQ-004, Q-002 A, CON-003).
 *
 * A profile is YAML a human imports with `waycontext browser-profile import`.
 * It names things (env var *suffixes*, CSS selectors, URLs) and never carries a
 * secret value or a filesystem path: every object is strict, so an extra key
 * such as `password:` or `state_path:` fails the import instead of being stored.
 *
 * Validation messages are built from the issue path and code, not zod's own
 * text, because zod echoes the rejected value ("received 'hunter2'") and the
 * value of a mistyped key is exactly where a pasted secret would be.
 */
import { load } from "js-yaml";
import { z } from "zod";
import { BrowserError } from "./errors.js";
import { normalizeOrigin, isOriginAllowed } from "./origin.js";

export const ENVIRONMENTS = Object.freeze(["local", "staging"]);
export const AUTH_MODES = Object.freeze(["fresh_login", "saved_state"]);
export const SECRET_ENV_PREFIX = "WAYCONTEXT_BROWSER_SECRET_";

const selector = z.string().trim().min(1).max(500);
const text = z.string().min(1).max(500);
// The profile names the suffix of WAYCONTEXT_BROWSER_SECRET_<NAME> (Q-003), not
// the variable and certainly not a value.
const secretName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .refine((n) => !n.startsWith(SECRET_ENV_PREFIX));

const schema = z.strictObject({
  profile_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  environment: z.enum(ENVIRONMENTS),
  base_url: z.string().trim().min(1).max(2048),
  allowed_origins: z.array(z.string()).min(1).max(50),
  auth: z.strictObject({
    mode: z.enum(AUTH_MODES),
    // The profile asks for the post-login state to be saved (spec L186).
    save_state: z.boolean().default(false),
  }),
  login: z
    .strictObject({
      url: z.string().trim().min(1).max(2048),
      // Pathname prefix identifying the login page, used to notice a redirect
      // back to login. Plain prefix: no glob, no regex. Defaults to login.url's path.
      url_pattern: z.string().regex(/^\//).max(500).optional(),
      username_selector: selector,
      password_selector: selector,
      submit_selector: selector,
      username_secret: secretName,
      password_secret: secretName,
    })
    .optional(),
  verify: z
    .strictObject({
      url: z.string().trim().min(1).max(2048),
      selector: selector.optional(),
      text: text.optional(),
      // Optional: where the logged-in identity is read from, reported in the session.
      identity_selector: selector.optional(),
    })
    .refine((v) => v.selector || v.text, { message: "verify needs a selector or text assertion" }),
});

const SAFE_CODES = new Set(["custom", "invalid_type", "unrecognized_keys", "too_small", "too_big"]);

function describeIssues(issues) {
  return issues
    .map((i) => {
      const where = i.path.length ? i.path.join(".") : "(profile)";
      return `${where}: ${SAFE_CODES.has(i.code) ? i.message : "invalid value"}`;
    })
    .join("; ");
}

/** Environment policy (Q-002 A): only local and staging are importable or startable. */
export function assertEnvironmentAllowed(environment) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new BrowserError(
      "environment_not_allowed",
      `environment ${JSON.stringify(environment ?? null)} is not allowed; only ${ENVIRONMENTS.join(" and ")} profiles are supported`
    );
  }
}

/** A start request must match the profile's declared mode. `profile` is a stored row or parsed definition. */
export function assertAuthMode(profile, requestedMode) {
  const actual = profile.auth_mode ?? profile.auth?.mode;
  if (actual !== requestedMode) {
    throw new BrowserError("auth_mode_mismatch", `profile uses ${actual}, not ${requestedMode}`);
  }
}

/**
 * Parse and validate profile YAML (or an already-loaded object). Returns the
 * normalized definition; throws BrowserError (invalid_profile, invalid_origin,
 * environment_not_allowed).
 */
export function parseProfileYaml(input) {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = load(input);
    } catch (e) {
      throw new BrowserError("invalid_profile", `not valid YAML (${e.reason ?? "parse error"})`);
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BrowserError("invalid_profile", "profile must be a YAML mapping");
  }
  // Checked before the schema so production gets its own code, not "invalid value".
  if (raw.environment === "production") assertEnvironmentAllowed("production");

  const result = schema.safeParse(raw);
  if (!result.success) throw new BrowserError("invalid_profile", describeIssues(result.error.issues));
  const def = result.data;

  def.allowed_origins = [...new Set(def.allowed_origins.map(normalizeOrigin))];

  if (def.auth.mode === "fresh_login" && !def.login) {
    throw new BrowserError("invalid_profile", "login: required when auth.mode is fresh_login");
  }

  const onAllowedOrigin = [["base_url", def.base_url]];
  if (def.login) onAllowedOrigin.push(["login.url", def.login.url]);
  onAllowedOrigin.push(["verify.url", def.verify.url]);
  for (const [field, url] of onAllowedOrigin) {
    if (!isOriginAllowed(url, def.allowed_origins)) {
      throw new BrowserError("invalid_profile", `${field}: ${url} is not on an allowed origin`);
    }
  }

  if (def.login && !def.login.url_pattern) def.login.url_pattern = new URL(def.login.url).pathname;
  return def;
}
