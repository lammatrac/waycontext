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

const project = z.string().describe("Indexed project name (see list_projects)");
const limit = z.coerce.number().int().min(1).max(30).default(10);

export const operations = [
  {
    name: "index_project",
    description:
      "Scan and index a project directory: extracts all functions/classes/methods, builds a relationship graph (calls, imports, inheritance, WordPress hooks) and vector embeddings. Incremental: unchanged files are skipped. Run this first, and re-run after code changes.",
    input: {
      project: z.string().describe("Short project name, e.g. 'sports-wc-2026'"),
      path: z.string().describe("Absolute path to the project root on this machine"),
    },
    cli: {
      args: ["project", "path"],
      aliases: ["index", "reindex"],
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
    description: "List all indexed projects with file/symbol/edge counts.",
    input: {},
    cli: { args: [], label: () => "Listing projects" },
    handler: () => listProjects(),
  },
  {
    name: "project_overview",
    description:
      "High-level map of a project: languages, directory sizes, most-referenced symbols (architecture hubs), and WordPress hooks in use. Best first call for understanding an unfamiliar codebase.",
    input: { project },
    cli: { args: ["project"], label: (a) => `Building overview for "${a.project}"` },
    handler: (a) => getProjectOverview(a.project),
  },
  {
    name: "search_code",
    description:
      "Hybrid search over indexed symbols: combines Postgres full-text ranking with pgvector semantic similarity (when embeddings are enabled) via Reciprocal Rank Fusion. Describe a feature or behavior in natural language (e.g. 'purge cache after match status update') and get the most relevant functions/classes. Each result's `score` is a relative Reciprocal-Rank-Fusion score used for ranking, not a cosine similarity or probability.",
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
    description:
      "Get full details of a symbol by name (function, class, or method). Accepts 'Class::method' or bare method name. Returns signature, docblock, file location and source body.",
    input: { project, name: z.string() },
    cli: { args: ["project", "name"], label: (a) => `Fetching "${a.name}"` },
    handler: (a) => getSymbol(a.project, a.name),
  },
  {
    name: "get_callers",
    description:
      "Who calls / references this symbol? Returns all inbound edges (CALLS, INSTANTIATES, EXTENDS, hook registrations). Use to assess blast radius before changing a function.",
    input: { project, name: z.string() },
    cli: { args: ["project", "name"], label: (a) => `Finding callers of "${a.name}"` },
    handler: (a) => getCallers(a.project, a.name),
  },
  {
    name: "get_callees",
    description:
      "What does this symbol call / depend on? Returns all outbound edges including WordPress hooks it registers or fires.",
    input: { project, name: z.string() },
    cli: { args: ["project", "name"], label: (a) => `Finding callees of "${a.name}"` },
    handler: (a) => getCallees(a.project, a.name),
  },
  {
    name: "get_graph",
    description:
      "Get a dependency subgraph around a symbol (BFS in both directions up to `depth` hops). Returns nodes + labeled edges — ideal for understanding how a feature is wired together.",
    input: { project, name: z.string(), depth: z.coerce.number().int().min(1).max(4).default(2) },
    cli: { args: ["project", "name", "depth"], label: (a) => `Building graph around "${a.name}"` },
    handler: (a) => getSubgraph(a.project, a.name, a.depth),
  },
  {
    name: "get_file_outline",
    description: "List all symbols defined in one file (ordered by line), with signatures and docblocks.",
    input: { project, path: z.string().describe("File path relative to project root") },
    cli: { args: ["project", "path"], label: (a) => `Outlining "${a.path}"` },
    handler: (a) => getFileOutline(a.project, a.path),
  },
  {
    name: "find_related",
    description:
      "Find symbols semantically similar to a given symbol (same feature area). Useful for discovering all code belonging to one feature even when names differ.",
    input: { project, name: z.string(), limit },
    cli: { args: ["project", "name", "limit"], label: (a) => `Finding symbols related to "${a.name}"` },
    handler: (a) => findRelated(a.project, a.name, a.limit),
  },
  {
    name: "get_history",
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
    description:
      "Search this project's engineering memory — gotchas, fixes, conventions and postmortems recorded earlier. Ask before debugging something that smells like it has been hit before. Pinned memories always come first; memories that were later corrected are hidden.",
    input: { project, query: z.string(), limit },
    cli: { args: ["project", "query", "limit"], label: (a) => `Recalling "${a.query}"` },
    handler: (a) => recall(a.project, a.query, a.limit),
  },
  {
    name: "review_context",
    description:
      "Everything worth knowing before reviewing or continuing a change: the confirmed rules governing the changed paths, memories scoped to them, and what was last fixed there. Defaults to the working tree's uncommitted changes — including untracked files — so it answers 'what should I know about what I'm about to commit'. Pass `paths` (comma-separated) to ask about specific files instead.",
    input: {
      project,
      paths: z.string().optional().describe("Comma-separated paths; omit for the working-tree diff"),
    },
    cli: { args: ["project", "paths"], aliases: ["review"], label: () => "Assembling review context" },
    handler: (a) => reviewContext(a.project, a.paths),
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
