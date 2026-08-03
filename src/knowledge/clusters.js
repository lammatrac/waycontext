/**
 * Bug clusters: what keeps breaking, grouped.
 *
 * Clustered over FIX COMMITS rather than issues, which is a deliberate
 * deviation from the roadmap and worth being explicit about. `issues` rows do
 * exist, but they are extracted from commit-message references (#123, PROJ-45)
 * and carry only a tracker, a key and a URL -- no title, no body, no labels --
 * because nothing here talks to a tracker yet. There is no issue text to embed
 * until a connector exists. Fix commit messages are the text this project
 * actually has, and they are what someone means by "what keeps breaking here?".
 *
 * No training step, per the roadmap: greedy cosine-threshold agglomeration,
 * labelled by the terms that distinguish a cluster from the rest of the corpus.
 */
import { pool, toVector } from "../db.js";
import { config } from "../config.js";
import { embed, embeddingsEnabled } from "../embeddings.js";

// Conventional-commit prefixes and the words every commit message contains.
// Without these, every cluster in a well-disciplined repo is labelled "fix".
const STOPWORDS = new Set([
  "fix", "fixes", "fixed", "fixing", "bug", "bugs", "issue", "issues",
  "feat", "chore", "refactor", "docs", "test", "tests", "revert", "merge",
  "the", "a", "an", "and", "or", "but", "not", "for", "with", "without",
  "from", "into", "onto", "when", "where", "while", "that", "this", "these",
  "those", "then", "than", "there", "here", "was", "were", "been", "being",
  "are", "is", "be", "it", "its", "in", "on", "at", "to", "of", "by", "as",
  "so", "if", "we", "our", "you", "your", "they", "their", "no", "do", "does",
  "did", "doesn", "don", "didn", "should", "would", "could", "can", "will",
  "add", "adds", "added", "make", "makes", "made", "use", "uses", "used",
  "now", "still", "only", "just", "also", "instead", "rather", "after",
  "before", "again", "one", "two", "all", "any", "some", "more", "most",
]);

/** Words worth clustering on: lowercase, >= 3 chars, not a stopword. */
export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Cosine similarity of two vectors. Not assumed to be pre-normalised: Voyage
 * returns unit vectors today, but a provider that doesn't would silently turn
 * this into a dot product and shift every threshold.
 */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Greedy leader clustering: walk the items once, join the most similar existing
 * cluster if it is within `threshold`, otherwise start a new one.
 *
 * O(n * k) rather than the O(n^2) of full agglomeration, no training step, and
 * -- because it walks the input in the order given -- deterministic. The caller
 * therefore owns the ordering, and orders by commit id so a re-derive produces
 * the same clusters.
 *
 * @param {number[][]} vectors
 * @param {number} threshold cosine similarity, 0..1
 * @returns {Array<{members:number[], similarities:number[]}>} indices into `vectors`
 */
export function greedyCluster(vectors, threshold = config.bugClusterThreshold) {
  const clusters = [];
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    let best = null, bestSim = -1;
    for (const c of clusters) {
      const sim = cosine(v, c.centroid);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best && bestSim >= threshold) {
      best.members.push(i);
      best.similarities.push(bestSim);
      // Running mean centroid: cheap, and it lets a cluster drift toward what
      // it actually contains instead of anchoring on whichever item came first.
      for (let d = 0; d < v.length; d++) {
        best.centroid[d] += (v[d] - best.centroid[d]) / best.members.length;
      }
    } else {
      clusters.push({ members: [i], similarities: [1], centroid: [...v] });
    }
  }
  return clusters.map(({ members, similarities }) => ({ members, similarities }));
}

/**
 * Label a cluster with the terms characteristic of it: common INSIDE the
 * cluster and rare OUTSIDE it.
 *
 * Plain TF-IDF is the obvious choice here and it is wrong, measurably. IDF is
 * maximised by a term appearing in exactly one document, so for a two-commit
 * cluster about idempotency, the words appearing in only one of them
 * ("missing", "replay") outscore the word both of them share -- and the label
 * ends up naming the thing the cluster is NOT about. What is wanted is the
 * in-cluster share of a term weighted by how much more common it is inside than
 * out, which is what this computes.
 *
 * @param {string[][]} corpusTokens tokens per document, whole corpus
 * @param {number[]} members indices belonging to this cluster
 * @param {number} take how many terms
 */
export function topTerms(corpusTokens, members, take = 3) {
  const inside = new Set(members);
  const insideCount = members.length || 1;
  const outsideCount = corpusTokens.length - members.length;

  const inDocs = new Map();
  const outDocs = new Map();
  for (let i = 0; i < corpusTokens.length; i++) {
    const target = inside.has(i) ? inDocs : outDocs;
    for (const t of new Set(corpusTokens[i])) target.set(t, (target.get(t) ?? 0) + 1);
  }

  // Smoothing, so "appears nowhere outside" is a strong signal rather than a
  // division by zero, and so a one-document corpus behaves.
  const eps = 1 / (corpusTokens.length + 1);
  const scored = [...inDocs].map(([term, n]) => {
    const inShare = n / insideCount;
    const outShare = outsideCount > 0 ? (outDocs.get(term) ?? 0) / outsideCount : 0;
    return { term, score: inShare * Math.log((inShare + eps) / (outShare + eps)) };
  });
  // Ties broken alphabetically so a label is stable across recomputes.
  scored.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1));
  return scored.filter((s) => s.score > 0).slice(0, take).map((s) => s.term);
}

/**
 * Document frequency of every term in a corpus. Shared by labelling (which
 * wants rare terms) and bucketing (which wants common ones).
 */
export function documentFrequencies(corpusTokens) {
  const docFreq = new Map();
  for (const tokens of corpusTokens) {
    for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  return docFreq;
}

/**
 * The term to bucket a document under: the one it shares with the most other
 * documents.
 *
 * Deliberately the opposite of `topTerms`. TF-IDF is right for labelling a
 * cluster -- you want the words that distinguish it -- but using it to CHOOSE a
 * bucket splits exactly the documents that belong together, because the term a
 * commit shares with another commit is by definition less rare than the term
 * unique to it. Two fixes both about idempotency would each be bucketed under
 * their own unique word and never meet.
 *
 * @param {string[][]} corpusTokens
 * @param {number} i index of the document to bucket
 * @param {Map<string,number>} docFreq from documentFrequencies()
 */
export function bucketTerm(corpusTokens, i, docFreq) {
  let best = null, bestDf = 0;
  for (const t of new Set(corpusTokens[i])) {
    const df = docFreq.get(t) ?? 0;
    // Alphabetical tie-break, so the bucket a commit lands in doesn't depend on
    // token order and a re-derive reproduces it.
    if (df > bestDf || (df === bestDf && best !== null && t < best)) {
      bestDf = df; best = t;
    }
  }
  return best;
}

/** pgvector hands back its text form, "[0.1,0.2,...]". */
function parseVector(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Fill `commits.message_embedding` for fix commits that don't have one, on the
 * same embed-on-NULL terms as chunks: only is_fix, only NULL, so a re-derive
 * costs nothing and an interrupted run heals on the next one.
 */
async function embedFixCommits(project, log) {
  const pending = await pool.query(
    `SELECT entity_id, subject, body FROM commits
      WHERE project_id = $1 AND is_fix AND message_embedding IS NULL`,
    [project.id]
  );
  if (!pending.rows.length) return 0;

  log(`Embedding ${pending.rows.length} fix commit message(s)…`);
  let done = 0;
  const BATCH = 32;
  for (let i = 0; i < pending.rows.length; i += BATCH) {
    const batch = pending.rows.slice(i, i + BATCH);
    let vectors;
    try {
      vectors = await embed(
        batch.map((r) => [r.subject ?? "", r.body ?? ""].join("\n").slice(0, 4000)),
        "document",
        project.id
      );
    } catch (e) {
      // Same contract as symbol and chunk embedding: leave these NULL and let
      // the next run pick them up, rather than losing the batches already done.
      log(`Fix-commit embedding batch failed (${batch.length}): ${e.message}`);
      continue;
    }
    for (let j = 0; j < vectors.length; j++) {
      if (!vectors[j]) continue;
      await pool.query(`UPDATE commits SET message_embedding = $1 WHERE entity_id = $2`, [
        toVector(vectors[j]), batch[j].entity_id,
      ]);
      done++;
    }
  }
  return done;
}

/** commit entity id -> the module most of its files live in. One query. */
async function dominantModules(project, commitIds) {
  if (!commitIds.length) return new Map();
  const res = await pool.query(
    `SELECT commit_entity_id, module_id FROM (
       SELECT cf.commit_entity_id, mm.module_id, count(*) AS c,
              row_number() OVER (
                PARTITION BY cf.commit_entity_id ORDER BY count(*) DESC, mm.module_id
              ) AS rn
         FROM commit_files cf
         JOIN files f ON f.project_id = $1 AND f.path = cf.path
         JOIN module_members mm ON mm.file_id = f.id
        WHERE cf.commit_entity_id = ANY($2::bigint[])
        GROUP BY 1, 2
     ) t WHERE rn = 1`,
    [project.id, commitIds]
  );
  return new Map(res.rows.map((r) => [String(r.commit_entity_id), Number(r.module_id)]));
}

/** The module most of a cluster's commits touch, by simple majority. */
function modalModule(members, commits, moduleByCommit) {
  const counts = new Map();
  for (const i of members) {
    const m = moduleByCommit.get(String(commits[i].entity_id));
    if (m == null) continue;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [m, c] of counts) if (c > bestCount) { bestCount = c; best = m; }
  return best;
}

/**
 * Recompute `bug_clusters` and `bug_cluster_members` for a project.
 *
 * With embeddings on, clusters are semantic. With embeddings off they are
 * grouped by (dominant module, most distinctive term) instead -- a real
 * degradation, not a silent one: `method` is stored per cluster so a UI can
 * never present a terms-only cluster as a semantic one.
 */
export async function writeBugClusters(project, log = () => {}) {
  let embedded = 0;
  if (embeddingsEnabled()) embedded = await embedFixCommits(project, log);

  // Ordered by entity_id, because greedyCluster is order-dependent and a
  // re-derive must produce the same clusters as the last one.
  const fixes = await pool.query(
    `SELECT entity_id, subject, body, authored_at, message_embedding::text AS vec
       FROM commits
      WHERE project_id = $1 AND is_fix
      ORDER BY entity_id`,
    [project.id]
  );
  const commits = fixes.rows;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Replaced wholesale: cluster ids carry no durable meaning (nothing links
    // to them) and a stable-id scheme for a set that reshapes on every new
    // commit would be a fiction.
    await client.query(`DELETE FROM bug_clusters WHERE project_id = $1`, [project.id]);

    if (!commits.length) {
      await client.query("COMMIT");
      return { clusters: 0, members: 0, embedded, method: null };
    }

    const corpusTokens = commits.map((c) => tokenize(`${c.subject ?? ""} ${c.body ?? ""}`));
    const moduleByCommit = await dominantModules(project, commits.map((c) => c.entity_id));

    const vectors = commits.map((c) => parseVector(c.vec));
    const haveAllVectors = vectors.every((v) => Array.isArray(v) && v.length);
    let method, groups;

    // Keyed on whether the vectors are actually there, not on whether the
    // provider is currently switched on. Someone who sets EMBEDDING_PROVIDER=none
    // on a database full of embeddings should not silently drop to keyword
    // buckets while semantic vectors sit unused in the column.
    if (haveAllVectors) {
      method = "embedding";
      groups = greedyCluster(vectors, config.bugClusterThreshold);
    } else {
      method = "terms";
      // (module, most-shared term) buckets. Weaker than semantic clustering, but
      // it still answers "several fixes in the same place about the same thing".
      const docFreq = documentFrequencies(corpusTokens);
      const buckets = new Map();
      for (let i = 0; i < commits.length; i++) {
        const term = bucketTerm(corpusTokens, i, docFreq) ?? "unlabelled";
        const key = `${moduleByCommit.get(String(commits[i].entity_id)) ?? "-"}:${term}`;
        if (!buckets.has(key)) buckets.set(key, { members: [], similarities: [] });
        const b = buckets.get(key);
        b.members.push(i);
        b.similarities.push(null);
      }
      groups = [...buckets.values()];
    }

    const kept = groups.filter((g) => g.members.length >= config.bugClusterMinSize);
    let members = 0;
    for (const g of kept) {
      const terms = topTerms(corpusTokens, g.members, 3);
      const dates = g.members
        .map((i) => commits[i].authored_at)
        .filter(Boolean)
        .sort((a, b) => new Date(a) - new Date(b));
      const ins = await client.query(
        `INSERT INTO bug_clusters
           (org_id, project_id, label, terms, size, module_id, method, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          project.org_id, project.id,
          terms.length ? terms.join(", ") : "unlabelled",
          terms, g.members.length,
          modalModule(g.members, commits, moduleByCommit),
          method, dates[0] ?? null, dates[dates.length - 1] ?? null,
        ]
      );
      const clusterId = ins.rows[0].id;
      const res = await client.query(
        `INSERT INTO bug_cluster_members (cluster_id, commit_entity_id, similarity)
         SELECT $1, u.cid, u.sim
           FROM unnest($2::bigint[], $3::real[]) AS u(cid, sim)
         ON CONFLICT DO NOTHING`,
        [
          clusterId,
          g.members.map((i) => commits[i].entity_id),
          g.members.map((_, k) => g.similarities[k]),
        ]
      );
      members += res.rowCount;
    }
    await client.query("COMMIT");

    const dropped = groups.length - kept.length;
    if (dropped) {
      log(`Bug clusters: ${dropped} group(s) below BUG_CLUSTER_MIN_SIZE=${config.bugClusterMinSize} not stored`);
    }
    return { clusters: kept.length, members, embedded, method };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
