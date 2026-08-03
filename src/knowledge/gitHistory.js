/**
 * Git history ingestion: commits, per-file churn, authors and issue references.
 *
 * One streaming `git log` pass, zero per-commit subprocesses. src/gitDiff.js
 * uses buffered execFile, which is right for a diff of a handful of files and
 * fatal for a 100k-commit log -- the whole thing would land in one string
 * before a single row was written. Here git streams into a record splitter and
 * rows are flushed in batches as they arrive.
 *
 * The record framing uses ASCII control characters that cannot appear in a
 * commit message: RS between commits, US between fields, GS to close the raw
 * body. Without a body terminator there is no way to tell where a multi-line
 * commit message ends and --numstat output begins, since a message can
 * perfectly well contain a line that looks like "12\t3\tsrc/foo.js".
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool } from "../db.js";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export const RECORD_SEP = "\x1e";
export const FIELD_SEP = "\x1f";
export const BODY_SEP = "\x1d";

// %aN/%aE rather than %an/%ae: the capitalised forms apply .mailmap, so the
// four addresses one contributor has used over five years collapse into one
// identity for free, which is the whole basis of "ask John, he owns Auth".
export const LOG_FORMAT =
  RECORD_SEP +
  ["%H", "%h", "%aN", "%aE", "%aI", "%cI", "%P", "%B"].join(FIELD_SEP) +
  BODY_SEP;

/** How many commits are turned into rows per transaction. */
const BATCH_SIZE = 250;

// --- message mining --------------------------------------------------------

// Anchoring these at the start of the subject was wrong: plenty of teams
// prefix conventional commits with something ("Trac Lam - fix: ...", a ticket
// id, a scope), and "^fix" then never matches. Word-boundary matching anywhere
// in the subject costs the odd false positive ("revert the fix-up") and is far
// better than reporting that a repository has never fixed anything.
const FIX_SUBJECT_RE = /\b(?:fix|fixes|fixed|fixing|bugfix|hotfix|regression)\b/i;
const REVERT_SUBJECT_RE = /\brevert(?:s|ed|ing)?\b/i;
const REVERT_BODY_RE = /^This reverts commit\b/im;
const COAUTHOR_RE = /^\s*co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/gim;

const GITHUB_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)/gi;
const JIRA_URL_RE = /https?:\/\/[\w.-]+\/browse\/([A-Z][A-Z0-9]{1,9}-\d{1,7})/gi;
const HASH_REF_RE = /(?:^|[^\w#/&])#(\d{1,7})(?![\w-])/g;
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;
const CLOSING_RE =
  /\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s*:?\s+(?:(?:https?:\/\/\S*?\/(?:issues|pull)\/(\d+))|#(\d{1,7})|([A-Z][A-Z0-9]{1,9}-\d{1,7}))\b/gi;

/**
 * Prefixes that look exactly like a Jira project key but never are. Scanning
 * bare tokens is what makes "PROJ-1532" work with no configuration; the cost
 * is that "UTF-8" and "SHA-256" match the same shape. A denylist is cruder
 * than requiring configured project keys and considerably more useful, since
 * nobody configures anything before their first index.
 */
const NOT_TRACKER_PREFIXES = new Set([
  "UTF", "ISO", "SHA", "RFC", "AES", "RSA", "HTTP", "HTTPS", "IPV", "CVE", "MD5",
  "UTC", "GMT", "API", "JSON", "HTML", "CSS", "SQL", "TLS", "SSL", "OAUTH",
  "BASE", "WIN", "MAC", "LATIN", "ES", "EC", "X", "PHP", "NODE", "PG", "V",
]);

/**
 * Extract issue references from a commit message.
 * @returns {Array<{tracker:string, key:string, url:string|null, relation:'FIXES'|'REFERENCES'}>}
 */
export function extractIssueRefs(message) {
  const found = new Map(); // "tracker:key" -> ref
  const add = (tracker, key, url, relation) => {
    const id = `${tracker}:${key}`;
    const existing = found.get(id);
    if (!existing) {
      found.set(id, { tracker, key, url: url || null, relation });
      return;
    }
    // A closing keyword anywhere wins over a bare mention, and any URL we saw
    // is better than none -- it is the only way to reach the real issue later.
    if (relation === "FIXES") existing.relation = "FIXES";
    if (!existing.url && url) existing.url = url;
  };

  for (const m of message.matchAll(CLOSING_RE)) {
    if (m[1]) add("github", m[1], null, "FIXES");
    else if (m[2]) add("github", m[2], null, "FIXES");
    else if (m[3]) add("jira", m[3], null, "FIXES");
  }
  for (const m of message.matchAll(GITHUB_URL_RE)) add("github", m[1], m[0], "REFERENCES");
  for (const m of message.matchAll(JIRA_URL_RE)) add("jira", m[1], m[0], "REFERENCES");
  for (const m of message.matchAll(HASH_REF_RE)) add("github", m[1], null, "REFERENCES");
  for (const m of message.matchAll(JIRA_KEY_RE)) {
    if (NOT_TRACKER_PREFIXES.has(m[1])) continue;
    add("jira", `${m[1]}-${m[2]}`, null, "REFERENCES");
  }
  return [...found.values()];
}

/** `Co-authored-by:` trailers, as {name, email}. */
export function extractCoAuthors(message) {
  const out = [];
  const seen = new Set();
  for (const m of message.matchAll(COAUTHOR_RE)) {
    const email = m[2].trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ name: m[1].trim() || email, email });
  }
  return out;
}

/** Stable identity for a contributor: the mailmap-resolved address. */
export function personKey({ name, email }) {
  const normalized = (email || "").trim().toLowerCase();
  return normalized || `name:${(name || "unknown").trim().toLowerCase()}`;
}

// --- log parsing -----------------------------------------------------------

/**
 * Parse one RS-delimited record into a commit.
 * @returns {object|null} null for the empty record before the first RS
 */
export function parseCommitRecord(record) {
  if (!record.trim()) return null;
  const split = record.indexOf(BODY_SEP);
  if (split === -1) return null;

  const fields = record.slice(0, split).split(FIELD_SEP);
  if (fields.length < 8) return null;
  const [sha, shortSha, authorName, authorEmail, authoredAt, committedAt, parents] = fields;
  const body = fields.slice(7).join(FIELD_SEP);

  const parentList = parents.trim() ? parents.trim().split(/\s+/) : [];
  const subject = body.split("\n", 1)[0].trim();
  const message = body.trim();

  const files = [];
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of record.slice(split + 1).split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [rawAdd, rawDel] = parts;
    const path = parts.slice(2).join("\t");
    const isBinary = rawAdd === "-" || rawDel === "-";
    const additions = isBinary ? 0 : Number(rawAdd) || 0;
    const removals = isBinary ? 0 : Number(rawDel) || 0;
    files.push({ path, additions, deletions: removals, isBinary });
    filesChanged++;
    insertions += additions;
    deletions += removals;
  }

  return {
    sha,
    shortSha,
    authorName: authorName || null,
    authorEmail: (authorEmail || "").toLowerCase() || null,
    authoredAt: authoredAt || null,
    committedAt: committedAt || null,
    parents: parentList,
    subject,
    body: message,
    isMerge: parentList.length > 1,
    isFix: FIX_SUBJECT_RE.test(subject),
    isRevert: REVERT_SUBJECT_RE.test(subject) || REVERT_BODY_RE.test(message),
    files,
    issues: extractIssueRefs(message),
    coAuthors: extractCoAuthors(message),
    filesChanged,
    insertions,
    deletions,
  };
}

/**
 * Split a stream of text chunks into commits as they arrive.
 * @param {AsyncIterable<string>} chunks
 */
export async function* streamCommits(chunks) {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let boundary = buffer.indexOf(RECORD_SEP);
    // The first RS opens the first record; everything before it is empty.
    if (boundary === -1) continue;
    let start = boundary + 1;
    while ((boundary = buffer.indexOf(RECORD_SEP, start)) !== -1) {
      const commit = parseCommitRecord(buffer.slice(start, boundary));
      if (commit) yield commit;
      start = boundary + 1;
    }
    buffer = RECORD_SEP + buffer.slice(start);
  }
  if (buffer.startsWith(RECORD_SEP)) {
    const commit = parseCommitRecord(buffer.slice(1));
    if (commit) yield commit;
  }
}

/** Parse a whole log dump at once. Test/eval convenience; ingestion streams. */
export async function parseGitLog(text) {
  const out = [];
  for await (const commit of streamCommits([text])) out.push(commit);
  return out;
}

// --- git plumbing ----------------------------------------------------------

async function tryGit(args) {
  try {
    const { stdout } = await execFileAsync("git", args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Decide what range of history still needs ingesting.
 * @returns {Promise<{toplevel:string, prefix:string, headSha:string, range:string[], full:boolean}|null>}
 */
async function resolveRange(root, lastHistorySha) {
  const toplevel = await tryGit(["-C", root, "rev-parse", "--show-toplevel"]);
  if (!toplevel) return null;
  const headSha = await tryGit(["-C", root, "rev-parse", "HEAD"]);
  if (!headSha) return null; // repo with no commits yet

  const prefix = (await tryGit(["-C", root, "rev-parse", "--show-prefix"])) || "";

  if (lastHistorySha) {
    // Same guard as gitDiff.js: if the stored sha is no longer an ancestor the
    // history was rewritten (rebase, squash, force-push) and an incremental
    // range would silently skip commits. Fall back to a bounded full pass.
    try {
      await execFileAsync("git", ["-C", root, "merge-base", "--is-ancestor", lastHistorySha, "HEAD"]);
      if (lastHistorySha === headSha) {
        return { toplevel, prefix, headSha, range: [], full: false, upToDate: true };
      }
      return { toplevel, prefix, headSha, range: [`${lastHistorySha}..HEAD`], full: false };
    } catch {
      /* fall through to a full pass */
    }
  }
  return { toplevel, prefix, headSha, range: ["HEAD"], full: true };
}

function logArgs({ toplevel, prefix, range, full }) {
  const args = [
    // Without this git escapes non-ASCII paths into C-style octal, so
    // "src/café.js" would never match the files row of the same name.
    "-c", "core.quotePath=false",
    "-C", toplevel,
    "log",
    `--pretty=format:${LOG_FORMAT}`,
    "--numstat",
    // Renames become a delete + an add. Tracking them properly needs the
    // "old => new" numstat form, and the parse plane already models moves via
    // symbol_aliases; the churn table is better off literal for now.
    "--no-renames",
    "--encoding=UTF-8",
    "--date-order",
    ...range,
  ];
  if (full) {
    // A first index of a decade-old monorepo should not spend minutes on
    // history nobody will ask about. Both bounds are configurable.
    if (config.historyWindowMonths > 0) args.push(`--since=${config.historyWindowMonths} months ago`);
    if (config.historyMaxCommits > 0) args.push(`-n`, String(config.historyMaxCommits));
  }
  if (prefix) args.push("--", prefix);
  return args;
}

function spawnGitLog(args) {
  const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git log exited ${code}: ${stderr.trim().slice(0, 400)}`))
    );
  });
  return { child, done };
}

// --- persistence -----------------------------------------------------------

/** Upsert entity rows and return natural_key -> id for the whole batch. */
async function upsertEntities(client, { orgId, projectId }, kind, rows, source = "git") {
  if (!rows.length) return new Map();
  const res = await client.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, summary, occurred_at, source, data)
     SELECT $1, $2, $3, u.k, u.title, u.summary, u.occurred, $4, u.data
       FROM unnest($5::text[], $6::text[], $7::text[], $8::timestamptz[], $9::jsonb[])
            AS u(k, title, summary, occurred, data)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title       = COALESCE(EXCLUDED.title, entities.title),
            summary     = COALESCE(EXCLUDED.summary, entities.summary),
            occurred_at = COALESCE(EXCLUDED.occurred_at, entities.occurred_at),
            data        = entities.data || EXCLUDED.data,
            deleted_at  = NULL,
            updated_at  = now()
     RETURNING id, natural_key`,
    [
      orgId, projectId, kind, source,
      rows.map((r) => r.key),
      rows.map((r) => r.title ?? null),
      rows.map((r) => r.summary ?? null),
      rows.map((r) => r.occurredAt ?? null),
      rows.map((r) => JSON.stringify(r.data ?? {})),
    ]
  );
  return new Map(res.rows.map((r) => [r.natural_key, Number(r.id)]));
}

async function insertLinks(client, orgId, links) {
  if (!links.length) return;
  await client.query(
    `INSERT INTO entity_links (org_id, src_id, dst_id, relation)
     SELECT $1, s, d, r FROM unnest($2::bigint[], $3::bigint[], $4::text[]) AS u(s, d, r)
     ON CONFLICT (src_id, relation, dst_id) DO NOTHING`,
    [orgId, links.map((l) => l[0]), links.map((l) => l[1]), links.map((l) => l[2])]
  );
}

/**
 * Turn one batch of parsed commits into rows.
 *
 * Everything is upsert-shaped so re-ingesting a range (a rewritten history, a
 * manual re-run) converges instead of duplicating. commit_count on `people` is
 * deliberately NOT accumulated here -- it is recomputed once at the end, which
 * is the only version that stays correct under re-ingestion.
 */
async function writeBatch(client, ctx, commits, prefix) {
  const { orgId, projectId } = ctx;

  // --- people ---
  const people = new Map();
  const notePerson = (person) => {
    const key = personKey(person);
    const existing = people.get(key);
    if (existing) {
      if (!existing.title && person.name) existing.title = person.name;
      return key;
    }
    people.set(key, { key, title: person.name || key, email: person.email || null });
    return key;
  };
  for (const c of commits) {
    notePerson({ name: c.authorName, email: c.authorEmail });
    for (const co of c.coAuthors) notePerson(co);
  }
  const personIds = await upsertEntities(client, ctx, "person", [...people.values()]);
  const personRows = [...people.values()].filter((r) => personIds.has(r.key));
  if (personRows.length) {
    const rows = personRows;
    await client.query(
      `INSERT INTO people (entity_id, project_id, display_name, canonical_email, emails)
       SELECT u.id, $1, u.name, u.email,
              CASE WHEN u.email IS NULL THEN '{}'::text[] ELSE ARRAY[u.email] END
         FROM unnest($2::bigint[], $3::text[], $4::text[]) AS u(id, name, email)
       ON CONFLICT (entity_id) DO UPDATE
          SET display_name = COALESCE(EXCLUDED.display_name, people.display_name),
              emails = ARRAY(SELECT DISTINCT e FROM unnest(people.emails || EXCLUDED.emails) e WHERE e IS NOT NULL)`,
      [
        projectId,
        rows.map((r) => personIds.get(r.key)),
        rows.map((r) => r.title),
        rows.map((r) => r.email),
      ]
    );
  }

  // --- commits ---
  const commitIds = await upsertEntities(
    client, ctx, "commit",
    commits.map((c) => ({
      key: c.sha,
      title: c.subject,
      summary: c.body.length > c.subject.length ? c.body : null,
      occurredAt: c.authoredAt,
      data: { short_sha: c.shortSha, is_fix: c.isFix, is_merge: c.isMerge },
    }))
  );

  await client.query(
    `INSERT INTO commits (entity_id, project_id, sha, short_sha, author_name, author_email,
                          author_person_id, authored_at, committed_at, subject, body,
                          parent_count, is_merge, is_fix, is_revert,
                          files_changed, insertions, deletions)
     SELECT u.* FROM unnest(
              $1::bigint[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[],
              $7::bigint[], $8::timestamptz[], $9::timestamptz[], $10::text[], $11::text[],
              $12::int[], $13::boolean[], $14::boolean[], $15::boolean[],
              $16::int[], $17::int[], $18::int[]
            ) AS u(entity_id, project_id, sha, short_sha, author_name, author_email,
                   author_person_id, authored_at, committed_at, subject, body,
                   parent_count, is_merge, is_fix, is_revert,
                   files_changed, insertions, deletions)
     -- Re-ingesting a range has to be able to CORRECT a row, not just leave
     -- it: the classifiers above get refined, and a commit already in the
     -- table would otherwise keep whatever verdict the old heuristic gave it.
     ON CONFLICT (entity_id) DO UPDATE
        SET subject = EXCLUDED.subject, body = EXCLUDED.body,
            author_person_id = EXCLUDED.author_person_id,
            is_merge = EXCLUDED.is_merge, is_fix = EXCLUDED.is_fix,
            is_revert = EXCLUDED.is_revert, parent_count = EXCLUDED.parent_count,
            files_changed = EXCLUDED.files_changed,
            insertions = EXCLUDED.insertions, deletions = EXCLUDED.deletions`,
    [
      commits.map((c) => commitIds.get(c.sha)),
      commits.map(() => projectId),
      commits.map((c) => c.sha),
      commits.map((c) => c.shortSha),
      commits.map((c) => c.authorName),
      commits.map((c) => c.authorEmail),
      commits.map((c) => personIds.get(personKey({ name: c.authorName, email: c.authorEmail })) ?? null),
      commits.map((c) => c.authoredAt),
      commits.map((c) => c.committedAt),
      commits.map((c) => c.subject),
      commits.map((c) => c.body),
      commits.map((c) => c.parents.length),
      commits.map((c) => c.isMerge),
      commits.map((c) => c.isFix),
      commits.map((c) => c.isRevert),
      commits.map((c) => c.filesChanged),
      commits.map((c) => c.insertions),
      commits.map((c) => c.deletions),
    ]
  );

  // --- per-file churn ---
  const churn = [];
  for (const c of commits) {
    const commitId = commitIds.get(c.sha);
    const seen = new Set();
    for (const f of c.files) {
      // git reports paths from the repo root; `files.path` and every query
      // downstream are relative to the indexed project root.
      if (prefix && !f.path.startsWith(prefix)) continue;
      const relPath = prefix ? f.path.slice(prefix.length) : f.path;
      if (!relPath || seen.has(relPath)) continue;
      seen.add(relPath);
      churn.push([commitId, relPath, f.additions, f.deletions, f.isBinary]);
    }
  }
  if (churn.length) {
    await client.query(
      `INSERT INTO commit_files (project_id, commit_entity_id, path, additions, deletions, is_binary)
       SELECT $1, c, p, a, d, b
         FROM unnest($2::bigint[], $3::text[], $4::int[], $5::int[], $6::boolean[]) AS u(c, p, a, d, b)
       ON CONFLICT (commit_entity_id, path) DO UPDATE
          SET additions = EXCLUDED.additions, deletions = EXCLUDED.deletions`,
      [
        projectId,
        churn.map((r) => r[0]), churn.map((r) => r[1]),
        churn.map((r) => r[2]), churn.map((r) => r[3]), churn.map((r) => r[4]),
      ]
    );
  }

  // --- issues ---
  //
  // The stub trick: an issue referenced by a commit gets an entity even though
  // no tracker is configured and nothing is known about it beyond its number.
  // That single decision is what makes "JWT timeout -> bug #1532, six months
  // ago" answerable on a laptop with no integrations at all; a real Jira or
  // GitHub connector later fills in title/state/labels on the same rows.
  const issueRows = new Map();
  for (const c of commits) {
    for (const ref of c.issues) {
      const key = `${ref.tracker}:${ref.key}`;
      const existing = issueRows.get(key);
      if (existing) { existing.url ??= ref.url; continue; }
      issueRows.set(key, { ...ref, key: ref.key, naturalKey: key });
    }
  }
  let issueIds = new Map();
  if (issueRows.size) {
    const rows = [...issueRows.values()];
    issueIds = await upsertEntities(
      client, ctx, "issue",
      rows.map((r) => ({
        key: r.naturalKey,
        title: null,
        data: { tracker: r.tracker, external_key: r.key, url: r.url },
      })),
      "inferred"
    );
    await client.query(
      `INSERT INTO issues (entity_id, project_id, tracker, external_key, url)
       SELECT u.id, $1, u.tracker, u.key, u.url
         FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[]) AS u(id, tracker, key, url)
       ON CONFLICT (entity_id) DO UPDATE SET url = COALESCE(EXCLUDED.url, issues.url)`,
      [
        projectId,
        rows.map((r) => issueIds.get(r.naturalKey)),
        rows.map((r) => r.tracker),
        rows.map((r) => r.key),
        rows.map((r) => r.url),
      ]
    );
  }

  // --- links ---
  const links = [];
  for (const c of commits) {
    const commitId = commitIds.get(c.sha);
    const authorId = personIds.get(personKey({ name: c.authorName, email: c.authorEmail }));
    if (authorId) links.push([commitId, authorId, "AUTHORED_BY"]);
    for (const co of c.coAuthors) {
      const coId = personIds.get(personKey(co));
      if (coId && coId !== authorId) links.push([commitId, coId, "CO_AUTHORED_BY"]);
    }
    for (const ref of c.issues) {
      const issueId = issueIds.get(`${ref.tracker}:${ref.key}`);
      if (issueId) links.push([commitId, issueId, ref.relation]);
    }
  }
  // Two references to the same issue from one commit collapse to one link;
  // ON CONFLICT would handle it, but not within a single INSERT statement.
  const deduped = [...new Map(links.map((l) => [l.join("|"), l])).values()];
  await insertLinks(client, orgId, deduped);

  return { people: people.size, issues: issueRows.size, churn: churn.length };
}

/** Recompute per-person aggregates from `commits`. Idempotent by construction. */
async function refreshPeopleStats(projectId) {
  await pool.query(
    `UPDATE people p
        SET commit_count  = agg.n,
            first_seen_at = agg.first_at,
            last_seen_at  = agg.last_at
       FROM (SELECT author_person_id AS pid, count(*)::int AS n,
                    min(authored_at) AS first_at, max(authored_at) AS last_at
               FROM commits
              WHERE project_id = $1 AND author_person_id IS NOT NULL
              GROUP BY 1) agg
      WHERE p.entity_id = agg.pid AND p.project_id = $1`,
    [projectId]
  );
}

/**
 * Ingest git history for an already-resolved project.
 *
 * Incremental via projects.last_history_sha, which advances only on a clean
 * run -- same rule as last_indexed_sha in indexer.js, for the same reason: a
 * half-ingested range that records itself as done is invisible data loss.
 *
 * @param {{id:number, org_id:number, last_history_sha:string|null}} project
 * @param {string} root absolute path to the indexed directory
 * @param {(msg:string)=>void} [log]
 */
export async function ingestGitHistory(project, root, log = () => {}) {
  const plan = await resolveRange(root, project.last_history_sha);
  if (!plan) return { mode: "skipped", reason: "not a git repository", commits: 0 };
  if (plan.upToDate) return { mode: "incremental", commits: 0, upToDate: true };

  const ctx = { orgId: project.org_id, projectId: project.id };
  const { child, done } = spawnGitLog(logArgs(plan));

  let total = 0;
  let batch = [];
  let failed = 0;
  const client = await pool.connect();

  const flush = async () => {
    if (!batch.length) return;
    try {
      await client.query("BEGIN");
      await writeBatch(client, ctx, batch, plan.prefix);
      await client.query("COMMIT");
      total += batch.length;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      failed += batch.length;
      log(`History batch failed (${batch.length} commits): ${e.message}`);
    }
    batch = [];
  };

  try {
    for await (const commit of streamCommits(child.stdout)) {
      batch.push(commit);
      if (batch.length >= BATCH_SIZE) {
        await flush();
        if (total % 2500 === 0) log(`Ingested ${total} commits…`);
      }
    }
    await flush();
    await done;
  } finally {
    client.release();
  }

  if (failed === 0) {
    await refreshPeopleStats(project.id);
    await pool.query(
      `UPDATE projects SET last_history_sha = $2, history_indexed_at = now() WHERE id = $1`,
      [project.id, plan.headSha]
    );
  } else {
    await pool.query(`UPDATE projects SET history_indexed_at = now() WHERE id = $1`, [project.id]);
  }

  return {
    mode: plan.full ? "full" : "incremental",
    commits: total,
    failed,
    headSha: plan.headSha,
  };
}
