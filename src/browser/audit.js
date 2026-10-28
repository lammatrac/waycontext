/**
 * Append-only audit writer for browser activity (REQ-016).
 *
 * `actor` is the surface a call arrived on and `correlation_id` ties the rows
 * of one call together. Both come from the handler `ctx` (`ctx.surface`,
 * `ctx.correlationId`), which each surface -- MCP server, CLI, HTTP -- fills
 * in; a handler never decides them itself. There is no update or delete here,
 * and the table refuses UPDATE at the database.
 *
 * `data` must carry no secret content: pass names, codes and URLs, never values.
 */
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";

export const AUDIT_ACTORS = Object.freeze(["mcp", "cli", "http"]);

export const newCorrelationId = () => randomUUID();

/**
 * @param {object} e
 * @param {number} e.projectId
 * @param {string} [e.sessionId]   null for profile-level events
 * @param {string} e.eventType     e.g. profile_imported, tool_call, state_save
 * @param {string} e.result        e.g. ok, rejected, blocked, failed
 * @param {{surface?: string, correlationId?: string}} [e.ctx]
 * @param {object} [e.data]
 * @param {{query: Function}} [db]  a pool or client, so callers can join a transaction
 * @returns the inserted row
 */
export async function writeAuditEvent(
  { projectId, sessionId = null, eventType, result, ctx = {}, data = {} },
  db = pool
) {
  const actor = ctx.surface;
  if (!AUDIT_ACTORS.includes(actor)) {
    throw new Error(`audit actor must be one of ${AUDIT_ACTORS.join(", ")} (got ${JSON.stringify(actor ?? null)})`);
  }
  const res = await db.query(
    `INSERT INTO browser_audit_events
       (session_id, project_id, event_type, actor, result, correlation_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [sessionId, projectId, eventType, actor, result, ctx.correlationId ?? newCorrelationId(), JSON.stringify(data)]
  );
  return res.rows[0];
}
