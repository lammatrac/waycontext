#!/usr/bin/env bash
# PreToolUse nudge for Grep/Bash-grep: when the current project is indexed by
# the WayContext MCP server, remind the agent that the MCP's search tools
# usually answer code questions better than grep.
#
# This hook is OPT-IN (`waycontext hook install`) and advisory by default:
# the grep still runs, and the model just sees a note next to the result.
# Stronger modes are available for people who want them:
#
#   advise (default)  grep runs; the agent is told to prefer WayContext next time
#   ask               the user is prompted to approve the grep
#   deny              the grep is blocked and the agent is redirected
#
# Mode and the registered MCP name are read from the project cache written by
# `waycontext hook install` / `waycontext index_project`:
#   ${XDG_CACHE_HOME:-$HOME/.cache}/waycontext/projects.json
#
# The cache is deliberately the only input: an earlier version shelled out to
# psql on every matching command, which put a DB round-trip on the agent's
# hottest path. Anything unexpected here (no cache, no jq, cwd not indexed)
# exits 0 and leaves the tool call alone.
#
# Bypass any mode once with a trailing `# codectx-skip` comment.

BYPASS_TOKEN="codectx-skip"
CACHE_FILE="${XDG_CACHE_HOME:-$HOME/.cache}/waycontext/projects.json"

command -v jq >/dev/null 2>&1 || exit 0
[[ -f "$CACHE_FILE" ]] || exit 0

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')

case "$tool_name" in
  Grep)
    pattern=$(printf '%s' "$input" | jq -r '.tool_input.pattern // empty')
    [[ "$pattern" == *"$BYPASS_TOKEN"* ]] && exit 0
    ;;
  Bash)
    command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
    [[ "$command" == *"$BYPASS_TOKEN"* ]] && exit 0
    if ! printf '%s' "$command" | grep -Eq '(^|[|;&(]|[[:space:]])(grep|egrep|fgrep|rg|ag)([[:space:]]|$)'; then
      exit 0
    fi
    ;;
  *)
    exit 0
    ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[[ -z "$cwd" ]] && cwd="$PWD"

# Deepest matching root wins, so a project nested inside another indexed
# root resolves to the inner one.
# $root is bound to a variable before use: inside startswith(...) the argument
# is evaluated against startswith's own input (the cwd string), so referring to
# .root_path there would try to index a string.
project_name=$(jq -r --arg cwd "$cwd" '
  [.projects[]?
   | select(.root_path != null)
   | (.root_path | sub("/$"; "")) as $root
   | select($cwd == $root or ($cwd | startswith($root + "/")))
   | {name: .name, root: $root}]
  | sort_by(.root | length)
  | last // empty
  | .name // empty
' "$CACHE_FILE" 2>/dev/null)

[[ -z "$project_name" ]] && exit 0

mcp_name=$(jq -r '.mcpName // "waycontext"' "$CACHE_FILE" 2>/dev/null)
mode=$(jq -r '.mode // "advise"' "$CACHE_FILE" 2>/dev/null)

tools="mcp__${mcp_name}__search_code,mcp__${mcp_name}__get_symbol,mcp__${mcp_name}__get_callers,mcp__${mcp_name}__get_graph,mcp__${mcp_name}__get_file_outline"
advice="This project (\"$project_name\") is indexed by the WayContext MCP server, which searches code semantically and by call graph. For questions about code — where a symbol is defined, who calls it, what a change affects — prefer ToolSearch with query \"select:$tools\" over grep. Grep remains the right tool for docs, config, logs, test output, and non-indexed file types."

case "$mode" in
  deny)
    jq -n --arg reason "$advice Retry the exact same command with a trailing '# codectx-skip' comment to bypass this check once." '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    ;;
  ask)
    jq -n --arg reason "$advice" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: $reason
      }
    }'
    ;;
  *)
    # advise: the grep runs; the model just sees the note next to the result.
    jq -n --arg ctx "$advice" '{
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: $ctx
      }
    }'
    ;;
esac
exit 0
