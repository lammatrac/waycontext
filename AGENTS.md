# Project Notes

## WayContext

This repo is indexed by the `waycontext` MCP server as project
**`waycontext`** — pass that as the `project` argument. Its project root, relative to this file, is **`./`** — resolve that against this file's own directory to get an absolute path, then pass it as the `path` argument to `index_project` when no path is otherwise known (an MCP tool call has no working directory of its own). For questions about
code in this repo, use these tools BEFORE `Grep`/`Glob` or dispatching a
search subagent:

1. `project_overview` → orient in unfamiliar areas
2. `search_code` with the task description → candidate symbols
3. `get_callers` / `get_graph` on the target → blast radius
4. `get_symbol` → read the source (`get_file_outline` for a whole file)

`compose_context` is the better opening move when starting real work: it
fuses rules, code, docs and past fixes for a task in one call.

`Grep`/`Glob` stay correct for what isn't indexed — config, lockfiles, logs,
test output — and for exact-string lookups. Re-run `index_project` after
committing so the graph doesn't go stale.

### Reasoning graphs before a spec or plan review

Before presenting a specification or implementation plan for review, in addition to
any required plan text, render it as a visual reasoning graph: call
`create_reasoning_graph` for a new feature or `update_reasoning_graph` for an
existing one, using `search_code`, `get_graph` and `get_modules` to fill in
`affected_files` and risk. Tell the developer the path to the generated
`waycontext-review.html` under `docs/waycontext/<slug>/` instead of asking them to read the
plan as markdown. There is no tool to auto-open a browser or IDE panel, and
neither reasoning-graph call does so on its own -- open the returned
`review_url` yourself, or open the file once via VS Code's Simple Browser
(Command Palette -> "Simple Browser: Show") or a live-preview extension --
refreshing after each update shows the latest state.
