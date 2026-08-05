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

async function resolveDir(projectName, slug) {
  const project = await getProject(projectName);
  if (!project) throw new Error(`Project "${projectName}" not found.`);
  return path.join(project.root_path, config.reasoningDir, slugify(slug));
}

function paths(dir) {
  return { graphPath: path.join(dir, "graph.json"), htmlPath: path.join(dir, "reasoning.html") };
}

function writeGraphFiles(dir, graph) {
  const { graphPath, htmlPath } = paths(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
  fs.writeFileSync(htmlPath, renderHtml(graph));
  return { graphPath, htmlPath };
}

export async function createReasoningGraph(projectName, { feature, slug }) {
  const resolvedSlug = slugify(slug ?? feature);
  const dir = await resolveDir(projectName, resolvedSlug);
  const { graphPath, htmlPath } = paths(dir);
  if (fs.existsSync(graphPath)) {
    throw new Error(`Reasoning graph "${resolvedSlug}" already exists at ${graphPath}.`);
  }
  const graph = newGraph({ feature, slug: resolvedSlug });
  writeGraphFiles(dir, graph);
  return { slug: resolvedSlug, graph_path: graphPath, html_path: htmlPath };
}

export async function updateReasoningGraph(projectName, { slug, patch }) {
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
  return {
    slug: resolvedSlug, graph_path: graphPath, html_path: htmlPath,
    updated_at: next.updated_at, node_count: Object.keys(next.nodes).length,
  };
}
