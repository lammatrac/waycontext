/**
 * The context composer: one function, three surfaces.
 *
 * Given a task description in plain language, assemble everything worth putting
 * in front of an agent before it starts -- the rules that govern the code it is
 * about to touch, the code and prose that match the task, what was fixed there
 * before, what this project has learned -- with a citation on every claim and a
 * token budget that rules survive.
 *
 * Exposed as `compose_context` over MCP, `waycontext context` on the CLI and
 * `POST /v1/context` over HTTP. All three call this.
 */
import { getProject } from "../db.js";
import { embedQuery, embeddingsEnabled } from "../embeddings.js";
import { parseTask, resolveHints } from "./parse.js";
import { runChannels, withDeadline, DEFAULT_DEADLINE_MS } from "./channels.js";
import { fuseWeighted, packBudget, DEFAULT_WEIGHTS, estimateTokens } from "./pack.js";

export const DEFAULT_BUDGET_TOKENS = 6000;

/**
 * The query embedding gets its own, much longer deadline than the channels.
 *
 * Measured, not guessed: with one 400 ms deadline for everything, the two
 * channels that need a vector (code/docs and memory) BOTH timed out on every
 * cold request against Voyage, so the composer degraded to full-text on exactly
 * the queries where semantic matching matters. The provider round trip is a
 * network call and simply does not fit in a budget meant for Postgres.
 *
 * Warming it once up front means: one API call per request instead of two (the
 * cache in embeddings.js is single-flight), and channels whose deadline governs
 * database time only. That is what makes the sub-500 ms target real for a warm
 * cache rather than aspirational.
 */
export const DEFAULT_EMBED_DEADLINE_MS = 2000;

/**
 * @param {string} projectName
 * @param {string} task free-form description of what is about to be done
 * @param {{budget?:number, format?:'json'|'markdown', deadlineMs?:number,
 *          limit?:number, snippets?:boolean}} opts
 */
export async function composeContext(projectName, task, opts = {}) {
  const started = Date.now();
  if (!task || !String(task).trim()) throw new Error("A task description is required");

  const project = await getProject(projectName);
  if (!project) throw new Error(`Project "${projectName}" not found. Run index_project first.`);

  const budget = opts.budget ?? DEFAULT_BUDGET_TOKENS;
  const parsed = parseTask(task);

  // Hint resolution and the query embedding are independent, and the embedding
  // is the long pole, so they overlap rather than queue.
  const [hints, warm] = await Promise.all([
    resolveHints(project, parsed),
    embeddingsEnabled()
      ? withDeadline(
          embedQuery(task, project.id),
          opts.embedDeadlineMs ?? DEFAULT_EMBED_DEADLINE_MS,
          "query_embedding"
        )
      : Promise.resolve({ name: "query_embedding", timedOut: false, value: null }),
  ]);

  const { lists, degraded, errors } = await runChannels(projectName, task, hints, {
    limit: opts.limit ?? 8,
    deadlineMs: opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
  });

  // A slow or failed provider is reported, not hidden: the channels still ran,
  // but on full-text alone, and the caller should know the ranking is weaker.
  if (warm.timedOut) degraded.unshift("query_embedding (deadline)");
  else if (warm.error) degraded.unshift("query_embedding (error)");

  // Rules bypass fusion entirely rather than competing in it. Ranking a
  // confirmed constraint against a search hit would mean a sufficiently good
  // search hit could push it out, and that is precisely the outcome the
  // human-confirmation gate exists to prevent.
  const rules = lists.rules ?? [];
  const fused = fuseWeighted(
    {
      code: lists.code, doc: lists.doc, memory: lists.memory,
      history: lists.history, graph: lists.graph,
    },
    DEFAULT_WEIGHTS
  );

  const packed = packBudget(fused, rules, budget);

  // `snippet: null` is a supported answer, not a bug: it is what makes a privacy
  // tier possible later, where paths, names and citations sync but bodies never
  // leave the machine. Asking for it here exercises that path today.
  const items = opts.snippets === false
    ? packed.included.map((i) => ({ ...i, snippet: null }))
    : packed.included;

  const result = {
    project: project.name,
    task,
    understood: {
      paths: hints.paths,
      symbols: hints.symbols.map((s) => `${s.name} (${s.path})`),
      terms: parsed.terms.slice(0, 12),
      // Worth saying out loud: "you mentioned src/billing, which this project
      // does not have" is often the most useful line in the response.
      unresolved: hints.unresolved,
    },
    context: items,
    meta: {
      budget_tokens: budget,
      used_tokens: opts.snippets === false
        ? items.reduce((n, i) => n + estimateTokens(i.title) + estimateTokens(i.ref) + 4, 0)
        : packed.tokens,
      over_budget: packed.over_budget,
      dropped_count: packed.dropped_count,
      rules_included: rules.length,
      candidates_considered: fused.length,
      degraded_channels: degraded,
      channel_errors: errors,
      elapsed_ms: Date.now() - started,
    },
  };

  return opts.format === "markdown" ? toMarkdown(result) : result;
}

const SECTION_ORDER = [
  ["rule", "Rules you must follow"],
  ["code", "Relevant code"],
  ["graph", "Connected code"],
  ["doc", "Documentation & decisions"],
  ["memory", "What this project has learned"],
  ["commit", "What was fixed here before"],
];

/** Paste-ready markdown. The same data, for a human or a prompt. */
export function toMarkdown(result) {
  const lines = [`# Context for: ${result.task}`, ""];
  const { paths, symbols, unresolved } = result.understood;
  if (paths.length || symbols.length) {
    lines.push(
      "**Understood as** " +
      [symbols.length ? `symbols ${symbols.join(", ")}` : null,
       paths.length ? `paths ${paths.join(", ")}` : null].filter(Boolean).join("; "),
      ""
    );
  }
  if (unresolved.paths.length || unresolved.identifiers.length) {
    lines.push(
      "**Not found in this project:** " +
      [...unresolved.paths, ...unresolved.identifiers].join(", "),
      ""
    );
  }

  for (const [type, heading] of SECTION_ORDER) {
    const group = result.context.filter((i) => i.type === type);
    if (!group.length) continue;
    lines.push(`## ${heading}`, "");
    for (const i of group) {
      const cite = i.ref ? ` — \`${i.ref}\`` : "";
      lines.push(`- **${i.title}**${cite}`);
      if (i.snippet) {
        lines.push("", "  ```", ...i.snippet.split("\n").map((l) => `  ${l}`), "  ```");
      }
    }
    lines.push("");
  }

  const m = result.meta;
  const notes = [`${m.used_tokens}/${m.budget_tokens} tokens`, `${m.elapsed_ms} ms`];
  if (m.dropped_count) notes.push(`${m.dropped_count} lower-ranked items dropped`);
  if (m.degraded_channels.length) notes.push(`degraded: ${m.degraded_channels.join(", ")}`);
  lines.push(`_${notes.join(" · ")}_`);
  return lines.join("\n");
}
