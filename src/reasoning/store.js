/**
 * The fs-touching layer for reasoning graphs -- parallel to knowledgeFiles.js:
 * resolve the project's root_path, then read/write plain files under it.
 * Stateless and re-reads graph.json on every call, since MCP tool calls have
 * no session affinity and a developer may hand-edit the file between calls.
 */
import fs from "node:fs";
import path from "node:path";
import { getProject } from "../db.js";
import { config } from "../config.js";
import { slugify } from "./slug.js";
import { newGraph, validateGraph } from "./schema.js";
import { applyPatch } from "./patch.js";
import { renderHtml } from "./render.js";
import { openLocalFile } from "./open.js";
import { ensureService, serviceBaseUrl } from "../serviceManager.js";

async function resolveDir(projectName, slug) {
  const project = await getProject(projectName);
  if (!project) throw new Error(`Project "${projectName}" not found.`);
  return path.join(project.root_path, config.reasoningDir, slugify(slug));
}

function paths(dir) {
  return {
    graphPath: path.join(dir, "graph.json"),
    htmlPath: path.join(dir, "waycontext-review.html"),
    legacyHtmlPath: path.join(dir, "reasoning.html"),
  };
}

function writeGraphFiles(dir, graph) {
  const { graphPath, htmlPath, legacyHtmlPath } = paths(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
  const html = renderHtml(graph);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(legacyHtmlPath, html);
  return { graphPath, htmlPath };
}

async function maybeAutoOpenReview(htmlPath, { log = () => {}, openFile = openLocalFile } = {}) {
  if (!config.reasoningAutoOpen) {
    return { enabled: false, attempted: false, opened: false, reason: "REASONING_AUTO_OPEN is disabled" };
  }

  try {
    const launched = await openFile(htmlPath);
    log(`Opened review file: ${htmlPath}`);
    return {
      enabled: true,
      attempted: true,
      opened: true,
      command: launched.command,
      args: launched.args,
    };
  } catch (e) {
    const warning = `Auto-open failed: ${e.message}`;
    log(warning);
    return { enabled: true, attempted: true, opened: false, warning };
  }
}

async function ensureReviewService(log) {
  if (!config.serviceAutoStart) {
    return {
      enabled: false,
      ensured: false,
      url: serviceBaseUrl(),
      reason: "WAYCONTEXT_AUTO_SERVICE is disabled",
    };
  }

  try {
    const result = await ensureService();
    return {
      enabled: true,
      ensured: true,
      ...result,
    };
  } catch (e) {
    log(`Could not auto-start review service: ${e.message}`);
    return {
      enabled: true,
      ensured: false,
      url: serviceBaseUrl(),
      warning: e.message,
    };
  }
}

function reviewUrl(baseUrl, projectName, slug) {
  return `${baseUrl}/reviews/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;
}

export async function createReasoningGraph(projectName, { feature, slug }, options = {}) {
  const resolvedSlug = slugify(slug ?? feature);
  const dir = await resolveDir(projectName, resolvedSlug);
  const { graphPath, htmlPath } = paths(dir);
  if (fs.existsSync(graphPath)) {
    throw new Error(`Reasoning graph "${resolvedSlug}" already exists at ${graphPath}.`);
  }
  const graph = newGraph({ feature, slug: resolvedSlug });
  writeGraphFiles(dir, graph);
  const auto_open = await maybeAutoOpenReview(htmlPath, options);
  const review_service = await ensureReviewService(options.log ?? (() => {}));
  const review_url = reviewUrl(review_service.url ?? serviceBaseUrl(), projectName, resolvedSlug);
  return {
    slug: resolvedSlug,
    graph_path: graphPath,
    html_path: htmlPath,
    review_url,
    review_service,
    auto_open,
  };
}

export async function updateReasoningGraph(projectName, { slug, patch }, options = {}) {
  const resolvedSlug = slugify(slug);
  const dir = await resolveDir(projectName, resolvedSlug);
  const { graphPath, htmlPath } = paths(dir);
  if (!fs.existsSync(graphPath)) {
    throw new Error(`Reasoning graph "${resolvedSlug}" not found; call create_reasoning_graph first.`);
  }

  let ops;
  try {
    ops = JSON.parse(patch);
  } catch (e) {
    throw new Error(`patch must be a JSON array of operations: ${e.message}`);
  }
  if (!Array.isArray(ops)) throw new Error("patch must be a JSON array of operations.");

  const current = validateGraph(JSON.parse(fs.readFileSync(graphPath, "utf8")));
  const next = applyPatch(current, ops);
  writeGraphFiles(dir, next);
  const auto_open = {
    enabled: false,
    attempted: false,
    opened: false,
    reason: "update_reasoning_graph never auto-opens; open review_url manually",
  };
  const review_service = await ensureReviewService(options.log ?? (() => {}));
  const review_url = reviewUrl(review_service.url ?? serviceBaseUrl(), projectName, resolvedSlug);
  return {
    slug: resolvedSlug, graph_path: graphPath, html_path: htmlPath,
    review_url, review_service,
    updated_at: next.updated_at, node_count: Object.keys(next.nodes).length,
    auto_open,
  };
}
