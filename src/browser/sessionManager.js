/**
 * Browser session manager (REQ-009..013, spec 6.2.1 / 6.2.2 / 6.2.4).
 *
 * Owns the lifecycle of a session row and of the live runtime behind it:
 *
 *   CREATED > STARTING > AUTHENTICATING > VERIFYING > READY
 *   EXPIRED (saved state no longer verifies, or a READY session was bounced to login)
 *   FAILED  (terminal)   CLOSED (terminal)   AUTH_REQUIRED is reserved and never emitted.
 *
 * It talks to the browser only through the runtime adapter (CON-002), reads the
 * login/verify selectors from the stored profile (never from the caller, CON-004),
 * and writes an audit row for every transition, tool call, state save and blocked
 * navigation. Nothing it returns, logs or stores contains a secret value: results
 * and audit data pass through redactDeep, and secrets are resolved only at the
 * moment they are typed.
 *
 * Process model: the runtime handle lives in this process's memory, so a row
 * records its owner (host, pid, boot id). See `ownership` below.
 */
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import { config, browserSecretEnvName } from "../config.js";
import { pool } from "../db.js";
import { BrowserError } from "./errors.js";
import { writeAuditEvent, newCorrelationId } from "./audit.js";
import { isOriginAllowed } from "./origin.js";
import { assertAuthMode, assertEnvironmentAllowed, isLoginPage } from "./profileSchema.js";
import { getProfile, requireProject } from "./profileStore.js";
import { hasSecret, resolveSecret, createSensitiveScope, redactDeep, redact } from "./secrets.js";
import { loadStorageState, saveStorageState, recordArtifact } from "./stateStore.js";

export const SESSION_STATUSES = Object.freeze([
  "CREATED", "STARTING", "AUTHENTICATING", "VERIFYING", "READY", "EXPIRED", "FAILED", "CLOSED",
]);
/** Statuses that hold (or are acquiring) a browser runtime owned by a process. */
const LIVE = ["CREATED", "STARTING", "AUTHENTICATING", "VERIFYING", "READY"];
const TERMINAL_SQL = `('CLOSED', 'FAILED')`;
const VERIFY_WAIT_MS = 5000;
/** setTimeout's limit: a larger delay overflows and fires after ~1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * The owner's lease when no idle lease applies: from row creation until READY,
 * and for the whole session when the idle timeout is disabled. The owner
 * refreshes it every third of its length, so it lapses only when the owner is gone.
 */
export const OWNER_LEASE_MS = 5 * 60_000;
/** Thrown inside start() when a teardown ran during one of its awaits. */
const TORN_DOWN = Symbol("torn_down");

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * REQ-011 verification, shared by the session manager and the human-only
 * browser-login capture (REQ-017). `def` is the stored definition plus `allowed_origins`.
 * Returns `{ ok, role? }`; a navigation that throws (e.g. origin_blocked) propagates.
 */
export async function verifyAuthenticated(runtime, def, { waitMs = VERIFY_WAIT_MS } = {}) {
  const v = def.verify;
  const nav = await runtime.goto(v.url);
  const finalUrl = await runtime.url();
  if (!isOriginAllowed(finalUrl, def.allowed_origins)) return { ok: false };
  if (isLoginPage(def, finalUrl)) return { ok: false };
  if (!(nav.status < 400)) return { ok: false };
  if (v.selector && !(await runtime.exists(v.selector, { timeoutMs: waitMs }))) return { ok: false };
  if (v.text && !(await runtime.containsText(v.text))) return { ok: false };
  let role;
  if (v.identity_selector && (await runtime.exists(v.identity_selector))) {
    const text = ((await runtime.textContent(v.identity_selector)) ?? "").trim();
    if (text) role = text.slice(0, 80);
  }
  return { ok: true, role };
}

/**
 * @param {object} [o]
 * @param {object} [o.adapter]            a ready adapter (tests); otherwise adapterFactory is called lazily, once
 * @param {Function} [o.adapterFactory]   () => adapter
 * @param {string} [o.stateDir]           saved-state root; default config.browserStateDir
 * @param {number} [o.idleTimeoutMs]      default config.browserIdleTimeoutSeconds * 1000
 * @param {number} [o.ownerLeaseMs]       default OWNER_LEASE_MS (start / heartbeat lease)
 * @param {string} [o.hostname] @param {number} [o.pid] @param {string} [o.bootId] @param {Function} [o.isPidAlive]
 */
export function createSessionManager(o = {}) {
  const stateDir = o.stateDir;
  const idleTimeoutMs = o.idleTimeoutMs ?? config.browserIdleTimeoutSeconds * 1000;
  const ownerLeaseMs = o.ownerLeaseMs ?? OWNER_LEASE_MS;
  // The lease written on READY and after each call: the idle lease, or the heartbeat lease.
  const leaseMs = idleTimeoutMs > 0 ? idleTimeoutMs : ownerLeaseMs;
  const hostname = o.hostname ?? os.hostname();
  const pid = o.pid ?? process.pid;
  const bootId = o.bootId ?? randomUUID();
  const isPidAlive = o.isPidAlive ?? pidAlive;
  const verifyWaitMs = o.verifyWaitMs ?? VERIFY_WAIT_MS;
  const live = new Map(); // sessionId -> entry
  let adapter = o.adapter ?? null;

  const getAdapter = async () => {
    if (!adapter) {
      const make = o.adapterFactory ?? (async () => (await import("./playwrightAdapter.js")).createPlaywrightAdapter());
      adapter = await make();
    }
    return adapter;
  };

  const audit = (e) => writeAuditEvent({ ...e, data: redactDeep(e.data ?? {}) });
  const bgCtx = (entry) => ({ surface: entry.surface, correlationId: newCorrelationId(), log() {} });
  const quiet = (ctx) => (err) => { try { ctx?.log?.(redact(`browser audit write failed: ${err?.message}`)); } catch { /* ignore */ } };

  async function transition(entry, to, { reason = null, cause, ctx, lastVerified = false, lease = false, identity } = {}) {
    const res = await pool.query(
      `WITH old AS (SELECT status FROM browser_sessions WHERE id = $1 FOR UPDATE)
       UPDATE browser_sessions s SET
         status = $2, reason = $3,
         closed_at = CASE WHEN $2 = 'CLOSED' THEN now() ELSE s.closed_at END,
         last_verified_at = CASE WHEN $4 THEN now() ELSE s.last_verified_at END,
         expires_at = CASE WHEN $5 THEN now() + ($6::bigint * interval '1 millisecond') ELSE s.expires_at END,
         identity = COALESCE($7::jsonb, s.identity)
       FROM old WHERE s.id = $1 AND s.status NOT IN ${TERMINAL_SQL}
       RETURNING old.status AS prev`,
      [entry.id, to, reason, lastVerified, lease, leaseMs, identity ? JSON.stringify(identity) : null]
    );
    if (!res.rows.length) return null; // already terminal: never move out of FAILED/CLOSED
    const prev = res.rows[0].prev;
    entry.status = to;
    const data = { from: prev, to };
    if (reason) data.reason = reason;
    if (cause) data.cause = cause;
    await audit({
      projectId: entry.projectId, sessionId: entry.id, ctx,
      eventType: to === "CLOSED" ? "session_closed" : "session_transition",
      result: to === "FAILED" ? "failed" : to === "EXPIRED" ? "expired" : "ok",
      data,
    });
    return prev;
  }

  const arm = (entry) => {
    clearTimeout(entry.timer);
    if (!(idleTimeoutMs > 0)) return;
    entry.timer = setTimeout(() => {
      // Never tear down under an in-flight call; release() re-arms the timer.
      if (entry.busy || entry.closing) return;
      teardown(entry, "CLOSED", { reason: "idle_timeout", cause: "idle_timeout", ctx: bgCtx(entry) }).catch(() => {});
    }, Math.min(idleTimeoutMs, MAX_TIMER_MS)); // clamped (~24.8 days); the lease keeps the full value
    entry.timer.unref?.();
  };

  /** Release the runtime and move the row. `closing` is set synchronously, before any await. */
  function teardown(entry, to, opts) {
    if (entry.closing) return entry.done;
    entry.closing = true;
    clearTimeout(entry.timer);
    clearInterval(entry.heartbeat);
    entry.done = (async () => {
      try { await entry.runtime?.close(); } catch { /* releasing a dead runtime */ }
      try {
        await transition(entry, to, opts);
      } finally {
        live.delete(entry.id);
        entry.sensitive.dispose(); // this session's cookie values stop being redacted
      }
    })();
    return entry.done;
  }

  /**
   * Keep the owner lease current (spec 6.2.2 cross-host liveness) while no idle
   * lease applies: during start, and always when the idle timeout is disabled.
   */
  function startHeartbeat(entry) {
    entry.heartbeat = setInterval(() => {
      if (entry.closing || (idleTimeoutMs > 0 && entry.status === "READY")) return;
      pool.query(
        `UPDATE browser_sessions SET expires_at = now() + ($2::bigint * interval '1 millisecond')
          WHERE id = $1 AND status NOT IN ${TERMINAL_SQL} AND status <> 'EXPIRED'`,
        [entry.id, ownerLeaseMs]
      ).catch(() => {});
    }, Math.min(Math.max(Math.floor(ownerLeaseMs / 3), 1), MAX_TIMER_MS));
    entry.heartbeat.unref?.();
  }

  const flush = (entry) => Promise.allSettled([...entry.pending]);

  function track(entry, p) {
    entry.pending.add(p);
    p.finally(() => entry.pending.delete(p)).catch(() => {});
  }

  function newEntry(proj, row, surface) {
    return {
      id: row.id, projectId: proj.id, profileId: row.profile_id, status: "CREATED", surface,
      runtime: null, busy: false, closing: false, timer: null, heartbeat: null, done: null, pending: new Set(),
      sensitive: createSensitiveScope(),
    };
  }

  const iso = (d) => (d ? new Date(d).toISOString() : null);
  function view(row, extra = {}) {
    const out = {
      session_id: row.id, status: row.status, auth_mode: row.auth_mode,
      environment: row.environment ?? null,
      identity: row.identity ?? { verified: false },
      last_verified_at: iso(row.last_verified_at),
      ...extra,
    };
    if (row.reason) out.reason = row.reason;
    return redactDeep(out);
  }

  async function loadRow(proj, sessionId) {
    const res = await pool.query(
      `SELECT s.*, (s.expires_at < now()) AS lease_lapsed, p.environment
         FROM browser_sessions s
         LEFT JOIN browser_profiles p ON p.project_id = s.project_id AND p.profile_id = s.profile_id
        WHERE s.id = $1 AND s.project_id = $2`,
      [String(sessionId), proj.id]
    );
    return res.rows[0] ?? null;
  }

  async function rejectAudit(proj, sessionId, tool, err, ctx) {
    await audit({
      projectId: proj.id, sessionId, eventType: "tool_call", result: "rejected", ctx,
      data: { tool, code: err.code ?? "error" },
    });
  }

  /** Load a session of this project (other projects look identical to "does not exist"). */
  async function locate(project, sessionId, tool, ctx, orgId) {
    const found = await requireProject(project, orgId);
    const proj = found.project;
    const row = await loadRow(proj, sessionId);
    if (!row) {
      const err = new BrowserError("session_not_found", `no session ${sessionId} in project "${project}"`);
      await rejectAudit(proj, null, tool, err, ctx);
      throw err;
    }
    return { proj, row, orgId: found.orgId };
  }

  /**
   * Spec 6.2.2. For a non-terminal row:
   *  - owned by this process: the runtime must still be alive, else FAILED/runtime_lost;
   *  - same host, other process: dead pid -> FAILED/runtime_lost, live pid -> session_not_in_this_process;
   *  - other host: pids cannot be probed, so the lease (expires_at) decides: lapsed ->
   *    FAILED/runtime_lost, current -> session_not_in_this_process.
   * Returns { row, entry } with the freshest row.
   */
  async function ownership(proj, row, tool, ctx) {
    if (!LIVE.includes(row.status)) return { row, entry: null };
    const o = row.owner_runtime ?? {};
    const entry = live.get(row.id) ?? null;
    let lost = false;
    if (o.boot_id === bootId) {
      if (entry?.closing) {
        await entry.done.catch(() => {});
        return { row: await loadRow(proj, row.id), entry: null };
      }
      lost = !entry || (entry.runtime && entry.runtime.isAlive() === false);
    } else if (o.host === hostname) {
      if (isPidAlive(o.pid)) lost = false;
      else lost = true;
      if (!lost) return notHere();
    } else {
      lost = Boolean(row.lease_lapsed);
      if (!lost) return notHere();
    }
    if (!lost) return { row, entry };
    const target = entry ?? newEntry(proj, row, ctx.surface);
    if (entry) await teardown(entry, "FAILED", { reason: "runtime_lost", cause: "owner_gone", ctx });
    else await transition(target, "FAILED", { reason: "runtime_lost", cause: "owner_gone", ctx });
    return { row: await loadRow(proj, row.id), entry: null };

    async function notHere() {
      const err = new BrowserError("session_not_in_this_process", "the session is owned by another running process");
      await rejectAudit(proj, row.id, tool, err, ctx);
      throw err;
    }
  }

  const FAIL_PASSTHROUGH = new Set(["secret_missing", "state_missing", "runtime_unavailable"]);

  /** Map an error thrown during start to a session reason, or null to rethrow. */
  function reasonFor(err, phase, entry) {
    if (entry.runtime && entry.runtime.isAlive() === false) return "runtime_lost";
    if (!(err instanceof BrowserError)) return "runtime_lost";
    if (FAIL_PASSTHROUGH.has(err.code)) return err.code;
    if (phase === "launch") return "runtime_lost";
    if (phase === "login") return "login_failed";
    if (phase === "verify") return "verification_failed";
    return null;
  }

  const verify = (runtime, def) => verifyAuthenticated(runtime, def, { waitMs: verifyWaitMs });

  // -------------------------------------------------------------------------------

  async function start({ project, profileId, purpose, authMode, ctx, orgId }) {
    const tool = "browser_session_start";
    const found = await requireProject(project, orgId);
    const proj = found.project;
    orgId = found.orgId;
    const prof = await getProfile(proj.id, profileId);
    try {
      if (!prof) throw new BrowserError("profile_not_found", `Profile "${profileId}" not found in project "${project}"`);
      assertEnvironmentAllowed(prof.environment);
      assertAuthMode(prof, authMode ?? prof.auth_mode);
    } catch (e) {
      await rejectAudit(proj, null, tool, e, ctx);
      throw e;
    }
    const def = { ...prof.definition, allowed_origins: prof.allowed_origins };
    const mode = prof.auth_mode;
    const id = `bs_${randomBytes(16).toString("hex")}`;
    await pool.query(
      `INSERT INTO browser_sessions (id, project_id, profile_id, status, auth_mode, owner_runtime, purpose, identity, expires_at)
       VALUES ($1, $2, $3, 'CREATED', $4, $5, $6, $7, now() + ($8::bigint * interval '1 millisecond'))`,
      [id, proj.id, profileId, mode, JSON.stringify({ host: hostname, pid, boot_id: bootId }), String(purpose ?? "").slice(0, 200), JSON.stringify({ verified: false }), ownerLeaseMs]
    );
    const entry = newEntry(proj, { id, profile_id: profileId }, ctx.surface);
    live.set(id, entry);
    startHeartbeat(entry);
    entry.busy = true; // the whole start is one in-flight operation
    await audit({ projectId: proj.id, sessionId: id, eventType: "session_transition", result: "ok", ctx, data: { to: "CREATED" } });
    await audit({ projectId: proj.id, sessionId: id, eventType: "tool_call", result: "ok", ctx, data: { tool, profile_id: profileId, auth_mode: mode } });

    const scope = { orgId, project: proj.name, profileId };
    let phase = "prepare";
    const finish = async (to, reason, cause) => {
      await teardown(entry, to, { reason, cause, ctx });
      await flush(entry);
      const row = await loadRow(proj, id);
      return view(row);
    };

    try {
      await transition(entry, "STARTING", { ctx });
      let storageState;
      if (mode === "fresh_login") {
        const login = def.login;
        for (const name of [login.username_secret, login.password_secret]) {
          if (!hasSecret(name)) throw new BrowserError("secret_missing", `${browserSecretEnvName(name)} is not set`);
        }
      } else {
        storageState = loadStorageState(scope, { baseDir: stateDir, sensitive: entry.sensitive });
      }

      phase = "launch";
      const ad = await getAdapter();
      if (entry.closing) throw TORN_DOWN;
      const runtime = await ad.createSession({
        sessionId: id,
        allowedOrigins: prof.allowed_origins,
        storageState,
        onBlocked: (event) => {
          track(entry, audit({
            projectId: proj.id, sessionId: id, eventType: "origin_blocked", result: "blocked",
            ctx: bgCtx(entry), data: event,
          }).catch(quiet(ctx)));
        },
        onClosed: () => {
          teardown(entry, "FAILED", { reason: "runtime_lost", cause: "runtime_died", ctx: bgCtx(entry) }).catch(quiet(ctx));
        },
      });
      if (entry.closing) {
        // Torn down (profile removed, shutdown) while the launch was in flight: the
        // teardown found no runtime to release, so release this one here.
        try { await runtime.close(); } catch { /* already gone */ }
        throw TORN_DOWN;
      }
      entry.runtime = runtime;
      await transition(entry, "AUTHENTICATING", { ctx });

      phase = "login";
      const rt = entry.runtime;
      if (mode === "fresh_login") {
        const login = def.login;
        await rt.goto(login.url);
        await rt.fill(login.username_selector, resolveSecret(login.username_secret));
        await rt.fill(login.password_selector, resolveSecret(login.password_secret));
        await rt.click(login.submit_selector);
      }
      await transition(entry, "VERIFYING", { ctx });

      phase = "verify";
      const v = await verify(rt, def);
      if (!v.ok) {
        return mode === "saved_state"
          ? await finish("EXPIRED", "state_expired", "verification_failed")
          : await finish("FAILED", "verification_failed", "verification_failed");
      }

      phase = "save";
      if (mode === "fresh_login" && def.auth?.save_state) {
        const state = await rt.storageState();
        entry.sensitive.addCookies(state?.cookies);
        const ref = await saveStorageState(scope, state, { baseDir: stateDir, forbiddenRoots: [proj.root_path].filter(Boolean) });
        await recordArtifact({ sessionId: id, artifactType: "storage_state", storageRef: ref });
        await audit({ projectId: proj.id, sessionId: id, eventType: "state_save", result: "ok", ctx, data: { storage_ref: ref } });
      }

      const identity = v.role ? { verified: true, role: v.role } : { verified: true };
      await transition(entry, "READY", { ctx, lastVerified: true, lease: true, identity });
      arm(entry);
      entry.busy = false;
      await flush(entry);
      return view(await loadRow(proj, id));
    } catch (err) {
      if (err === TORN_DOWN) {
        await entry.done.catch(() => {});
        await flush(entry);
        return view(await loadRow(proj, id));
      }
      if (phase === "save" || phase === "prepare") {
        // Policy/storage rejections (e.g. invalid_state_dir) and unexpected faults surface as errors.
        const reason = err instanceof BrowserError && FAIL_PASSTHROUGH.has(err.code) ? err.code : null;
        if (reason) return await finish("FAILED", reason, err.code);
        await teardown(entry, "FAILED", { cause: err.code ?? "error", ctx }).catch(() => {});
        await flush(entry);
        throw err;
      }
      const reason = reasonFor(err, phase, entry);
      return await finish("FAILED", reason, err.code ?? "error");
    } finally {
      entry.busy = false;
      if (entry.closing === false && entry.status !== "READY") await teardown(entry, "FAILED", { reason: "runtime_lost", ctx }).catch(() => {});
    }
  }

  async function status({ project, sessionId, ctx, orgId }) {
    const tool = "browser_session_status";
    const { proj, row } = await locate(project, sessionId, tool, ctx, orgId);
    const own = await ownership(proj, row, tool, ctx);
    await audit({ projectId: proj.id, sessionId: row.id, eventType: "tool_call", result: "ok", ctx, data: { tool } });
    return view(own.row, { created_at: iso(own.row.created_at), expires_at: iso(own.row.expires_at) });
  }

  async function close({ project, sessionId, ctx, orgId }) {
    const tool = "browser_session_close";
    const { proj, row } = await locate(project, sessionId, tool, ctx, orgId);
    const own = await ownership(proj, row, tool, ctx);
    const cur = own.row;
    const ok = (status) => audit({ projectId: proj.id, sessionId: cur.id, eventType: "tool_call", result: "ok", ctx, data: { tool } })
      .then(() => ({ session_id: cur.id, status }));
    // Another process (e.g. `browser-profile remove`) can make the row terminal while
    // this process still holds the runtime: release it whatever the row says.
    const stray = live.get(cur.id);
    if (stray && !LIVE.includes(cur.status)) {
      await teardown(stray, "CLOSED", { cause: "close", ctx });
      await flush(stray);
    }
    if (cur.status === "CLOSED") return ok("CLOSED");
    if (cur.status === "FAILED") return ok("FAILED"); // terminal: nothing left to release
    if (cur.status === "EXPIRED") {
      await transition(newEntry(proj, cur, ctx.surface), "CLOSED", { cause: "close", ctx });
      return ok("CLOSED");
    }
    const entry = own.entry;
    if (entry.busy) {
      const err = new BrowserError("session_busy", "another call is in flight on this session");
      await rejectAudit(proj, cur.id, tool, err, ctx);
      throw err;
    }
    await teardown(entry, "CLOSED", { cause: "close", ctx });
    await flush(entry);
    return ok("CLOSED");
  }

  /**
   * Run `fn` against a READY session this process owns, holding its busy lock.
   * fn({ runtime, session, profile, scope, expire }) -- `expire()` moves READY -> EXPIRED
   * (state_expired) and releases the runtime. Rejections: session_not_found,
   * session_not_in_this_process, session_not_ready, session_busy.
   */
  async function withSession({ project, sessionId, tool, ctx, orgId }, fn) {
    const { proj, row, orgId: resolvedOrgId } = await locate(project, sessionId, tool, ctx, orgId);
    const own = await ownership(proj, row, tool, ctx);
    const cur = own.row;
    const entry = own.entry;
    if (cur.status !== "READY" || !entry || entry.closing) {
      const err = new BrowserError("session_not_ready", `session is ${cur.status}`);
      await rejectAudit(proj, cur.id, tool, err, ctx);
      throw err;
    }
    if (entry.busy) {
      const err = new BrowserError("session_busy", "another call is in flight on this session");
      await rejectAudit(proj, cur.id, tool, err, ctx);
      throw err;
    }
    entry.busy = true;
    clearTimeout(entry.timer);
    let failure = null;
    try {
      return await fn({
        runtime: entry.runtime,
        session: view(cur),
        profile: await getProfile(proj.id, cur.profile_id),
        scope: { orgId: resolvedOrgId, project: proj.name, profileId: cur.profile_id },
        stateDir,
        rootPath: proj.root_path,
        expire: () => teardown(entry, "EXPIRED", { reason: "state_expired", cause: "login_redirect", ctx }),
      });
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      entry.busy = false;
      if (!entry.closing) {
        arm(entry);
        await pool.query(
          `UPDATE browser_sessions SET expires_at = now() + ($2::bigint * interval '1 millisecond') WHERE id = $1 AND status = 'READY'`,
          [entry.id, leaseMs]
        ).catch(() => {});
      }
      await flush(entry);
      await audit({
        projectId: proj.id, sessionId: cur.id, eventType: "tool_call", ctx,
        result: failure ? "rejected" : "ok", data: failure ? { tool, code: failure.code ?? "error" } : { tool },
      }).catch(quiet(ctx));
    }
  }

  async function closeProfileSessions({ projectId, profileId, ctx }) {
    const targets = [...live.values()].filter((e) => e.projectId === projectId && e.profileId === profileId);
    await Promise.all(targets.map((e) => teardown(e, "CLOSED", { cause: "profile_removed", ctx })));
  }

  async function shutdown({ ctx } = {}) {
    const c = ctx ?? { surface: "cli", correlationId: newCorrelationId(), log() {} };
    await Promise.all([...live.values()].map((e) => teardown(e, "CLOSED", { cause: "process_shutdown", ctx: { ...c, surface: c.surface ?? e.surface } })));
    if (adapter) await adapter.close();
  }

  return {
    start, status, close, withSession, closeProfileSessions, shutdown, getAdapter,
    liveCount: () => live.size,
    owner: () => ({ host: hostname, pid, boot_id: bootId }),
  };
}
