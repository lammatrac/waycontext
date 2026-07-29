#!/usr/bin/env bash
# PreToolUse gate for Grep/Bash-grep: when the current project is indexed by
# the code-context MCP server, deny the call and redirect to code-context's
# search tools instead. Bypass with a trailing `# codectx-skip` comment when
# grep really is the right tool (docs, config, logs, non-indexed content).
#
# Installed into ~/.claude/settings.json by `node src/cli.js init-global`
# (see install.sh) — this file is the single source of truth; the settings
# entry just points here, so a `git pull` picks up changes automatically.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BYPASS_TOKEN="codectx-skip"

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')

case "$tool_name" in
  Grep)
    pattern=$(printf '%s' "$input" | jq -r '.tool_input.pattern // empty')
    if [[ "$pattern" == *"$BYPASS_TOKEN"* ]]; then
      exit 0
    fi
    ;;
  Bash)
    command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
    if [[ "$command" == *"$BYPASS_TOKEN"* ]]; then
      exit 0
    fi
    if ! printf '%s' "$command" | grep -Eq '(^|[|;&(]|[[:space:]])(grep|egrep|fgrep|rg|ag)([[:space:]]|$)'; then
      exit 0
    fi
    ;;
  *)
    exit 0
    ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
if [[ -z "$cwd" ]]; then
  cwd="$PWD"
fi

env_file="$REPO_ROOT/.env"
if [[ ! -f "$env_file" ]]; then
  exit 0
fi

db_url=$(grep -m1 '^DATABASE_URL=' "$env_file" | cut -d= -f2-)
if [[ -z "$db_url" ]]; then
  exit 0
fi

rows=$(psql "$db_url" -tAc "SELECT name || '|' || root_path FROM projects" 2>/dev/null)
if [[ $? -ne 0 ]]; then
  exit 0
fi

project_name=""
while IFS='|' read -r name root_path; do
  [[ -z "$root_path" ]] && continue
  if [[ "$cwd" == "$root_path" || "$cwd" == "$root_path"/* ]]; then
    project_name="$name"
    break
  fi
done <<< "$rows"

if [[ -z "$project_name" ]]; then
  exit 0
fi

reason="This project (\"$project_name\") is indexed by the code-context MCP server. code-context is the primary search tool here, not Grep/grep. Call ToolSearch with query \"select:mcp__code-context__search_code,mcp__code-context__get_symbol,mcp__code-context__get_callers,mcp__code-context__get_graph,mcp__code-context__get_file_outline\" and use those instead. If you are searching non-indexed content (docs, config, logs, test output) or code-context genuinely can't answer this, retry the exact same command with a trailing '# codectx-skip' comment to bypass this check once."

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
