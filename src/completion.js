import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { operations } from "./operations.js";
import { NAME, VERSION } from "./version.js";

/**
 * The hand-written half of the CLI surface, declared once.
 *
 * The 22 registry operations in operations.js already generate their own help
 * and completion. These ~17 do not live there on purpose -- `rule confirm`,
 * `serve` and friends are human-only and deliberately off the MCP/HTTP
 * allow-list -- but they were previously restated as literal strings inside
 * buildHelp(), separate from the switch that implements them. Completion would
 * have made that a third copy.
 *
 * `args` names positional slots with the same vocabulary as op.cli.args, so one
 * rule maps a slot to a completion kind. For a command with subVerbs, slot 1 is
 * the sub-verb and `args` describes slots 2..n.
 *
 * `lines`, where present, is the ordered list of `{ usage, help, helpOnOwnLine? }`
 * rows a command renders in `help` -- `hook` and `rule` each show one row per
 * sub-verb, but completion only needs one MANUAL_COMMANDS entry per switch-case
 * name (`subVerbs` already lists every verb for that; see the drift tests in
 * test/completion.test.js, which depend on exactly one entry per `case` label).
 * Splitting them into separate table entries would give "hook install" and
 * "hook uninstall" distinct `name`s with no matching switch case and break that
 * invariant. Every row -- including these -- is rendered by the same padding
 * logic in `helpLines()` below, so nothing here is pre-padded raw text; if
 * `PAD` ever changes, these rows re-pad automatically along with every other
 * entry. When `lines` is absent, the entry's own top-level `usage`/`help`/
 * `helpOnOwnLine` stand in as its single row.
 *
 * `section` places the command in one of SECTIONS below.
 */

/**
 * How `help` is laid out: ordered sections, and a one-line gloss per operation.
 *
 * Sections exist because the flat list opened with `init-db`, `migrate` and
 * `backfill-identity` -- three commands a new user will never need -- and buried
 * `index_project` and `search_code` in the middle of forty lines.
 */
export const SECTIONS = [
  { key: "start", title: "Getting started" },
  { key: "search", title: "Search & navigate" },
  { key: "arch", title: "Architecture & history" },
  { key: "knowledge", title: "Rules & engineering memory" },
  { key: "context", title: "Context for a task" },
  { key: "admin", title: "Setup & administration" },
];

/**
 * Section + one-line gloss for each registry operation, keyed by op name.
 *
 * `short` is deliberately a second, terser wording of the operation's registry
 * `description`. Those descriptions are written for an LLM deciding which tool to
 * call: several sentences, often saying when to prefer a sibling instead. None of
 * that fits a terminal column, and truncating them mid-clause reads worse than a
 * purpose-written phrase. The cost is two wordings to keep honest, which
 * test/completion.test.js guards -- every operation must have an entry here, and
 * every `short` must stay inside the column.
 */
export const OP_HELP = {
  index_project: { section: "start", short: "index a project: symbols, graph, embeddings" },
  project_overview: { section: "start", short: "orient in an unfamiliar codebase" },
  search_code: { section: "start", short: "find code by describing what it does" },
  list_projects: { section: "start", short: "what's indexed, with file/symbol counts" },

  search_knowledge: { section: "search", short: "search code and docs together (the 'why')" },
  get_symbol: { section: "search", short: "full source and signature of one symbol" },
  get_file_outline: { section: "search", short: "every symbol defined in one file" },
  get_callers: { section: "search", short: "what references this — the blast radius" },
  get_callees: { section: "search", short: "what this depends on" },
  get_graph: { section: "search", short: "dependency subgraph, both directions" },
  find_related: { section: "search", short: "semantically similar symbols" },

  get_modules: { section: "arch", short: "modules by risk: churn + defect density" },
  get_module: { section: "arch", short: "one module: metrics, deps, owners" },
  get_cochange: { section: "arch", short: "what historically changes alongside this" },
  get_bug_clusters: { section: "arch", short: "what keeps breaking, grouped" },
  get_history: { section: "arch", short: "commits that touched this, newest first" },
  who_owns: { section: "arch", short: "who to ask, weighted by recency" },

  get_rules: { section: "knowledge", short: "confirmed conventions covering this code" },
  remember: { section: "knowledge", short: "record a gotcha so it outlives the session" },
  recall: { section: "knowledge", short: "search what was recorded earlier" },

  compose_context: { section: "context", short: "rules + code + docs + memory, in one call" },
  review_context: { section: "context", short: "what to know before reviewing a change" },
  create_reasoning_graph: { section: "context", short: "start a decision graph for a feature" },
  update_reasoning_graph: { section: "context", short: "patch a decision graph, re-render HTML" },
};

export const MANUAL_COMMANDS = [
  { name: "init", section: "start", usage: "init [name] [path] [--yes] [--all]",
    help: "tell this repo's agents to use WayContext" },

  { name: "init-db", section: "admin", usage: "init-db",
    help: "create the schema (same as migrate)" },
  { name: "migrate", section: "admin", usage: "migrate [--status]",
    flags: ["--status"],
    help: "apply pending SQL migrations, or just report their state" },
  { name: "backfill-identity", section: "admin",
    usage: "backfill-identity [project] [--status] [--json]",
    args: ["project"], flags: ["--status", "--json"],
    help: "give pre-existing symbols stable keys + entities (batched, resumable)" },
  { name: "hook", section: "admin", usage: "hook install [--global] [--mode M]",
    subVerbs: ["install", "uninstall", "refresh"],
    flags: ["--global", "--project", "--mode"],
    help: "install the opt-in search hook (M: advise|ask|deny, default advise)",
    lines: [
      { usage: "hook install [--global] [--mode M]",
        help: "install the opt-in search hook (M: advise|ask|deny, default advise)" },
      { usage: "hook uninstall [--global]", help: "remove the search hook" },
      { usage: "hook refresh", help: "rebuild the hook's project cache from the database" },
    ] },
  { name: "uninstall", section: "admin", usage: "uninstall",
    help: "remove the hook, the global CLAUDE.md section and the project cache" },
  { name: "rule", section: "knowledge", usage: "rule candidates [project] [--json]",
    subVerbs: ["candidates", "confirm", "reject"], flags: ["--json"],
    // No `args`: the project slot differs by sub-verb (`candidates [project]`
    // vs `confirm <id> [project]`), which the uniform slot model cannot express.
    // Sub-verbs and --json still complete; the project argument does not.
    help: "review extracted rule candidates (human-only, not an MCP tool)",
    lines: [
      { usage: "rule candidates [project] [--json]",
        help: "review extracted rule candidates (human-only, not an MCP tool)" },
      { usage: "rule confirm|reject <id> [project]",
        help: "activate or permanently discard a candidate" },
    ] },
  { name: "knowledge-export", section: "knowledge", usage: "knowledge-export [project]",
    args: ["project"], help: "write .waycontext/knowledge/*.yaml for team sharing" },
  { name: "knowledge-import", section: "knowledge", usage: "knowledge-import [project]",
    args: ["project"], help: "read them back (additive: never deactivates a rule)" },
  { name: "serve", section: "admin", usage: "serve [--port=4747] [--host=…]",
    flags: ["--port", "--host"],
    help: "HTTP API + web knowledge graph on localhost (no auth)" },
  { name: "service", section: "admin", usage: "service ensure [--quiet]",
    subVerbs: ["ensure", "status", "stop"],
    flags: ["--quiet"],
    help: "manage the auto-started local WayContext background service",
    lines: [
      { usage: "service ensure [--quiet]", help: "start or reuse the managed local service" },
      { usage: "service status", help: "show service health, pid and version" },
      { usage: "service stop", help: "stop the managed local background service" },
    ] },

  { name: "delete_project", section: "admin", usage: "delete_project <project> [--yes]",
    args: ["project"], flags: ["--yes"],
    help: "delete a project and all its indexed data" },
  { name: "stats", section: "admin", usage: "stats",
    help: "(alias for list_projects, table output)" },
  { name: "db", section: "admin", usage: "db", help: "interactive psql session" },
  { name: "tables", section: "admin", usage: "tables [table] [limit]",
    args: ["table", "limit"],
    help: "list tables, or browse rows of one table (default limit 20)" },
  { name: "usage", section: "admin", usage: "usage [project]", args: ["project"],
    help: "embedding token usage per provider/model, with est. cost if configured" },
  { name: "completion", section: "admin", usage: "completion bash|install|uninstall",
    subVerbs: ["bash", "install", "uninstall"],
    help: "print or install the bash tab-completion script" },
  { name: "version", section: "admin", usage: "version",
    help: "print the installed version" },
  { name: "help", section: "admin", usage: "help", help: "", hidden: true },
];

export const PAD = 42;

/** A command's rows: its own `lines` array, or its top-level fields as a single row. */
export function rowsFor(c) {
  return c.lines ?? [{ usage: c.usage, help: c.help, helpOnOwnLine: c.helpOnOwnLine }];
}

/**
 * One row, as `usage` padded to PAD then its description.
 *
 * A usage string that reaches into the description column pushes its own help
 * onto the next line rather than butting up against it. This used to be the
 * explicit `helpOnOwnLine` flag, set by hand on the one entry that needed it,
 * which meant `remember`'s six positional slots and three of the generated
 * operation lines silently rendered as `…[limit](alias: knowledge)` with no
 * separating space. Deriving it from the actual length can't fall out of date.
 */
function renderRow({ usage, help, helpOnOwnLine }) {
  if (!help) return [`  ${usage}`];
  if (helpOnOwnLine || usage.length >= PAD) {
    return [`  ${usage}`, `  ${"".padEnd(PAD)}${help}`];
  }
  return [`  ${usage.padEnd(PAD)}${help}`];
}

/** Rendered rows for the hand-written commands in one section. */
export function helpLines(section) {
  return MANUAL_COMMANDS
    .filter((c) => c.section === section && !c.hidden)
    .flatMap((c) => rowsFor(c).flatMap(renderRow));
}

/** Every candidate for the first word: manual names, operation names, aliases. */
export function completeWords() {
  return [
    ...MANUAL_COMMANDS.map((c) => c.name),
    ...operations.map((op) => op.name),
    ...operations.flatMap((op) => op.cli?.aliases ?? []),
  ].sort();
}

// Conservative on purpose: only what a subcommand, sub-verb or flag name
// actually needs. Anything outside this set (a quote, a space, a glob
// character) is rejected rather than interpolated.
const SAFE_BASH_WORD = /^[A-Za-z0-9_-]+$/;

/**
 * Guard every word list before it is interpolated into a single-quoted bash
 * string literal inside the generated script. This is the one place that
 * generation-time data -- today `completeWords()`, and from Task 3 onward
 * sub-verbs and flags too -- must pass through before reaching a template
 * literal, because a bad word does not fail loudly: an odd number of
 * embedded single quotes breaks `bash -n`, but an *even* number silently
 * re-balances the quoting and corrupts the variable with no syntax error at
 * all. Throwing here, naming the offending word, is strictly better than
 * emitting a script that mis-completes without ever announcing why.
 */
export function assertSafeForBash(words) {
  for (const word of words) {
    if (!SAFE_BASH_WORD.test(word)) {
      throw new Error(`unsafe word for generated bash completion script: ${JSON.stringify(word)}`);
    }
  }
  return words;
}

/** Argument names carry the completion kind; there is no per-command logic. */
function argKind(name) {
  if (name === "project") return "project";
  if (name === "path" || name === "paths") return "path";
  return "none";
}

/**
 * The single seam between generation-time names/words and the template
 * literal that interpolates them into the generated script -- whether as a
 * bare `case` pattern label (`name:1) ...`) or inside a single-quoted echo
 * string. `completeWords()` already routes through `assertSafeForBash`
 * directly at the `_WC_COMMANDS` line; `slotArms()` and `listArms()` funnel
 * every command/op name, sub-verb and flag through this one function instead
 * of repeating the guard at each call site, so a future new interpolation
 * point can't accidentally skip it.
 */
function safeWords(words) {
  return assertSafeForBash(words);
}

/** `cmd:slot) echo kind ;;` arms for every slot worth completing. */
function slotArms() {
  const arms = [];
  for (const op of operations) {
    const names = safeWords([op.name, ...(op.cli?.aliases ?? [])]);
    (op.cli?.args ?? []).forEach((arg, i) => {
      const kind = argKind(arg);
      if (kind !== "none") arms.push(`${names.map((n) => `${n}:${i + 1}`).join("|")}) echo ${kind} ;;`);
    });
  }
  for (const c of MANUAL_COMMANDS) {
    const [name] = safeWords([c.name]);
    const offset = c.subVerbs ? 1 : 0;
    if (c.subVerbs) arms.push(`${name}:1) echo subverb ;;`);
    (c.args ?? []).forEach((arg, i) => {
      const kind = argKind(arg);
      if (kind !== "none") arms.push(`${name}:${i + 1 + offset}) echo ${kind} ;;`);
    });
  }
  return arms;
}

/** `cmd) echo "a b c" ;;` arms, skipping commands with nothing to offer. */
function listArms(pick) {
  return MANUAL_COMMANDS
    .filter((c) => (pick(c) ?? []).length)
    .map((c) => {
      const [name] = safeWords([c.name]);
      const words = safeWords(pick(c));
      return `${name}) echo '${words.join(" ")}' ;;`;
    });
}

/**
 * NAME and VERSION land in generateBash()'s `#` comment header without going
 * through safeWords() -- VERSION (e.g. "0.2.0") fails that helper's
 * word-character regex on the dots, and forcing it through would reject a
 * real version string. Inside a comment line the only actual danger is an
 * embedded newline breaking out of the comment, so guard narrowly for that
 * instead of the full bash-word charset.
 */
function assertNoNewline(value, label) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`unsafe ${label} for generated bash completion script: ${JSON.stringify(value)}`);
  }
  return value;
}

export function generateBash() {
  assertNoNewline(NAME, "NAME");
  assertNoNewline(VERSION, "VERSION");
  const indent = (lines) => lines.map((l) => `    ${l}`).join("\n");
  return `# ${NAME} bash completion -- generated by \`waycontext completion install\`
# Built from ${NAME} ${VERSION}. Regenerate after upgrading:
#   waycontext completion install
# Safe to delete by hand; \`waycontext completion uninstall\` removes it.
#
# Nothing here writes to stdout or stderr: output during completion corrupts the
# drawn prompt, so every failure path yields no candidates instead of an error.

_WC_COMMANDS='${assertSafeForBash(completeWords()).join(" ")}'

# Project names come from the cache the search hook already maintains, rewritten
# after every index_project. It exists precisely so this path never touches the
# database -- a Tab press has the same constraint the hook does.
_waycontext_projects() {
  local cache="\${XDG_CACHE_HOME:-$HOME/.cache}/waycontext/projects.json"
  [[ -r "$cache" ]] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -r '.projects[]?.name // empty' "$cache" 2>/dev/null
  else
    grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$cache" 2>/dev/null |
      sed 's/.*"\\(.*\\)"$/\\1/'
  fi
}

_waycontext_slot() {
  case "$1:$2" in
${indent(slotArms())}
    *) echo none ;;
  esac
}

_waycontext_subverbs() {
  case "$1" in
${indent(listArms((c) => c.subVerbs))}
    *) echo '' ;;
  esac
}

_waycontext_flags() {
  case "$1" in
${indent(listArms((c) => c.flags))}
    *) echo '' ;;
  esac
}

_waycontext() {
  local cur cmd
  cur="\${COMP_WORDS[COMP_CWORD]:-}"
  cmd="\${COMP_WORDS[1]:-}"

  if (( COMP_CWORD == 1 )); then
    COMPREPLY=( $(compgen -W "$_WC_COMMANDS" -- "$cur") )
    return
  fi

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$(_waycontext_flags "$cmd")" -- "$cur") )
    return
  fi

  case "$(_waycontext_slot "$cmd" $(( COMP_CWORD - 1 )))" in
    subverb) COMPREPLY=( $(compgen -W "$(_waycontext_subverbs "$cmd")" -- "$cur") ) ;;
    project) COMPREPLY=( $(compgen -W "$(_waycontext_projects)" -- "$cur") ) ;;
    # compopt errors to stderr when called outside a real completion (as the
    # tests do), which would violate the never-speak rule.
    path)    compopt -o default 2>/dev/null || true; COMPREPLY=() ;;
    *)       COMPREPLY=() ;;
  esac
}

complete -F _waycontext waycontext codecontext
`;
}

/**
 * bash-completion 2.8+ auto-loads by command name from this directory, so
 * installing needs no .bashrc edit -- verified against bash-completion 2.11,
 * whose dynamic loader searches ${XDG_DATA_HOME:-$HOME/.local/share}.
 */
export function completionPath() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "bash-completion", "completions", "waycontext");
}

export function installCompletion() {
  const target = completionPath();
  const created = !fs.existsSync(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, generateBash());
  return { path: target, created };
}

export function removeCompletion() {
  const target = completionPath();
  if (!fs.existsSync(target)) return { path: target, removed: false };
  fs.rmSync(target, { force: true });
  return { path: target, removed: true };
}
