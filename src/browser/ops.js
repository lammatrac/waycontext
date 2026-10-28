/**
 * Handlers for the browser operations registered in src/operations.js.
 *
 * Kept out of operations.js, like src/ui/uiQueries.js, so the registry stays a
 * declaration list. Each handler takes `(args, ctx)` where ctx is
 * `{ log, surface, correlationId }` (see operations.js header).
 */
import { config } from "../config.js";
import { BrowserError } from "./errors.js";
import { listProfiles, setSavedStateProbe, registerProfileRemovalHook } from "./profileStore.js";
import { randomBytes } from "node:crypto";
import { hasSavedState, writeEvidenceFile, recordArtifact, resolveStorageRef } from "./stateStore.js";
import { createSessionManager } from "./sessionManager.js";
import { redactDeep, redactError } from "./secrets.js";

/** Make `has_saved_state` in browser_profile_list real (REQ-003/REQ-006). */
export function installSavedStateProbe(opts = {}) {
  setSavedStateProbe(({ orgId, project, profileId }) => hasSavedState({ orgId, project, profileId }, opts));
}
installSavedStateProbe();

/**
 * BROWSER_ENABLED=0 kill switch (spec § 18). The tools stay registered -- the
 * registry and tool list do not change shape with an env var -- and refuse.
 * `enabled` is a parameter so tests can exercise both states.
 */
export function requireBrowserEnabled(enabled = config.browserEnabled) {
  if (!enabled) throw new BrowserError("browser_disabled", "browser tools are turned off (BROWSER_ENABLED=0)");
}

export async function browserProfileListOp(args) {
  requireBrowserEnabled();
  return listProfiles(args.project);
}

// One session manager (and so one runtime adapter) per process. Created lazily:
// the adapter is not built, and Playwright is not imported, until a session starts.
let manager = null;

export function getSessionManager() {
  return (manager ??= createSessionManager());
}

/** Test seam; pass null to drop the manager (the next call builds a fresh one). */
export function setSessionManager(m) {
  manager = m;
}

/** Close every live session and the adapter. Safe when nothing was ever started. */
export async function shutdownBrowserSessions(ctx) {
  if (manager?.shutdown) await manager.shutdown({ ctx });
}

// The CLI that removes a profile is usually a different process from the one that
// owns the runtimes; this only reaches sessions owned by the process it runs in.
registerProfileRemovalHook(({ projectId, profileId, ctx }) =>
  manager?.closeProfileSessions?.({ projectId, profileId, ctx }));

/** Run a session operation: kill switch first, secrets scrubbed from whatever comes out. */
async function guarded(fn) {
  requireBrowserEnabled();
  try {
    return redactDeep(await fn(getSessionManager()));
  } catch (e) {
    throw redactError(e);
  }
}

export const browserSessionStartOp = (a, ctx) =>
  guarded((m) => m.start({ project: a.project, profileId: a.profile_id, purpose: a.purpose, authMode: a.auth_mode, ctx }));

export const browserSessionStatusOp = (a, ctx) =>
  guarded((m) => m.status({ project: a.project, sessionId: a.session_id, ctx }));

export const browserSessionCloseOp = (a, ctx) =>
  guarded((m) => m.close({ project: a.project, sessionId: a.session_id, ctx }));

/**
 * Run an operation against a READY session (REQ-014): the manager holds the busy
 * lock, audits the call and refreshes the lease; output and errors are redacted.
 */
function guardedSession(tool, a, ctx, fn) {
  return guarded((m) => m.withSession({ project: a.project, sessionId: a.session_id, tool, ctx }, fn));
}

/** True when `url` is the profile's login page (pathname prefix on the login origin, or any allowed origin if the login url is unknown). */
function isLoginUrl(profile, url) {
  const login = profile?.definition?.login;
  const prefix = login?.url_pattern;
  if (!prefix) return false;
  try {
    const u = new URL(url);
    const loginOrigin = login.url ? new URL(login.url).origin : null;
    return (!loginOrigin || u.origin === loginOrigin) && u.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

export const browserNavigateOp = (a, ctx) =>
  guardedSession("browser_navigate", a, ctx, async ({ runtime, profile, expire }) => {
    const r = await runtime.goto(a.url);
    const finalUrl = (await runtime.url()) ?? r.url;
    if (r.status === 401 || isLoginUrl(profile, finalUrl)) {
      await expire();
      return { final_url: finalUrl, http_status: r.status, status: "EXPIRED", reason: "state_expired" };
    }
    return { final_url: finalUrl, http_status: r.status, status: "READY" };
  });

/** PNG IHDR: width and height are big-endian uint32 at bytes 16 and 20. */
function pngSize(buf) {
  return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : { width: 0, height: 0 };
}

export const browserCaptureScreenshotOp = (a, ctx) =>
  guardedSession("browser_capture_screenshot", a, ctx, async ({ runtime, session, scope, stateDir, rootPath }) => {
    const png = await runtime.screenshot({ fullPage: a.full_page === true });
    const captured = new Date();
    const name = `screenshot-${captured.toISOString().replace(/[:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(3).toString("hex")}.png`;
    const ref = await writeEvidenceFile(scope, session.session_id, name, png, {
      baseDir: stateDir, forbiddenRoots: [rootPath].filter(Boolean),
    });
    await recordArtifact({ sessionId: session.session_id, artifactType: "screenshot", storageRef: ref });
    return {
      path: resolveStorageRef(ref, { baseDir: stateDir }), storage_ref: ref,
      ...pngSize(png), captured_at: captured.toISOString(),
    };
  });
