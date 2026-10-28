/**
 * Browser profile store: import, replace, list, read and remove.
 *
 * Only the human-only CLI (`waycontext browser-profile import|remove`) calls
 * importProfile and removeProfile. They are not operations, so no MCP or HTTP
 * caller can create or widen a profile (REQ-002). The agent-facing read is
 * listProfiles, behind `browser_profile_list`.
 */
import { pool, currentOrgId, getProject } from "../db.js";
import { BrowserError } from "./errors.js";
import { parseProfileYaml } from "./profileSchema.js";
import { writeAuditEvent } from "./audit.js";
import { deleteSavedState } from "./stateStore.js";

const CLI_CTX = { surface: "cli" };

/** The project row and resolved org id, or `project_not_found`. Shared by every browser module. */
export async function requireProject(name, orgId) {
  orgId ??= await currentOrgId();
  const project = await getProject(name, orgId);
  if (!project) throw new BrowserError("project_not_found", `Project "${name}" not found. Run index_project first.`);
  return { project, orgId };
}

// Seams the later phases fill in. P1 cannot know whether a saved state file
// exists (the state store is P2) or tear down a live browser (the runtime is
// P3/P4), so each has a safe default and a setter. Passing null restores it.
let savedStateProbe = null;
let removalHook = null;

/** P2: `({ orgId, project, projectId, profileId }) => boolean | Promise<boolean>`. */
export function setSavedStateProbe(fn) {
  savedStateProbe = fn;
}

/**
 * P4: `({ projectId, profileId, ctx }) => Promise<void>`, called before the
 * profile is deleted so live runtimes can be torn down. Whatever it does, the
 * store then marks any still-live session rows CLOSED.
 */
export function registerProfileRemovalHook(fn) {
  removalHook = fn;
}

/**
 * Validate and store a profile (replacing one with the same profile_id).
 * `source` is YAML text or an already-loaded object. Nothing is written when
 * validation fails.
 */
export async function importProfile(projectName, source, { orgId, ctx = CLI_CTX } = {}) {
  const def = parseProfileYaml(source);
  const found = await requireProject(projectName, orgId);
  const { project } = found;
  const res = await pool.query(
    `INSERT INTO browser_profiles
       (project_id, profile_id, environment, base_url, allowed_origins, auth_mode, definition)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, profile_id) DO UPDATE SET
       environment = EXCLUDED.environment, base_url = EXCLUDED.base_url,
       allowed_origins = EXCLUDED.allowed_origins, auth_mode = EXCLUDED.auth_mode,
       definition = EXCLUDED.definition, updated_at = now()
     RETURNING (xmax <> 0) AS replaced`,
    [
      project.id, def.profile_id, def.environment, def.base_url,
      JSON.stringify(def.allowed_origins), def.auth.mode, JSON.stringify(def),
    ]
  );
  await writeAuditEvent({
    projectId: project.id, eventType: "profile_imported", result: "ok", ctx,
    data: { profile_id: def.profile_id, environment: def.environment, auth_mode: def.auth.mode },
  });
  return {
    project: project.name, profile_id: def.profile_id, environment: def.environment,
    base_url: def.base_url, allowed_origins: def.allowed_origins, auth_mode: def.auth.mode,
    replaced: res.rows[0].replaced,
  };
}

/**
 * Remove a profile, closing its live sessions first (spec § 9), and delete its
 * saved storage state so a later profile with the same id does not inherit it.
 * Screenshot evidence under the profile directory is kept. `stateDir` defaults
 * to config.browserStateDir.
 */
export async function removeProfile(projectName, profileId, { orgId, ctx = CLI_CTX, stateDir } = {}) {
  const found = await requireProject(projectName, orgId);
  const { project } = found;
  const existing = await getProfile(project.id, profileId);
  if (!existing) throw new BrowserError("profile_not_found", `Profile "${profileId}" not found in project "${projectName}"`);

  if (removalHook) await removalHook({ projectId: project.id, profileId, ctx });
  const closed = await pool.query(
    `UPDATE browser_sessions SET status = 'CLOSED', closed_at = now()
      WHERE project_id = $1 AND profile_id = $2 AND status NOT IN ('CLOSED', 'FAILED', 'EXPIRED')
      RETURNING id`,
    [project.id, profileId]
  );
  for (const s of closed.rows) {
    await writeAuditEvent({
      projectId: project.id, sessionId: s.id, eventType: "session_closed", result: "ok", ctx,
      data: { cause: "profile_removed", profile_id: profileId },
    });
  }
  await pool.query(`DELETE FROM browser_profiles WHERE project_id = $1 AND profile_id = $2`, [project.id, profileId]);
  const stateDeleted = deleteSavedState({ orgId: found.orgId, project: project.name, profileId }, stateDir ? { baseDir: stateDir } : {});
  await writeAuditEvent({
    projectId: project.id, eventType: "profile_removed", result: "ok", ctx,
    data: { profile_id: profileId, sessions_closed: closed.rows.length, saved_state_deleted: stateDeleted },
  });
  return { removed: true, profile_id: profileId, sessions_closed: closed.rows.length };
}

/** Full stored profile row for the runtime phases, or null. Never exposed to agents. */
export async function getProfile(projectId, profileId) {
  const res = await pool.query(
    `SELECT id, project_id, profile_id, environment, base_url, allowed_origins, auth_mode, definition
       FROM browser_profiles WHERE project_id = $1 AND profile_id = $2`,
    [projectId, profileId]
  );
  return res.rows[0] ?? null;
}

/**
 * REQ-003: the profiles of one project, with only the declared fields. The row
 * is projected explicitly -- `definition` (selectors, secret names) is never
 * spread into the result.
 */
export async function listProfiles(projectName, { orgId } = {}) {
  const found = await requireProject(projectName, orgId);
  const res = await pool.query(
    `SELECT profile_id, environment, base_url, allowed_origins, auth_mode
       FROM browser_profiles WHERE project_id = $1 ORDER BY profile_id`,
    [found.project.id]
  );
  const out = [];
  for (const r of res.rows) {
    const has = savedStateProbe
      ? await savedStateProbe({
          orgId: found.orgId, project: found.project.name, projectId: found.project.id, profileId: r.profile_id,
        })
      : false;
    out.push({
      profile_id: r.profile_id,
      environment: r.environment,
      base_url: r.base_url,
      allowed_origins: r.allowed_origins,
      auth_mode: r.auth_mode,
      has_saved_state: Boolean(has),
    });
  }
  return out;
}
