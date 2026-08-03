#!/usr/bin/env node
/**
 * Retrieval-quality harness: does search actually find the code a task is about?
 *
 * The trick is that every repository ships its own labelled dataset. A commit
 * is a natural-language description of an intent ("purge cache after match
 * status update") paired with the exact set of files that intent turned out to
 * touch. Replaying commits therefore measures retrieval against ground truth
 * that nobody had to annotate, in the user's own codebase, in their own domain
 * vocabulary.
 *
 * What it reports
 *   recall@k    of the files a commit touched, what fraction came back in the
 *               top k results. The headline number.
 *   hit-rate    fraction of commits where at least one touched file came back.
 *   MRR         1/rank of the first correct file, averaged. Sensitive to
 *               ordering in a way recall is not.
 *
 * Read the absolute values with some suspicion -- a commit message is a lossy
 * description of a diff, so perfect recall is not achievable and not the goal.
 * The number is for comparing WayContext to WayContext: run it before and after
 * a retrieval change and see which way it moved.
 *
 *   node eval/recall.js <project> [--k 10] [--commits 100] [--json]
 *
 * Requires the project to be indexed (`waycontext index <project> <path>`),
 * which also ingests the history this reads.
 */
import { pool, getProject } from "../src/db.js";
import { searchCode } from "../src/graph.js";
import { embeddingsEnabled } from "../src/embeddings.js";

function parseArgs(argv) {
  const opts = { project: null, k: 10, commits: 100, json: false, verbose: false, minFiles: 1, maxFiles: 6 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--k") opts.k = Number(argv[++i]);
    else if (arg === "--commits") opts.commits = Number(argv[++i]);
    else if (arg === "--max-files") opts.maxFiles = Number(argv[++i]);
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else opts.project ??= arg;
  }
  if (!opts.project) throw new Error("Usage: node eval/recall.js <project> [--k 10] [--commits 100] [--json]");
  return opts;
}

/**
 * Pick commits worth scoring.
 *
 * Excluded, and why:
 *   merges                  no message of their own worth searching
 *   reverts                 the message describes the undo, not the intent
 *   commits with no indexed file
 *                           unanswerable: the target isn't in the index
 *   files with no symbols   searchCode returns symbols, so a commit that only
 *                           touched prose (a README, an ADR) is unanswerable by
 *                           construction. Since Phase 2 those files have `files`
 *                           rows too, and counting them would make the score
 *                           drop for a reason that has nothing to do with
 *                           retrieval quality. Doc retrieval is search_knowledge's
 *                           job and needs its own harness.
 *   sprawling commits       a 40-file refactor is a rename sweep, not a task;
 *                           including them mostly measures repo layout
 *   one-word subjects       "wip", "fixes" -- no retrievable signal
 *
 * Sampling is a deterministic stride over sha order rather than a random
 * sample, so two runs on the same database score the same commits and a
 * before/after comparison means something.
 */
async function sampleCommits(project, { commits, minFiles, maxFiles }) {
  const res = await pool.query(
    `WITH scored AS (
       SELECT c.entity_id, c.sha, c.short_sha, c.subject, c.authored_at,
              array_agg(DISTINCT cf.path) AS paths
         FROM commits c
         JOIN commit_files cf ON cf.commit_entity_id = c.entity_id
         JOIN files f ON f.project_id = c.project_id AND f.path = cf.path
                     AND EXISTS (SELECT 1 FROM symbols s WHERE s.file_id = f.id)
        WHERE c.project_id = $1
          AND NOT c.is_merge AND NOT c.is_revert
          AND length(coalesce(c.subject, '')) >= 15
          AND array_length(regexp_split_to_array(btrim(c.subject), '\\s+'), 1) >= 3
        GROUP BY c.entity_id, c.sha, c.short_sha, c.subject, c.authored_at
     )
     SELECT * FROM (
       SELECT *, row_number() OVER (ORDER BY sha) AS rn, count(*) OVER () AS total
         FROM scored
        WHERE array_length(paths, 1) BETWEEN $2 AND $3
     ) s
      ORDER BY rn`,
    [project.id, minFiles, maxFiles]
  );
  if (!res.rows.length) return [];
  const stride = Math.max(1, Math.floor(res.rows.length / commits));
  return res.rows.filter((_, i) => i % stride === 0).slice(0, commits);
}

/**
 * Strip the parts of a subject that describe the change rather than the code.
 * "Trac Lam - feat: add hook refresh" and "fix(auth): token expiry" both carry
 * a prefix that is pure noise to a semantic search over source.
 */
function toQuery(subject) {
  return subject
    .replace(/^[^:]{0,40}?\b(?:feat|fix|chore|refactor|docs|test|perf|build|ci|style)\b\s*(?:\([^)]*\))?\s*:\s*/i, "")
    .replace(/^\s*[\w.\- ]{0,30}?\s+-\s+/, "")
    .replace(/\(#\d+\)\s*$/, "")
    .trim() || subject.trim();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = await getProject(opts.project);
  if (!project) throw new Error(`Project "${opts.project}" not found. Index it first.`);

  const sample = await sampleCommits(project, opts);
  if (!sample.length) {
    throw new Error(
      `No scorable commits for "${opts.project}". Has it been indexed since git history ingestion was added?`
    );
  }

  const results = [];
  for (const commit of sample) {
    const query = toQuery(commit.subject);
    const hits = await searchCode(opts.project, query, opts.k);
    const returned = hits.map((h) => h.path);
    const expected = new Set(commit.paths);

    let firstRank = 0;
    returned.forEach((path, i) => {
      if (!firstRank && expected.has(path)) firstRank = i + 1;
    });
    const found = returned.filter((p) => expected.has(p));
    const uniqueFound = new Set(found).size;

    results.push({
      sha: commit.short_sha,
      subject: commit.subject,
      query,
      expected: [...expected],
      recall: uniqueFound / expected.size,
      hit: firstRank > 0,
      rr: firstRank > 0 ? 1 / firstRank : 0,
      first_rank: firstRank || null,
    });
  }

  const mean = (pick) => results.reduce((sum, r) => sum + pick(r), 0) / results.length;
  const report = {
    project: opts.project,
    k: opts.k,
    commits_scored: results.length,
    embeddings: embeddingsEnabled() ? "on" : "off (full-text only)",
    [`recall@${opts.k}`]: +mean((r) => r.recall).toFixed(4),
    hit_rate: +mean((r) => (r.hit ? 1 : 0)).toFixed(4),
    mrr: +mean((r) => r.rr).toFixed(4),
  };

  if (opts.json) {
    console.log(JSON.stringify({ ...report, results: opts.verbose ? results : undefined }, null, 2));
  } else {
    console.table([report]);
    if (opts.verbose) {
      console.table(
        results.map((r) => ({
          sha: r.sha,
          recall: +r.recall.toFixed(2),
          rank: r.first_rank ?? "-",
          query: r.query.slice(0, 60),
        }))
      );
    }
    const misses = results.filter((r) => !r.hit).length;
    if (misses) console.log(`\n${misses}/${results.length} commits returned none of their files.`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
