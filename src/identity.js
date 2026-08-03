/**
 * Stable identity for parsed symbols.
 *
 * The parse plane is disposable -- indexer.js deletes and reinserts every
 * symbol of a changed file, so symbols.id is reassigned constantly. Durable
 * knowledge (a decision, an incident, an owner) has to hang off something that
 * survives that, which is what the symbol key and the entity behind it are for.
 *
 * The key is location + shape, NOT content:
 *
 *     src/graph.js#function:searchCode
 *     src/Invoice.php#method:App\Domain\Invoice::total
 *     src/util.js#function:helper~2      (second `helper` in the same file)
 *
 * A content hash was the obvious alternative and is exactly wrong: it changes
 * on every edit, which is precisely the moment the link has to hold. Location
 * changes far less often, and when it does change -- a rename or a move -- the
 * body usually doesn't, so the fingerprint below catches it and writes an alias
 * instead of orphaning the entity.
 */
import crypto from "node:crypto";

/**
 * Bodies shorter than this are not fingerprinted. Two one-line getters having
 * the same body is a coincidence, not evidence that one was renamed into the
 * other, and a wrong rename match silently transplants an entity's whole
 * history onto unrelated code.
 */
export const MIN_FINGERPRINT_CHARS = 64;

/** `path#kind:name` with a `~n` suffix for the nth duplicate within a file. */
export function symbolKey(filePath, kind, name, dup = 1) {
  return `${filePath}#${kind}:${name}${dup > 1 ? `~${dup}` : ""}`;
}

/**
 * sha256 of the whitespace-normalised body, or null when the body is too short
 * to be distinctive. Normalising means a pure reindent doesn't read as a
 * different symbol.
 *
 * The 0006 migration backfills this with the same normalisation in SQL.
 */
export function bodyFingerprint(body) {
  if (!body) return null;
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length < MIN_FINGERPRINT_CHARS) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Assign a key and fingerprint to every symbol parsed out of one file.
 *
 * Duplicate (kind, name) pairs are numbered in source order, so the numbering
 * matches the `row_number() OVER (... ORDER BY start_line, id)` the migration
 * uses to backfill pre-existing rows. Returned in the same order as the input,
 * because the caller inserts symbols and keys together.
 *
 * @param {string} filePath project-relative path
 * @param {Array<{name:string,kind:string,startLine:number,body:string}>} symbols
 * @returns {Array<{key:string, fingerprint:string|null}>}
 */
export function assignSymbolKeys(filePath, symbols) {
  const order = symbols
    .map((symbol, index) => ({ symbol, index }))
    .sort((a, b) => (a.symbol.startLine - b.symbol.startLine) || (a.index - b.index));

  const counts = new Map();
  const out = new Array(symbols.length);
  for (const { symbol, index } of order) {
    const bucket = `${symbol.kind}:${symbol.name}`;
    const dup = (counts.get(bucket) ?? 0) + 1;
    counts.set(bucket, dup);
    out[index] = {
      key: symbolKey(filePath, symbol.kind, symbol.name, dup),
      fingerprint: bodyFingerprint(symbol.body),
    };
  }
  return out;
}

/**
 * Pair keys that vanished this run against keys that appeared.
 *
 * Two rules, applied in order, each requiring the match to be unambiguous on
 * BOTH sides. Ambiguity is always resolved by declining to match: an unmatched
 * symbol costs one tombstone, whereas a wrong match silently transplants an
 * entity's entire accumulated history onto unrelated code.
 *
 *   1. identical body fingerprint -- the same code in a new place
 *   2. identical kind and name    -- the same declaration in a new place,
 *                                    even if its body was edited on the way
 *
 * Rule 2 exists because rule 1 alone misses most real moves. A file rename is
 * almost never *just* a rename; the import block changes, a call gets updated,
 * and the fingerprint no longer matches. Since keys are `path#kind:name`, a
 * kind+name pair that appears on both sides necessarily changed file, so rule
 * 2 only ever fires on genuine moves.
 *
 * What neither rule catches, deliberately: renaming an identifier in place.
 * The declaration is part of the body, so the fingerprint changes with it, and
 * the name changed by definition. That reads as delete + create, which is a
 * defensible thing for it to read as -- there is no evidence left tying the two
 * together that wouldn't also tie together two unrelated edits.
 *
 * Rows carry `path` explicitly rather than having it parsed back out of the
 * key: both a path and a symbol name may legally contain `#`, so splitting the
 * key is guesswork in a way that constructing it never is.
 *
 * @param {Array<{key:string, path:string, kind:string, name:string,
 *                fingerprint:string|null, entityId:number}>} disappeared
 * @param {Array<{key:string, path:string, kind:string, name:string,
 *                fingerprint:string|null}>} appeared
 * @returns {Array<{oldKey:string, newKey:string, oldPath:string, newPath:string,
 *                  entityId:number, reason:'move'|'rename'}>}
 */
export function matchRenames(disappeared, appeared) {
  const renames = [];
  const claimedOld = new Set();
  const claimedNew = new Set();

  const groupBy = (rows, keyOf, claimed) => {
    const groups = new Map();
    for (const row of rows) {
      if (claimed.has(row.key)) continue;
      const bucket = keyOf(row);
      if (bucket == null) continue;
      const existing = groups.get(bucket);
      if (existing) existing.push(row);
      else groups.set(bucket, [row]);
    }
    return groups;
  };

  const pass = (keyOf) => {
    const gone = groupBy(disappeared, keyOf, claimedOld);
    const fresh = groupBy(appeared, keyOf, claimedNew);
    for (const [bucket, oldRows] of gone) {
      const newRows = fresh.get(bucket);
      if (!newRows || oldRows.length !== 1 || newRows.length !== 1) continue;
      const [oldRow] = oldRows;
      const [newRow] = newRows;
      if (oldRow.key === newRow.key) continue;
      claimedOld.add(oldRow.key);
      claimedNew.add(newRow.key);
      renames.push({
        oldKey: oldRow.key,
        newKey: newRow.key,
        oldPath: oldRow.path,
        newPath: newRow.path,
        entityId: oldRow.entityId,
        reason: oldRow.path === newRow.path ? "rename" : "move",
      });
    }
  };

  pass((row) => row.fingerprint);
  pass((row) => (row.kind && row.name ? `${row.kind}:${row.name}` : null));
  return renames;
}
