import fs from "node:fs";

/**
 * Increment 1B UI recognition, phase 1B-2: read and parse one `block.json`
 * file -- REQ-024 (AC-016's "block.json declaring namespace
 * 'waycontext/pricing'").
 *
 * Pure I/O helper, no module-level state -- same "read fresh from disk on
 * every call, nothing cached or shared across projects/runs" discipline
 * src/ui/i18nCatalog.js's discoverCatalogs() already established for this
 * feature's other on-disk metadata source (contracts.md "Phase 1A-4"). Two
 * `index_project` runs for two different projects (or two runs of the same
 * project) never share state through this module.
 *
 * Deliberately separate from src/ui/phpBlocks.js, which stays pure/DB-free
 * like every sibling PHP extractor -- this is the one place in the whole
 * feature where a call site's *first argument* (a directory or block.json
 * path fragment, resolved by phpBlocks.js from syntax alone) turns into an
 * actual filesystem read of a *second* file. src/indexer.js is the caller:
 * it's the only place that knows both the registering file's own relative
 * path and the project root, so it's the only place that can turn a
 * resolved path fragment into an absolute path to read.
 */

/**
 * @param {string} absolutePath
 * @returns {{name: string, title: string|null, category: string|null,
 *            textdomain: string|null} | null}
 *   `null` on any failure -- file missing/unreadable, invalid JSON, or a
 *   missing/non-string `name` field (block.json's own declared namespace,
 *   e.g. "waycontext/pricing" -- REQ-024's identity key for the `block`
 *   entity downstream). A block.json this function can't make sense of
 *   produces no entity at all in src/indexer.js -- REQ-026/Q-018's
 *   no-fabrication rule, same as every other unresolvable input in this
 *   feature -- never a thrown error for the per-file try/catch to translate.
 */
export function readBlockManifest(absolutePath) {
  let raw;
  try {
    raw = fs.readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || typeof json.name !== "string" || !json.name) return null;
  return {
    name: json.name,
    title: typeof json.title === "string" ? json.title : null,
    category: typeof json.category === "string" ? json.category : null,
    textdomain: typeof json.textdomain === "string" ? json.textdomain : null,
  };
}
