/**
 * The extension's whole conversation with WayContext.
 *
 * Deliberately free of any `require("vscode")`, for two reasons: it can be
 * tested by node --test against a real server (test/extension.client.test.js),
 * and everything that could go wrong at runtime -- server not started, project
 * not indexed, operation renamed -- is handled in one place rather than in five
 * command handlers.
 *
 * Every call goes through POST /v1/ops/:name, the same operations registry that
 * MCP and the CLI dispatch. The extension therefore hardcodes no schemas, and a
 * new operation is reachable from here the day it is added.
 */
"use strict";

const DEFAULT_URL = "http://127.0.0.1:4747";

class WayContextError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // "offline" | "operation" | "protocol"
  }
}

class WayContextClient {
  constructor(baseUrl = DEFAULT_URL, fetchImpl = globalThis.fetch) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetch = fetchImpl;
  }

  async health() {
    try {
      const res = await this.fetch(`${this.baseUrl}/health`);
      if (!res.ok) throw new WayContextError(`Server returned ${res.status}`, "protocol");
      return await res.json();
    } catch (e) {
      if (e instanceof WayContextError) throw e;
      // The overwhelmingly common case, and the one worth a specific message:
      // the server simply isn't running. Telling someone "fetch failed" when the
      // fix is one command is a wasted interaction.
      throw new WayContextError(
        `No WayContext server at ${this.baseUrl}. Recover it with: waycontext service ensure`,
        "offline"
      );
    }
  }

  async op(name, args = {}) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/v1/ops/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
    } catch {
      throw new WayContextError(
        `No WayContext server at ${this.baseUrl}. Recover it with: waycontext service ensure`,
        "offline"
      );
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new WayContextError(`${name} returned a non-JSON response`, "protocol");
    }
    if (!res.ok) {
      const detail = body.issues?.length
        ? `${body.error}: ${body.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`
        : body.error || `${name} failed`;
      throw new WayContextError(detail, "operation");
    }
    return body.result;
  }

  async composeContext(project, task, opts = {}) {
    const res = await this.fetch(`${this.baseUrl}/v1/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, task, format: opts.format ?? "markdown", budget: opts.budget }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try { message = JSON.parse(text).error; } catch { /* text is the message */ }
      throw new WayContextError(message, "operation");
    }
    return text;
  }

  async projects() {
    const rows = await this.op("list_projects", {});
    return rows.map((r) => r.name).filter(Boolean);
  }

  /**
   * Which project covers an absolute file path.
   *
   * Longest matching root wins, so a project indexed at a subdirectory of another
   * is chosen over its parent instead of whichever happened to be listed first.
   */
  async projectForPath(absPath) {
    const rows = await this.op("list_projects", {});
    const matches = rows
      .filter((r) => r.root_path && absPath.startsWith(r.root_path))
      .sort((a, b) => b.root_path.length - a.root_path.length);
    return matches[0]?.name ?? null;
  }

  /**
   * Which module a repo-relative path belongs to.
   *
   * Asks the server rather than reimplementing the MODULE_DEPTH rule: a second
   * copy of that rule in a different language would disagree the first time
   * anyone changed the setting.
   */
  async moduleForPath(project, relPath) {
    const { modules } = await this.op("get_modules", { project, limit: 200 });
    const candidates = modules
      .filter((m) => m.path === "." || relPath.startsWith(`${m.path}/`))
      .sort((a, b) => b.path.length - a.path.length);
    return candidates[0] ?? null;
  }
}

module.exports = { WayContextClient, WayContextError, DEFAULT_URL };
