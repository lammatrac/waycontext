# Project Notes

## WayContext

This project is indexed by the `waycontext` MCP server under the project
name **`waycontext`**. When using `waycontext` tools
(`project_overview`, `search_code`, `get_graph`, `get_callers`, `get_symbol`,
`index_project`, etc.) for this repo, use/target project `waycontext`.

### Reasoning graphs before a spec or plan review

Before presenting a specification or implementation plan for review, in addition to
any required plan text, render it as a visual reasoning graph: call
`create_reasoning_graph` for a new feature or `update_reasoning_graph` for an
existing one, using `search_code`, `get_graph` and `get_modules` to fill in
`affected_files` and risk. Tell the developer the path to the generated
`reasoning.html` under `docs/waycontext/<slug>/` instead of asking them to read the
plan as markdown. There is no tool to auto-open a browser or IDE panel, so suggest
opening it once via VS Code's Simple Browser (Command Palette -> "Simple Browser:
Show") or a live-preview extension -- refreshing after each update shows the latest
state.

