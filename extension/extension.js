/**
 * WayContext for VS Code.
 *
 * Thin on purpose. Every command is: work out the project, call one operation
 * through extension/client.js, show the result. All the intelligence is on the
 * server, reachable identically from MCP, the CLI and the web UI, so this file
 * has no logic worth testing and (deliberately) none that isn't in client.js.
 *
 * Not verifiable by `npm test`: there is no headless VS Code in this repo, so
 * what is asserted is client.js against a real server. This file is verified only
 * as far as "loads, registers its commands, and calls the right client method".
 */
"use strict";

const vscode = require("vscode");
const path = require("path");
const { WayContextClient, WayContextError, DEFAULT_URL } = require("./client");

let output;

function log(message) {
  output ??= vscode.window.createOutputChannel("WayContext");
  output.appendLine(message);
}

function client() {
  const url = vscode.workspace.getConfiguration("waycontext").get("serverUrl") || DEFAULT_URL;
  return new WayContextClient(url);
}

/**
 * An offline server is the one failure with an obvious fix, so it gets an action
 * rather than a message: the terminal is opened with the command already in it.
 */
async function handleError(e) {
  if (e instanceof WayContextError && e.kind === "offline") {
    const choice = await vscode.window.showErrorMessage(e.message, "Start server");
    if (choice === "Start server") {
      const term = vscode.window.createTerminal("waycontext serve");
      term.sendText("waycontext serve");
      term.show();
    }
    return;
  }
  vscode.window.showErrorMessage(e.message ?? String(e));
}

/** The project covering the active file, or the configured one, or a prompt. */
async function currentProject(api) {
  const configured = vscode.workspace.getConfiguration("waycontext").get("project");
  if (configured) return configured;

  const active = vscode.window.activeTextEditor?.document?.uri?.fsPath;
  if (active) {
    const found = await api.projectForPath(active);
    if (found) return found;
  }
  const names = await api.projects();
  if (!names.length) {
    throw new WayContextError("No indexed projects. Run: waycontext index <name> <path>", "operation");
  }
  if (names.length === 1) return names[0];
  const picked = await vscode.window.showQuickPick(names, { placeHolder: "Which project?" });
  if (!picked) throw new WayContextError("Cancelled", "operation");
  return picked;
}

function relativePath(absPath) {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath));
  return folder ? path.relative(folder.uri.fsPath, absPath).split(path.sep).join("/") : absPath;
}

async function openMarkdown(title, body) {
  const doc = await vscode.workspace.openTextDocument({ content: body, language: "markdown" });
  await vscode.window.showTextDocument(doc, { preview: true });
  log(`${title}: ${body.length} chars`);
}

/** Jump to `path:line`, the citation format every operation returns. */
async function openCitation(ref, project, api) {
  const [file, line] = String(ref).split("#")[0].split(":");
  const rows = await api.op("list_projects", {});
  const root = rows.find((r) => r.name === project)?.root_path;
  if (!root) return;
  const uri = vscode.Uri.file(path.join(root, file));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  if (line) {
    const at = new vscode.Position(Math.max(0, Number(line) - 1), 0);
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
  }
}

const commands = {
  /** Search code, docs and memory; jump to whatever is picked. */
  async search() {
    const api = client();
    const project = await currentProject(api);
    const query = await vscode.window.showInputBox({
      prompt: `Search ${project}`,
      value: vscode.window.activeTextEditor?.document?.getText(
        vscode.window.activeTextEditor.selection
      ) || "",
    });
    if (!query) return;
    const rows = await api.op("search_knowledge", { project, query, limit: 20 });
    if (!rows.length) return vscode.window.showInformationMessage("Nothing found.");
    const picked = await vscode.window.showQuickPick(
      rows.map((r) => ({
        label: r.title ?? "(untitled)",
        description: r.type,
        detail: [r.path, r.heading_path].filter(Boolean).join(" › "),
        ref: r.path,
      })),
      { placeHolder: `${rows.length} results`, matchOnDetail: true }
    );
    if (picked?.ref) await openCitation(picked.ref, project, api);
  },

  /** What to know before committing what's in the working tree. */
  async reviewContext() {
    const api = client();
    const project = await currentProject(api);
    const r = await api.op("review_context", { project });
    const lines = [`# Review context — ${project}`, "", `Changed paths: ${r.paths.length}`, ""];
    if (r.rules.length) {
      lines.push("## Rules governing these changes", "");
      for (const rule of r.rules) lines.push(`- **${rule.statement}** — \`${rule.scope ?? "project-wide"}\``);
      lines.push("");
    }
    if (r.memories.length) {
      lines.push("## Remembered about these files", "");
      for (const m of r.memories) lines.push(`- ${m.content}`);
      lines.push("");
    }
    if (r.recent_fixes.length) {
      lines.push("## Fixed here before", "");
      for (const c of r.recent_fixes) lines.push(`- \`${c.short_sha}\` ${c.subject}`);
      lines.push("");
    }
    if (!r.rules.length && !r.memories.length && !r.recent_fixes.length) {
      lines.push("_Nothing recorded about these paths yet._");
    }
    await openMarkdown("Review context", lines.join("\n"));
  },

  /** Metrics, owners and recurring bugs for the module the active file is in. */
  async explainModule() {
    const api = client();
    const active = vscode.window.activeTextEditor?.document?.uri?.fsPath;
    if (!active) return vscode.window.showInformationMessage("Open a file first.");
    const project = await currentProject(api);
    const mod = await api.moduleForPath(project, relativePath(active));
    if (!mod) return vscode.window.showInformationMessage("No module covers this file — re-index?");

    const d = await api.op("get_module", { project, module: mod.path });
    const m = d.metrics;
    const lines = [`# ${d.module.path}`, "",
      `${d.module.file_count} files · ${d.module.loc} lines · ${d.module.symbol_count} symbols`, ""];
    if (m) {
      lines.push("## Metrics", "",
        `- Risk **${m.risk}** (${m.risk_basis.replace(/_/g, " ")})`,
        `- ${m.commits} commits in ${m.window_days} days, ${m.fix_commits} of them fixes`,
        `- Churn ${m.churn} lines · ${m.authors} author(s)`, "");
    }
    if (d.owners.length) {
      lines.push("## Who to ask", "");
      for (const o of d.owners) {
        lines.push(`- ${o.display_name || o.canonical_email} — ${Math.round((o.share ?? 0) * 100)}%`);
      }
      lines.push("");
    }
    if (d.depends_on.length) {
      lines.push("## Depends on", "", ...d.depends_on.map((x) => `- \`${x.path}\` (${x.edge_count})`), "");
    }
    if (d.bug_clusters.length) {
      lines.push("## Recurring bugs", "", ...d.bug_clusters.map((c) => `- ${c.label} (${c.size})`), "");
    }
    await openMarkdown("Module", lines.join("\n"));
  },

  /** Full task context, as markdown, ready to paste into a prompt. */
  async composeContext() {
    const api = client();
    const project = await currentProject(api);
    const task = await vscode.window.showInputBox({
      prompt: "What are you about to do?",
      placeHolder: "fix the retry logic in indexProject",
    });
    if (!task) return;
    await openMarkdown("Context", await api.composeContext(project, task));
  },

  /** Record a gotcha against the current file. */
  async remember() {
    const api = client();
    const project = await currentProject(api);
    const content = await vscode.window.showInputBox({
      prompt: "What did you learn?",
      placeHolder: "The payment API rejects a repeated idempotency key with 409, not 200.",
    });
    if (!content) return;
    const kind = await vscode.window.showQuickPick(
      ["gotcha", "fix", "convention", "postmortem"], { placeHolder: "Kind" }
    );
    if (!kind) return;

    const active = vscode.window.activeTextEditor?.document?.uri?.fsPath;
    const scope = active
      ? await vscode.window.showInputBox({
          prompt: "Scope (glob), or leave blank for project-wide",
          value: relativePath(active),
        })
      : undefined;

    const saved = await api.op("remember", { project, content, kind, scope: scope || undefined });
    vscode.window.showInformationMessage(`Remembered (${saved.key ?? "saved"}).`);
  },

  /** Open the web knowledge graph in a browser. */
  async openGraph() {
    const url = vscode.workspace.getConfiguration("waycontext").get("serverUrl") || DEFAULT_URL;
    await client().health(); // fail loudly here rather than in an empty browser tab
    await vscode.env.openExternal(vscode.Uri.parse(url));
  },
};

function activate(context) {
  for (const [name, handler] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`waycontext.${name}`, () =>
        handler().catch(handleError)
      )
    );
  }
  log(`WayContext extension active. Commands: ${Object.keys(commands).join(", ")}`);
}

function deactivate() {
  output?.dispose();
}

module.exports = { activate, deactivate, commands };
