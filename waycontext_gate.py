#!/usr/bin/env python3
"""
Deterministic enforcement for the CLAUDE.md pipeline.  (v3)

Prose rules lose to skill instructions. This does not: PreToolUse hooks fire
inside subagents too, so superpowers agents and the built-in Explore agent are
covered by the same rules as the main session.

Install: ~/.claude/hooks/waycontext_gate.py  (chmod +x)

OPT-IN PER SESSION ROOT. This lives in user settings and therefore runs
everywhere, but it only enforces where you switch it on:

    mkdir -p .claude/.gate && touch .claude/.gate/enabled

A directory containing waycontext-tasks/ counts as enabled automatically. Everywhere
else the hook exits silently and touches nothing on disk.

NOTE ON PATHS. Everything is resolved against the session cwd Claude Code
reports, NOT the git root. If you launch claude from a subdirectory (a theme
folder inside a larger repo, say), then waycontext-tasks/todo/, waycontext-tasks/context/<slug>/ and
.claude/.gate/ must all live under that same subdirectory. Add
'**/.claude/.gate/' to .gitignore at the git root, not '.claude/.gate/', or
the nested path will not match.

Behaviour when enabled
  PostToolUse  mcp__waycontext__*   -> record that the index was queried
  PreToolUse   Grep|Glob            -> deny unless the index was queried first
  PreToolUse   Edit|Write|MultiEdit -> deny unless the newest gate.md has been
                                       approved by me, after it was written
  UserPromptSubmit                  -> only I can create the approval marker
  SessionStart                      -> clear stale markers

Escape hatches
  GATE_BYPASS=1 claude        one session, everything off
  rm .claude/.gate/enabled    this session root, permanently off
"""

import json
import os
import re
import sys
from pathlib import Path

STATE = ".claude/.gate"
SEARCH_MARK = "waycontext_queried"
APPROVE_MARK = "approved"
ENABLE_MARK = "enabled"
APPROVE_RE = re.compile(r"^\s*(approve|approved|/approve)\s*$", re.I)

# Process artifacts, not source. Without these the agent could never write
# spec.md / plan.md / gate.md and would deadlock against its own gate.
ALLOWED = (
    "waycontext-tasks/", ".claude/", "CLAUDE.md", "CLAUDE.local.md",
    "README.md", "UI_CODE_MAP.md",
)


def deny(reason):
    """Exit 2 blocks the tool call; stderr is fed back to the model."""
    sys.stderr.write(reason)
    sys.exit(2)


def enforced(cwd):
    root = Path(cwd)
    return (root / STATE / ENABLE_MARK).exists() or (root / "waycontext-tasks").is_dir()


def mark(st, name):
    """Create the state dir lazily -- only when something is actually written."""
    st.mkdir(parents=True, exist_ok=True)
    (st / name).touch()


def newest_gate(cwd):
    gates = sorted(
        (Path(cwd) / "waycontext-tasks/context").glob("*/gate.md"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return gates[0] if gates else None


def main():
    if os.environ.get("GATE_BYPASS") == "1":
        sys.exit(0)

    try:
        ev = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # never break the session on a malformed event

    cwd = ev.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    if not enforced(cwd):
        sys.exit(0)

    event = ev.get("hook_event_name", "")
    tool = ev.get("tool_name", "")
    ti = ev.get("tool_input") or {}
    who = ev.get("agent_type") or "main session"
    st = Path(cwd) / STATE

    # ---- session boundary: nothing carries over -------------------------
    if event == "SessionStart":
        for m in (SEARCH_MARK, APPROVE_MARK):
            (st / m).unlink(missing_ok=True)
        sys.exit(0)

    # ---- only a human prompt can approve --------------------------------
    if event == "UserPromptSubmit":
        prompt = ev.get("prompt", "")
        if APPROVE_RE.match(prompt):
            mark(st, APPROVE_MARK)
        elif prompt.strip():
            # Any other instruction invalidates a previous approval, so an
            # approval can never cover work you did not read in the gate.
            # Too strict in practice? Delete this elif and approval then
            # persists until SessionStart or the gate is rewritten.
            (st / APPROVE_MARK).unlink(missing_ok=True)
        sys.exit(0)

    # ---- record index usage ---------------------------------------------
    if event == "PostToolUse" and tool.startswith("mcp__waycontext__"):
        mark(st, SEARCH_MARK)
        sys.exit(0)

    if event != "PreToolUse":
        sys.exit(0)

    # ---- H2: no blind scanning ------------------------------------------
    if tool in ("Grep", "Glob") and not (st / SEARCH_MARK).exists():
        deny(
            f"BLOCKED ({who}): CLAUDE.md H2 - WayContext is the primary code "
            "search. Call mcp__waycontext__search_code first. If the target is "
            "a non-indexed file type, config, or docs, say that in one line "
            "and retry; any waycontext call this session unlocks Grep/Glob."
        )

    # ---- H1: no code before the gate ------------------------------------
    if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        path = str(ti.get("file_path") or ti.get("notebook_path") or "")
        if not path:
            sys.exit(0)
        try:
            rel = os.path.relpath(path, cwd)
        except ValueError:
            rel = path
        if rel.startswith(ALLOWED) or any("/" + p in rel for p in ALLOWED):
            sys.exit(0)

        gate = newest_gate(cwd)
        if gate is None:
            deny(
                f"BLOCKED ({who}): CLAUDE.md H1 - no waycontext-tasks/context/<slug>/gate.md "
                f"under {cwd}. Run Spec -> Locate -> Plan -> Gate, print the "
                "gate, and wait for approval. If this edit is genuinely outside "
                "the pipeline, tell me and I will relaunch with GATE_BYPASS=1."
            )

        appr = st / APPROVE_MARK
        if not appr.exists():
            deny(
                f"BLOCKED ({who}): CLAUDE.md H1 - {gate.parent.name}/gate.md is "
                'not approved. Print the gate and wait for the literal reply '
                '"approve". No other reply counts.'
            )
        if appr.stat().st_mtime < gate.stat().st_mtime:
            deny(
                f"BLOCKED ({who}): CLAUDE.md H1 - {gate.parent.name}/gate.md "
                "changed after it was approved. Re-print it and get a fresh "
                '"approve".'
            )

    sys.exit(0)


if __name__ == "__main__":
    main()