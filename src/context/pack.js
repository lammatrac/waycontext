/**
 * Second-stage fusion and budget packing.
 *
 * Two decisions live here, and both are about what happens when there is more
 * relevant context than budget:
 *
 *   1. Channels are weighted, because "a symbol the vector index liked" and "a
 *      rule a maintainer confirmed" are not equally trustworthy signals.
 *   2. Rules are never truncated. Everything else competes for what's left.
 */
import { DEFAULT_K } from "../rrf.js";

/**
 * How much each channel's ranking counts. Not tuned against a benchmark -- there
 * isn't one for context assembly yet -- so these are stated as judgements rather
 * than dressed up as measurements: code the task matches directly ranks above
 * prose about it, which ranks above what similar work needed before.
 */
export const DEFAULT_WEIGHTS = {
  code: 1,
  doc: 0.8,
  memory: 0.7,
  history: 0.6,
  graph: 0.5,
};

/**
 * Weighted Reciprocal Rank Fusion over the channel lists.
 *
 * Deliberately a separate implementation from `fuseRankedLists` in src/rrf.js
 * rather than a generalisation of it: that function is on the retrieval path
 * that the eval harness measures, and adding a weights parameter to it would put
 * a Phase 5 concern inside the one function whose behaviour has to stay fixed
 * across phases to keep those numbers comparable.
 *
 * @param {Record<string, Array<{key:string}>>} lists channel -> items, best first
 * @param {Record<string, number>} weights
 * @param {number} k RRF damping
 * @returns {Array<{key:string, score:number, channels:string[], item:Object}>}
 */
export function fuseWeighted(lists, weights = DEFAULT_WEIGHTS, k = DEFAULT_K) {
  const byKey = new Map();
  for (const [channel, items] of Object.entries(lists)) {
    const weight = weights[channel] ?? 0;
    if (!weight) continue;
    items.forEach((item, index) => {
      const contribution = weight / (k + index + 1);
      const entry = byKey.get(item.key) ?? {
        key: item.key, score: 0, channels: [], item,
      };
      entry.score += contribution;
      if (!entry.channels.includes(channel)) entry.channels.push(channel);
      // An item found by two channels keeps the richer copy: the graph channel
      // knows a symbol's neighbours but has no snippet, and losing the snippet
      // because the graph happened to be merged second would be a downgrade.
      if (!entry.item.snippet && item.snippet) entry.item = { ...item, ...entry.item, snippet: item.snippet };
      byKey.set(item.key, entry);
    });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
}

/**
 * Rough token count. Deliberately rough: the real tokeniser depends on the model
 * the caller is packing for, and being wrong by 10% on a 6000-token budget is a
 * far smaller error than the cost of pulling a tokeniser dependency in and
 * pretending the count is exact.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function itemTokens(item) {
  return estimateTokens(item.title) + estimateTokens(item.snippet) + estimateTokens(item.ref) + 4;
}

/**
 * Fit items into a token budget.
 *
 * Rules go in first and are exempt from the budget check. That is the load-
 * bearing behaviour of this whole file: a rule is the one kind of context whose
 * absence actively causes harm -- an agent that never saw "never edit an applied
 * migration" will confidently edit one -- while a missing code snippet just
 * makes it search again. If rules alone exceed the budget the budget is
 * overspent and `over_budget` says so, rather than dropping them silently.
 *
 * @param {Array<{key:string,score:number,item:Object}>} fused
 * @param {Array} rules always included
 * @param {number} budget token target
 */
export function packBudget(fused, rules, budget) {
  const included = [];
  let tokens = 0;

  for (const rule of rules) {
    included.push({ ...rule, pinned: true });
    tokens += itemTokens(rule);
  }

  const dropped = [];
  for (const entry of fused) {
    const cost = itemTokens(entry.item);
    if (tokens + cost > budget) {
      dropped.push({ key: entry.key, type: entry.item.type, tokens: cost });
      continue;
    }
    included.push({ ...entry.item, score: Number(entry.score.toFixed(5)), channels: entry.channels });
    tokens += cost;
  }

  return {
    included,
    tokens,
    budget,
    // Named, not hidden: a caller that asked for 2000 tokens and got 2600 needs
    // to know why before it wonders where its prompt budget went.
    over_budget: tokens > budget,
    dropped_count: dropped.length,
    dropped: dropped.slice(0, 20),
  };
}
