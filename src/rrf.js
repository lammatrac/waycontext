export const DEFAULT_K = 60;

/**
 * Fuse multiple ranked lists of ids via Reciprocal Rank Fusion:
 * score(id) = sum, over every list containing id, of 1 / (k + rank).
 * @param {Record<string, Array<string|number>>} rankedLists - source name -> ids in best-first rank order
 * @param {number} k - RRF damping constant
 * @returns {Array<{id: string|number, score: number, sources: string[]}>} sorted by score desc
 */
export function fuseRankedLists(rankedLists, k = DEFAULT_K) {
  const byId = new Map();
  for (const [source, ids] of Object.entries(rankedLists)) {
    ids.forEach((id, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      const entry = byId.get(id) || { id, score: 0, sources: [] };
      entry.score += contribution;
      entry.sources.push(source);
      byId.set(id, entry);
    });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}
