/**
 * The single source of truth for every capability WayContext exposes.
 *
 * Each operation is declared once -- name, description, input schema, handler,
 * and how it maps onto a CLI invocation -- and every surface consumes this
 * list rather than restating it:
 *
 *   src/server.js  registers each entry as an MCP tool
 *   src/cli.js     dispatches each entry as a subcommand
 *   (later)        HTTP routes, the VSCode extension and the SDK do the same
 *
 * Before this existed, the MCP server and the CLI each hand-wrote their own
 * argument handling for the same functions, and they had already drifted: the
 * CLI silently accepted `limit 9999` and `depth 99` because the zod ranges
 * only ran on the MCP side, and the two carried independent copies of the
 * defaults. Adding a surface meant writing that layer a third time.
 *
 * Numeric fields use z.coerce.number() so one schema serves both callers:
 * MCP passes a real number, the CLI passes argv strings.
 *
 * Handlers take (args, ctx). ctx carries the request-scoped bits -- today just
 * a log sink; later the db handle, org id and principal that multi-tenancy and
 * the hosted API need.
 */
import { z } from "zod";
import { listProjects } from "./db.js";
import { indexProject } from "./indexer.js";
import {
  searchCode, searchKnowledge, getSymbol, getCallers, getCallees,
  getSubgraph, getFileOutline, getProjectOverview, findRelated,
} from "./graph.js";
import { getHistory, whoOwns } from "./knowledge/history.js";
import { getRules } from "./knowledge/rules.js";
import { remember, recall } from "./knowledge/memory.js";
import { reviewContext } from "./knowledge/reviewContext.js";
import {
  getModules, getModule, getCochange, getBugClusters,
} from "./knowledge/architecture.js";
import { composeContext } from "./context/compose.js";
import { createReasoningGraph, updateReasoningGraph } from "./reasoning/store.js";

const project = z.string().describe("Indexed project name (see list_projects)");
const limit = z.coerce.number().int().min(1).max(30).default(10);
// get_symbol's rows carry a full source body, not a one-line summary, so its
// cap stays lower than the generic result-list limit above.
const symbolLimit = z.coerce.number().int().min(1).max(10).default(5);

export const operations = [
  {
    name: "index_project",
    readOnly: false,
    description:
      "Scan and index a project directory: extracts all functions/classes/methods, builds a relationship graph (calls, imports, inheritance, WordPress hooks) and vector embeddings. Incremental: unchanged files are skipped. Run this first, and re-run after code changes.",
    input: {
      project: z.string().describe("Short project name, e.g. 'sports-wc-2026'"),
      path: z.string().describe("Absolute path to the project root on this machine"),
    },
    cli: {
      args: ["project", "path"],
      aliases: ["index", "reindex"],
      // Names the last positional as fillable from the repo the CLI was run
      // in, so `waycontext index` inside an initialized checkout needs no
      // arguments at all. Declared here rather than special-cased in cli.js,
      // which knows nothing about any individual command. The MCP schema keeps
      // `path` required -- an MCP client has no working directory.
      rootDefault: "path",
      label: (a) => `Indexing "${a.project}"`,
      // Its own log() output only fires at a handful of milestones (git diff,
      // file count, edge resolution, embeddings); the file-by-file work in
      // between is silent, which reads as "stuck" on a large project.
      streams: true,
      ensureSchema: true,
    },
    handler: (a, ctx) => indexProject(a.project, a.path, ctx.log),
  },
  {
    name: "list_projects",
    readOnly: true,
    description: "List all indexed projects with file/symbol/edge counts.",
    input: {},
    cli: { args: [], label: () => "Listing projects" },
    handler: () => listProjects(),
  },
  {
    name: "project_overview",
    readOnly: true,
    description:
      "High-level map of a project: languages, directory sizes, most-referenced symbols (architecture hubs), and WordPress hooks in use. Best first call for understanding an unfamiliar codebase.",
    input: { project },
    cli: { args: ["project"], label: (a) => `Building overview for "${a.project}"` },
    handler: (a) => getProjectOverview(a.project),
  },
  {
    name: "search_code",
    readOnly: true,
    description:
      "Find code by describing what it does. Give a feature or behaviour in plain language (e.g. 'purge cache after match status update') and get the functions/classes that implement it, ranked. Prefer this over grep as the first move on an indexed project: it matches on meaning, so it finds the right symbol when the query shares no words with the code — which is the usual case when you are describing a behaviour rather than recalling an identifier. Reach for grep instead when you know the literal string you want. Mechanically: Postgres full-text ranking fused with pgvector semantic similarity (when embeddings are enabled) via Reciprocal Rank Fusion; each `score` is a relative RRF rank, not a cosine similarity or probability.",
    input: {
      project,
      query: z.string().describe("Natural-language description of what you're looking for"),
      limit,
    },
    cli: { args: ["project", "query", "limit"], aliases: ["search"], label: (a) => `Searching "${a.query}"` },
    handler: (a) => searchCode(a.project, a.query, a.limit),
  },
  {
    name: "search_knowledge",
    readOnly: true,
    description:
      "Search code and project documentation together — symbols, READMEs, guides and ADRs — in one fused ranking. Use this for 'why is it this way' questions, where the answer is usually prose (a decision record, a guide) rather than a function body: each result is tagged `type: \"code\"` or `type: \"doc\"`, and doc hits carry the heading path they came from. Use `search_code` when you want the implementation itself.",
    input: {
      project,
      query: z.string().describe("Natural-language question or description"),
      limit,
    },
    cli: {
      args: ["project", "query", "limit"],
      aliases: ["knowledge"],
      label: (a) => `Searching knowledge for "${a.query}"`,
    },
    handler: (a) => searchKnowledge(a.project, a.query, a.limit),
  },
  {
    name: "get_symbol",
    readOnly: true,
    description:
      "Read one symbol's actual source, by name — function, class or method. Accepts 'Class::method' or a bare method name, so you do not need its file path first; use this rather than locating the file and reading it when you already know what the thing is called. Returns signature, docblock, file location and source body for the best match; a bare name that is ambiguous across classes returns additional candidates as stubs (no body) — re-call with 'Class::method' to read one of those.",
    input: { project, name: z.string(), limit: symbolLimit },
    cli: { args: ["project", "name", "limit"], label: (a) => `Fetching "${a.name}"` },
    handler: (a) => getSymbol(a.project, a.name, a.limit),
  },
  {
    name: "get_callers",
    readOnly: true,
    description:
      "What references this — the blast radius. Returns inbound edges (CALLS, INSTANTIATES, EXTENDS, hook registrations), capped at `limit`. Call it before changing or deleting any function: these are resolved graph edges, so it catches subclass and hook callers that a text search for the name would miss. A widely-used symbol can have thousands of callers; raise `limit` only when you actually need to enumerate them.",
    input: { project, name: z.string(), limit },
    cli: { args: ["project", "name", "limit"], label: (a) => `Finding callers of "${a.name}"` },
    handler: (a) => getCallers(a.project, a.name, a.limit),
  },
  {
    name: "get_callees",
    readOnly: true,
    description:
      "What does this symbol call / depend on? Returns outbound edges including WordPress hooks it registers or fires, capped at `limit`. These are resolved graph edges, so unlike reading the body you also get calls made through inherited methods and hook indirection.",
    input: { project, name: z.string(), limit },
    cli: { args: ["project", "name", "limit"], label: (a) => `Finding callees of "${a.name}"` },
    handler: (a) => getCallees(a.project, a.name, a.limit),
  },
  {
    name: "get_graph",
    readOnly: true,
    description:
      "See how a feature is wired together: the dependency subgraph around a symbol, BFS in both directions up to `depth` hops, as nodes + labeled edges. Use it when 'who calls this' (get_callers) is one hop short of the answer and you need the shape of the neighbourhood — there is no way to get this by reading files one at a time.",
    input: { project, name: z.string(), depth: z.coerce.number().int().min(1).max(4).default(2) },
    cli: { args: ["project", "name", "depth"], label: (a) => `Building graph around "${a.name}"` },
    handler: (a) => getSubgraph(a.project, a.name, a.depth),
  },
  {
    name: "get_file_outline",
    readOnly: true,
    description:
      "See what is in a file without reading it: symbols defined there, in line order, with signatures and docblocks, capped at `limit`. Cheaper than reading the whole file when you need to find your way to the right function in it. Raise `limit` for a file with more symbols than that — most files have far fewer.",
    input: { project, path: z.string().describe("File path relative to project root"), limit },
    cli: { args: ["project", "path", "limit"], label: (a) => `Outlining "${a.path}"` },
    handler: (a) => getFileOutline(a.project, a.path, a.limit),
  },
  {
    name: "find_related",
    readOnly: true,
    description:
      "Find the rest of a feature: symbols semantically similar to one you already have. Use it after search_code or get_symbol to sweep up the code that belongs to the same feature but is named differently and shares no call edge — the pieces a grep on the first symbol's name would never surface. Requires embeddings.",
    input: { project, name: z.string(), limit },
    cli: { args: ["project", "name", "limit"], label: (a) => `Finding symbols related to "${a.name}"` },
    handler: (a) => findRelated(a.project, a.name, a.limit),
  },
  {
    name: "get_history",
    readOnly: true,
    description:
      "Why is this code the way it is? Returns the commits that touched a file, symbol or directory — newest first — with author, date, whether it was a fix or a revert, and any issue/ticket numbers referenced in the message. Answers 'what broke last time someone touched this' and 'which ticket introduced this behaviour'. Omit `target` for recent project-wide history. Symbols keep their history across renames and file moves.",
    input: {
      project,
      target: z
        .string()
        .optional()
        .describe("File path relative to the project root, a symbol name, or a directory. Omit for the whole project."),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    },
    cli: {
      args: ["project", "target", "limit"],
      aliases: ["history"],
      label: (a) => (a.target ? `Reading history of "${a.target}"` : "Reading project history"),
    },
    handler: (a) => getHistory(a.project, a.target, a.limit),
  },
  {
    name: "who_owns",
    readOnly: true,
    description:
      "Who should you ask about this code? Ranks contributors to a file, symbol or directory by recency-weighted authorship, so the answer is whoever still has it in their head rather than whoever wrote the most lines in 2019. Returns commit counts, how many of those were fixes, first/last touch and their most recent change. Omit `target` to rank contributors across the whole project.",
    input: {
      project,
      target: z
        .string()
        .optional()
        .describe("File path relative to the project root, a symbol name, or a directory. Omit for the whole project."),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    },
    cli: {
      args: ["project", "target", "limit"],
      aliases: ["owners"],
      label: (a) => (a.target ? `Finding owners of "${a.target}"` : "Ranking project contributors"),
    },
    handler: (a) => whoOwns(a.project, a.target, a.limit),
  },
  {
    name: "get_rules",
    readOnly: true,
    description:
      "Project rules that apply to a file, symbol or directory — the conventions and constraints a human has confirmed, most severe first. Only confirmed rules are returned: heuristically extracted candidates are not, so anything you get here is something a maintainer stood behind. Omit `target` for project-wide rules.",
    input: {
      project,
      target: z.string().optional().describe("File path, symbol name or directory"),
    },
    cli: {
      args: ["project", "target"],
      aliases: ["rules"],
      label: (a) => (a.target ? `Rules for "${a.target}"` : "Project rules"),
    },
    handler: (a) => getRules(a.project, a.target),
  },
  {
    name: "remember",
    readOnly: false,
    description:
      "Record something learned about this project so it outlives this session — a gotcha, a fix that worked, a convention, a postmortem note. Use it when you discover something non-obvious that the next reader would otherwise waste time rediscovering. Pass `supersedes` with an earlier memory's key when you learn that memory was wrong. This records an observation, not a rule: rules require human confirmation.",
    input: {
      project,
      content: z.string().describe("What you learned, in a sentence or two"),
      kind: z.enum(["fix", "gotcha", "convention", "postmortem"]).default("gotcha"),
      scope: z.string().optional().describe("Glob or path this applies to, e.g. src/payments/**"),
      supersedes: z.string().optional().describe("Key of the memory this corrects"),
      pinned: z.coerce.boolean().default(false),
    },
    cli: {
      args: ["project", "content", "kind", "scope", "supersedes", "pinned"],
      label: () => "Recording memory",
    },
    handler: (a) => remember(a.project, a),
  },
  {
    name: "recall",
    readOnly: true,
    description:
      "Search this project's engineering memory — gotchas, fixes, conventions and postmortems recorded earlier. Ask before debugging something that smells like it has been hit before. Pinned memories always come first; memories that were later corrected are hidden.",
    input: { project, query: z.string(), limit },
    cli: { args: ["project", "query", "limit"], label: (a) => `Recalling "${a.query}"` },
    handler: (a) => recall(a.project, a.query, a.limit),
  },
  {
    name: "review_context",
    readOnly: true,
    description:
      "Everything worth knowing before reviewing or continuing a change: the confirmed rules governing the changed paths, memories scoped to them, and what was last fixed there. Defaults to the working tree's uncommitted changes — including untracked files — so it answers 'what should I know about what I'm about to commit'. Pass `paths` (comma-separated) to ask about specific files instead.",
    input: {
      project,
      paths: z.string().optional().describe("Comma-separated paths; omit for the working-tree diff"),
    },
    cli: { args: ["project", "paths"], aliases: ["review"], label: () => "Assembling review context" },
    handler: (a) => reviewContext(a.project, a.paths),
  },
  {
    name: "get_modules",
    readOnly: true,
    description:
      "The project's architecture as modules (directories) with churn, defect density and a risk score, most at-risk first. Start here when you don't know a codebase: it answers 'what are the parts, which are hot, and which have been breaking'. Check `risk_basis` — 'churn_only' means the project has no recognisable fix commits, so risk is ranked on change volume alone.",
    input: {
      project,
      sort: z.enum(["risk", "churn", "loc", "path"]).default("risk"),
      limit: z.coerce.number().int().min(1).max(200).default(30),
    },
    cli: {
      args: ["project", "sort", "limit"],
      aliases: ["modules"],
      label: () => "Reading module metrics",
    },
    handler: (a) => getModules(a.project, { sort: a.sort, limit: a.limit }),
  },
  {
    name: "get_module",
    readOnly: true,
    description:
      "One module in full: its metrics, what it depends on and what depends on it, who has been changing it lately, its largest files, and the recurring bug themes that land in it. Use it before changing unfamiliar code, and to find out who to ask.",
    input: {
      project,
      module: z.string().describe("Module path as returned by get_modules, e.g. src/knowledge"),
    },
    cli: {
      args: ["project", "module"],
      aliases: ["module"],
      label: (a) => `Reading module "${a.module}"`,
    },
    handler: (a) => getModule(a.project, a.module),
  },
  {
    name: "get_cochange",
    readOnly: true,
    description:
      "What else historically changes when this changes — the files coupled to a target by commit history rather than by imports. Use it to catch the file you were about to forget: a test, a migration, a fixture, a doc. Takes a path, directory or symbol name.",
    input: {
      project,
      target: z.string().describe("File path, directory or symbol name"),
      limit: z.coerce.number().int().min(1).max(50).default(15),
    },
    cli: {
      args: ["project", "target", "limit"],
      aliases: ["cochange"],
      label: (a) => `Finding what changes with "${a.target}"`,
    },
    handler: (a) => getCochange(a.project, a.target, a.limit),
  },
  {
    name: "get_bug_clusters",
    readOnly: true,
    description:
      "Recurring themes across this project's fix commits, grouped and labelled, largest first — 'what keeps breaking here'. Clustered from fix commit messages, not from an issue tracker. `method: 'terms'` means embeddings were off and the grouping is keyword-based, so treat it as weaker evidence.",
    input: { project, limit: z.coerce.number().int().min(1).max(50).default(10) },
    cli: {
      args: ["project", "limit"],
      aliases: ["bugs"],
      label: () => "Reading bug clusters",
    },
    handler: (a) => getBugClusters(a.project, a.limit),
  },
  {
    name: "compose_context",
    readOnly: true,
    description:
      "Assemble everything worth knowing before starting a task, in one call: the confirmed rules governing the code involved, the code and docs that match, what was fixed there before, and what this project has learned — each with a citation, packed into a token budget that rules always survive. Prefer this over firing search_code, get_rules, recall and get_history separately; it fuses them and tells you in `understood` what it took your description to mean. `format: markdown` returns paste-ready prose.",
    input: {
      project,
      task: z.string().describe("What you're about to do, in plain language"),
      budget: z.coerce.number().int().min(200).max(60000).default(6000)
        .describe("Approximate token budget for the assembled context"),
      format: z.enum(["json", "markdown"]).default("json"),
    },
    cli: {
      args: ["project", "task", "budget", "format"],
      aliases: ["context"],
      label: (a) => `Composing context for "${String(a.task).slice(0, 40)}"`,
    },
    handler: (a) =>
      composeContext(a.project, a.task, { budget: a.budget, format: a.format }),
  },
  {
    name: "create_reasoning_graph",
    readOnly: false,
    description:
      "Start a new reasoning/decision graph for a feature: a Decision Review HTML page plus its JSON source of truth, written into the target project at docs/waycontext/<slug>/ (configurable via REASONING_DIR). Use this once, at the start of working out a feature's requirements/edge-cases/design decisions with the developer; call update_reasoning_graph afterward to add questions, alternatives, evidence, review state and decisions as they come up. Does not auto-open a browser tab; open the returned review_url yourself. Errors if the slug already exists -- pass an explicit `slug` to disambiguate. Returns the absolute paths to both files, the slug to pass to update_reasoning_graph, and a served review URL.",
    input: {
      project,
      feature: z.string().describe("Feature name/title, e.g. 'Forgot password'"),
      slug: z.string().optional().describe("URL/path-safe id; derived from `feature` if omitted"),
    },
    cli: {
      args: ["project", "feature", "slug"],
      aliases: ["reasoning-init"],
      label: (a) => `Creating reasoning graph for "${a.feature}"`,
    },
    handler: (a, ctx) => createReasoningGraph(
      a.project,
      { feature: a.feature, slug: a.slug },
      { log: ctx?.log }
    ),
  },
  {
    name: "update_reasoning_graph",
    readOnly: false,
    description:
      "Apply one or more updates to an existing reasoning graph (add a question node, add an alternative with pros/cons, select an answer, mark a node resolved/open, set review/evidence/confidence, set risk or affected_files, reparent or remove a node) and re-render its Decision Review HTML. Does not auto-open a browser tab; open the returned review_url manually to see the update. `patch` is a JSON array of patch operations, e.g. '[{\"op\":\"add_node\",\"parent\":\"n1\",\"type\":\"question\",\"title\":\"...\"}]'. Applied atomically: if any operation is invalid, nothing is written. Re-reads graph.json from disk each call, so hand-edits between calls are respected. Returns a served review URL for direct browser open.",
    input: {
      project,
      slug: z.string().describe("Feature slug, as returned by create_reasoning_graph"),
      patch: z.string().describe("JSON array of patch operations"),
    },
    cli: {
      args: ["project", "slug", "patch"],
      aliases: ["reasoning-update"],
      label: (a) => `Updating reasoning graph "${a.slug}"`,
    },
    handler: (a, ctx) => updateReasoningGraph(
      a.project,
      { slug: a.slug, patch: a.patch },
      { log: ctx?.log }
    ),
  },
];

/** Look up an operation by name or CLI alias. */
export function findOperation(nameOrAlias) {
  return (
    operations.find((op) => op.name === nameOrAlias) ||
    operations.find((op) => op.cli?.aliases?.includes(nameOrAlias)) ||
    null
  );
}

/** Which positional arguments are required (i.e. have no schema default). */
export function requiredArgs(op) {
  return (op.cli?.args ?? []).filter((key) => !op.input[key]?.isOptional?.());
}

/** `search_code <project> <query> [limit]` — generated, never hand-maintained. */
export function usageLine(op) {
  const required = new Set(requiredArgs(op));
  const parts = (op.cli?.args ?? []).map((key) => (required.has(key) ? `<${key}>` : `[${key}]`));
  return [op.name, ...parts].join(" ");
}

/**
 * Turn positional CLI argv into validated, typed arguments.
 * Throws a ZodError on bad input -- the same validation the MCP surface gets.
 */
export function parseCliArgs(op, argv) {
  const keys = op.cli?.args ?? [];
  const raw = {};
  keys.forEach((key, i) => {
    if (argv[i] !== undefined) raw[key] = argv[i];
  });
  return z.object(op.input).parse(raw);
}
