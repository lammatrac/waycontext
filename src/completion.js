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
 */
export const MANUAL_COMMANDS = [
  { name: "init-db", section: "before", usage: "init-db", help: "" },
  { name: "migrate", section: "before", usage: "migrate [--status]",
    flags: ["--status"],
    help: "apply pending SQL migrations, or just report their state" },
  { name: "backfill-identity", section: "before",
    usage: "backfill-identity [project] [--status] [--json]",
    args: ["project"], flags: ["--status", "--json"], helpOnOwnLine: true,
    help: "give pre-existing symbols stable keys + entities (batched, resumable)" },
  { name: "init", section: "before", usage: "init",
    help: "interactively write/update the CLAUDE.md WayContext section" },
  { name: "hook", section: "before", usage: "hook install [--global] [--mode M]",
    subVerbs: ["install", "uninstall", "refresh"],
    flags: ["--global", "--project", "--mode"],
    help: "install the opt-in search hook (M: advise|ask|deny, default advise)",
    lines: [
      { usage: "hook install [--global] [--mode M]",
        help: "install the opt-in search hook (M: advise|ask|deny, default advise)" },
      { usage: "hook uninstall [--global]", help: "remove the search hook" },
      { usage: "hook refresh", help: "rebuild the hook's project cache from the database" },
    ] },
  { name: "uninstall", section: "before", usage: "uninstall",
    help: "remove the hook, the global CLAUDE.md section and the project cache" },
  { name: "rule", section: "before", usage: "rule candidates [project] [--json]",
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
  { name: "knowledge-export", section: "before", usage: "knowledge-export [project]",
    args: ["project"], help: "write .waycontext/knowledge/*.yaml for team sharing" },
  { name: "knowledge-import", section: "before", usage: "knowledge-import [project]",
    args: ["project"], help: "read them back (additive: never deactivates a rule)" },
  { name: "serve", section: "before", usage: "serve [--port=4747] [--host=…]",
    flags: ["--port", "--host"],
    help: "HTTP API + web knowledge graph on localhost (no auth)" },

  { name: "delete_project", section: "after", usage: "delete_project <project> [--yes]",
    args: ["project"], flags: ["--yes"],
    help: "delete a project and all its indexed data" },
  { name: "stats", section: "after", usage: "stats",
    help: "(alias for list_projects, table output)" },
  { name: "db", section: "after", usage: "db", help: "interactive psql session" },
  { name: "tables", section: "after", usage: "tables [table] [limit]",
    args: ["table", "limit"],
    help: "list tables, or browse rows of one table (default limit 20)" },
  { name: "usage", section: "after", usage: "usage [project]", args: ["project"],
    help: "embedding token usage per provider/model, with est. cost if configured" },
  { name: "version", section: "after", usage: "version",
    help: "print the installed version" },
  { name: "help", section: "after", usage: "help", help: "", hidden: true },
];

const PAD = 38;

/** A command's rows: its own `lines` array, or its top-level fields as a single row. */
function rowsFor(c) {
  return c.lines ?? [{ usage: c.usage, help: c.help, helpOnOwnLine: c.helpOnOwnLine }];
}

/** One row rendered with the same padding buildHelp() has always used. */
function renderRow({ usage, help, helpOnOwnLine }) {
  if (!help) return [`  ${usage}`];
  if (helpOnOwnLine) return [`  ${usage}`, `  ${"".padEnd(PAD)}${help}`];
  return [`  ${usage.padEnd(PAD)}${help}`];
}

/** Help lines for one section, padded exactly as buildHelp() has always padded them. */
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

export function generateBash() {
  return `# ${NAME} bash completion -- generated by \`waycontext completion install\`
# Built from ${NAME} ${VERSION}. Regenerate after upgrading:
#   waycontext completion install
# Safe to delete by hand; \`waycontext completion uninstall\` removes it.
#
# Nothing here writes to stdout or stderr: output during completion corrupts the
# drawn prompt, so every failure path yields no candidates instead of an error.

_WC_COMMANDS='${completeWords().join(" ")}'

_waycontext() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]:-}"

  if (( COMP_CWORD == 1 )); then
    COMPREPLY=( $(compgen -W "$_WC_COMMANDS" -- "$cur") )
    return
  fi

  COMPREPLY=()
}

complete -F _waycontext waycontext codecontext
`;
}
