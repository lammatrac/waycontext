#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initDb, listProjects } from "./db.js";
import { indexProject } from "./indexer.js";
import {
  searchCode, getSymbol, getCallers, getCallees,
  getSubgraph, getFileOutline, getProjectOverview, findRelated,
} from "./graph.js";

const server = new McpServer({ name: "code-context", version: "0.1.0" });

const json = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message}` }],
  isError: true,
});

server.tool(
  "index_project",
  "Scan and index a project directory: extracts all functions/classes/methods, builds a relationship graph (calls, imports, inheritance, WordPress hooks) and vector embeddings. Incremental: unchanged files are skipped. Run this first, and re-run after code changes.",
  {
    project: z.string().describe("Short project name, e.g. 'sports-wc-2026'"),
    path: z.string().describe("Absolute path to the project root on this machine"),
  },
  async ({ project, path }) => {
    try {
      const logs = [];
      const stats = await indexProject(project, path, (m) => logs.push(m));
      return json({ stats, logs });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "list_projects",
  "List all indexed projects with file/symbol/edge counts.",
  {},
  async () => {
    try { return json(await listProjects()); } catch (e) { return fail(e); }
  }
);

server.tool(
  "project_overview",
  "High-level map of a project: languages, directory sizes, most-referenced symbols (architecture hubs), and WordPress hooks in use. Best first call for understanding an unfamiliar codebase.",
  { project: z.string() },
  async ({ project }) => {
    try { return json(await getProjectOverview(project)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "search_code",
  "Hybrid search over indexed symbols: combines Postgres full-text ranking with pgvector semantic similarity (when embeddings are enabled) via Reciprocal Rank Fusion. Describe a feature or behavior in natural language (e.g. 'purge cache after match status update') and get the most relevant functions/classes.",
  {
    project: z.string(),
    query: z.string().describe("Natural-language description of what you're looking for"),
    limit: z.number().int().min(1).max(30).default(10),
  },
  async ({ project, query, limit }) => {
    try { return json(await searchCode(project, query, limit)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "get_symbol",
  "Get full details of a symbol by name (function, class, or method). Accepts 'Class::method' or bare method name. Returns signature, docblock, file location and source body.",
  { project: z.string(), name: z.string() },
  async ({ project, name }) => {
    try { return json(await getSymbol(project, name)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "get_callers",
  "Who calls / references this symbol? Returns all inbound edges (CALLS, INSTANTIATES, EXTENDS, hook registrations). Use to assess blast radius before changing a function.",
  { project: z.string(), name: z.string() },
  async ({ project, name }) => {
    try { return json(await getCallers(project, name)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "get_callees",
  "What does this symbol call / depend on? Returns all outbound edges including WordPress hooks it registers or fires.",
  { project: z.string(), name: z.string() },
  async ({ project, name }) => {
    try { return json(await getCallees(project, name)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "get_graph",
  "Get a dependency subgraph around a symbol (BFS in both directions up to `depth` hops). Returns nodes + labeled edges — ideal for understanding how a feature is wired together.",
  {
    project: z.string(),
    name: z.string(),
    depth: z.number().int().min(1).max(4).default(2),
  },
  async ({ project, name, depth }) => {
    try { return json(await getSubgraph(project, name, depth)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "get_file_outline",
  "List all symbols defined in one file (ordered by line), with signatures and docblocks.",
  { project: z.string(), path: z.string().describe("File path relative to project root") },
  async ({ project, path }) => {
    try { return json(await getFileOutline(project, path)); } catch (e) { return fail(e); }
  }
);

server.tool(
  "find_related",
  "Find symbols semantically similar to a given symbol (same feature area). Useful for discovering all code belonging to one feature even when names differ.",
  { project: z.string(), name: z.string(), limit: z.number().int().min(1).max(30).default(10) },
  async ({ project, name, limit }) => {
    try { return json(await findRelated(project, name, limit)); } catch (e) { return fail(e); }
  }
);

async function main() {
  await initDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("code-context MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
