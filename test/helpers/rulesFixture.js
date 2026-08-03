import { pool, getProject } from "../../src/db.js";
import { upsertRule } from "../../src/knowledge/rules.js";

/** Insert an already-active rule, bypassing the candidate queue, for scope tests. */
export async function addScopedRule(projectName, statement, scope) {
  const project = await getProject(projectName);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = await upsertRule(client, project, {
      statement, scope, severity: "high", origin: "manual",
      originRef: null, confidence: 1, state: "active", verifiedBy: "test",
    });
    await client.query("COMMIT");
    return id;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
