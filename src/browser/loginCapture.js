/**
 * Manual login capture (REQ-017): the engine behind `waycontext browser-login`.
 *
 * A human types the credentials into a headed browser; this code never types, reads
 * or resolves a secret. It opens the profile's login page with the navigation guard
 * active, waits for a completion signal, runs the same REQ-011 verification a session
 * start runs, and only if that passes saves the storage state (REQ-006).
 *
 * Human-only: nothing here is an operation (src/operations.js) and nothing in the MCP
 * or HTTP layer imports it. The completion signal is injected (`waitForDone`) so tests
 * never depend on a TTY; the CLI supplies an Enter prompt (see promptForEnter).
 */
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { currentOrgId, getProject } from "../db.js";
import { BrowserError } from "./errors.js";
import { writeAuditEvent, newCorrelationId } from "./audit.js";
import { assertAuthMode, assertEnvironmentAllowed } from "./profileSchema.js";
import { getProfile } from "./profileStore.js";
import { redactDeep, redactError, registerSensitive } from "./secrets.js";
import { saveStorageState } from "./stateStore.js";
import { verifyAuthenticated } from "./sessionManager.js";

export const DEFAULT_LOGIN_TIMEOUT_SECONDS = 600;

/**
 * Default completion signal: print the instructions and resolve when the human presses
 * Enter. End of input without a line rejects `login_cancelled`.
 */
export function promptForEnter({ input = process.stdin, output = process.stderr, message } = {}) {
  return new Promise((resolve, reject) => {
    // A stream that already ended never emits 'close' to a late listener.
    if (input.readableEnded || input.destroyed) {
      reject(new BrowserError("login_cancelled", "input closed before the login was confirmed"));
      return;
    }
    const rl = readline.createInterface({ input, output, terminal: false });
    let answered = false;
    output.write(message ?? "Log in in the browser window, then press Enter here to verify and save.\n");
    rl.once("line", () => { answered = true; rl.close(); resolve(); });
    rl.once("close", () => {
      if (!answered) reject(new BrowserError("login_cancelled", "input closed before the login was confirmed"));
    });
  });
}

/**
 * @param {object} o
 * @param {string} o.project @param {string} o.profileId
 * @param {object} o.adapter                  runtime adapter (CON-002)
 * @param {(h:{session:object})=>Promise<void>} o.waitForDone  resolves when the human says they are done
 * @param {number} [o.timeoutMs]              default DEFAULT_LOGIN_TIMEOUT_SECONDS
 * @param {string} [o.stateDir] @param {string} [o.orgId] @param {number} [o.verifyWaitMs]
 * @param {{surface?:string, correlationId?:string, log?:Function}} [o.ctx]  surface must be "cli"
 * @returns {Promise<{profile_id, storage_ref, verified: true, identity}>}
 */
export async function captureLogin(o) {
  const ctx = { surface: "cli", correlationId: newCorrelationId(), log() {}, ...o.ctx };
  const timeoutMs = o.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_SECONDS * 1000;
  const audit = (e) => writeAuditEvent({ ...e, ctx, data: redactDeep(e.data ?? {}) });
  const orgId = o.orgId ?? (await currentOrgId());
  const proj = await getProject(o.project, orgId);
  if (!proj) throw new BrowserError("project_not_found", `Project "${o.project}" not found. Run index_project first.`);

  const reject = async (err) => {
    await audit({ projectId: proj.id, eventType: "tool_call", result: "rejected", data: { tool: "browser_login", code: err.code ?? "error" } });
    return err;
  };
  const prof = await getProfile(proj.id, o.profileId);
  try {
    if (!prof) throw new BrowserError("profile_not_found", `Profile "${o.profileId}" not found in project "${o.project}"`);
    assertEnvironmentAllowed(prof.environment);
    // State is keyed by profile id and each profile has one auth mode (P4 contract):
    // only a saved_state profile ever reads what this command writes.
    assertAuthMode(prof, "saved_state");
  } catch (e) {
    throw await reject(e);
  }
  const def = { ...prof.definition, allowed_origins: prof.allowed_origins };
  const loginUrl = def.login?.url ?? def.base_url;
  const scope = { orgId, project: proj.name, profileId: prof.profile_id ?? o.profileId };

  await audit({ projectId: proj.id, eventType: "manual_login_started", result: "ok", data: { profile_id: o.profileId } });

  const pending = [];
  let session = null;
  let timer = null;
  let outcome;
  try {
    let onClosedReject;
    const closed = new Promise((_, rej) => { onClosedReject = rej; });
    closed.catch(() => {}); // only observed through the race
    const sessionId = `bl_${randomBytes(8).toString("hex")}`;
    session = await o.adapter.createSession({
      sessionId,
      allowedOrigins: prof.allowed_origins,
      headed: true,
      onBlocked: (event) => {
        pending.push(audit({ projectId: proj.id, eventType: "origin_blocked", result: "blocked", data: event }).catch(() => {}));
      },
      onClosed: () => onClosedReject(new BrowserError("login_cancelled", "the browser was closed before the login was confirmed")),
    });
    await session.goto(loginUrl);

    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new BrowserError("login_timeout", `no confirmation within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.resolve().then(() => o.waitForDone({ session })), timeout, closed]);
    clearTimeout(timer);

    const v = await verifyAuthenticated(session, def, { waitMs: o.verifyWaitMs });
    if (!v.ok) throw new BrowserError("verification_failed", "the page after login did not pass the profile's verification; nothing was saved");

    const state = await session.storageState();
    for (const c of state?.cookies ?? []) registerSensitive(c.value);
    const ref = await saveStorageState(scope, state, {
      baseDir: o.stateDir,
      forbiddenRoots: [proj.root_path].filter(Boolean),
    });
    await Promise.all(pending);
    await audit({ projectId: proj.id, eventType: "state_save", result: "ok", data: { storage_ref: ref } });
    outcome = { profile_id: o.profileId, storage_ref: ref, verified: true, identity: v.role ? { verified: true, role: v.role } : { verified: true } };
    return outcome;
  } catch (e) {
    const err = redactError(e);
    await Promise.all(pending);
    await audit({ projectId: proj.id, eventType: "manual_login_finished", result: "failed", data: { code: err.code ?? "error" } }).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    try { await session?.close(); } catch { /* already gone */ }
    if (outcome) await audit({ projectId: proj.id, eventType: "manual_login_finished", result: "ok", data: { profile_id: o.profileId } });
  }
}

