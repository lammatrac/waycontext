/**
 * Derived intelligence, computed in-process at the end of an index run.
 *
 * No queue, no worker, no second service: this runs inside the advisory lock
 * indexProject already holds, so two concurrent runs on the same project cannot
 * interleave derivations, and a project with nothing to recompute pays one
 * watermark comparison.
 *
 * Every derivation is additive knowledge and must never fail a code index --
 * the same contract git history and rule extraction already have.
 */
import { pool } from "../db.js";
import { config } from "../config.js";
import { writeModules } from "./modules.js";
import { writeModuleMetrics, writeOwnership, writeCochange } from "./metrics.js";
import { writeBugClusters } from "./clusters.js";

/**
 * What the derivations consumed, as one opaque string.
 *
 * Deliberately shared by every kind rather than tracked per input. Modules are
 * derived from the parse plane and metrics from history, so a per-input
 * watermark would let modules recompute while metrics stayed put -- leaving
 * fresh modules with stale metrics, or a brand-new module with none at all.
 * One watermark means they always move together.
 *
 * A project with no `last_indexed_sha` (not a git repo, or a run that had
 * failures) gets a watermark that changes every run, so it always recomputes.
 * That is the right default: without a commit sha there is nothing cheap to
 * compare, and being wrong here means silently serving stale metrics.
 */
export function watermarkFor(row) {
  if (!row?.last_indexed_sha) {
    const stamp = row?.indexed_at ? new Date(row.indexed_at).getTime() : "unknown";
    return `run:${stamp}`;
  }
  return `sha:${row.last_indexed_sha}|hist:${row.last_history_sha ?? "none"}`;
}

// Order matters: modules own the file->module mapping every later kind joins
// through, so it goes first.
const DERIVATIONS = [
  { kind: "modules", run: (p, log) => writeModules(p, log), count: (r) => r.modules },
  { kind: "metrics", run: (p, log) => writeModuleMetrics(p, log), count: (r) => r.modules },
  { kind: "ownership", run: (p) => writeOwnership(p), count: (r) => r.rows },
  { kind: "cochange", run: (p, log) => writeCochange(p, log), count: (r) => r.pairs },
  { kind: "clusters", run: (p, log) => writeBugClusters(p, log), count: (r) => r.clusters },
];

/**
 * Recompute whatever is stale for a project.
 *
 * @returns {Promise<null|{watermark:string, computed:Object, skipped:string[], failed:Object}>}
 *          null when derivation is switched off entirely
 */
export async function deriveIntelligence(project, log = () => {}) {
  if (!config.deriveEnabled) return null;

  // Read the project row back rather than trusting the copy the caller has:
  // indexProject only advances last_indexed_sha at the very end of a clean run,
  // and that update is exactly what this watermark is about.
  const fresh = await pool.query(
    `SELECT last_indexed_sha, last_history_sha, indexed_at FROM projects WHERE id = $1`,
    [project.id]
  );
  const watermark = watermarkFor(fresh.rows[0]);

  const prior = await pool.query(
    `SELECT kind, input_watermark FROM derived_state WHERE project_id = $1`,
    [project.id]
  );
  const seen = new Map(prior.rows.map((r) => [r.kind, r.input_watermark]));

  const computed = {};
  const skipped = [];
  const failed = {};

  for (const d of DERIVATIONS) {
    if (seen.get(d.kind) === watermark) { skipped.push(d.kind); continue; }
    const started = Date.now();
    try {
      const result = await d.run(project, log);
      const duration = Date.now() - started;
      await pool.query(
        `INSERT INTO derived_state (project_id, kind, input_watermark, row_count, duration_ms, computed_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (project_id, kind) DO UPDATE
            SET input_watermark = EXCLUDED.input_watermark,
                row_count = EXCLUDED.row_count,
                duration_ms = EXCLUDED.duration_ms,
                computed_at = now()`,
        [project.id, d.kind, watermark, d.count(result) ?? 0, duration]
      );
      computed[d.kind] = { ...result, duration_ms: duration };
    } catch (e) {
      // The watermark is deliberately NOT recorded on failure, so the next run
      // retries this kind -- the same rule last_indexed_sha follows.
      log(`Derivation "${d.kind}" skipped: ${e.message}`);
      failed[d.kind] = e.message;
    }
  }

  const names = Object.keys(computed);
  if (names.length) log(`Derived: ${names.join(", ")}`);
  return {
    watermark,
    computed,
    skipped,
    failed: Object.keys(failed).length ? failed : null,
  };
}
