#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "./db.js";
import { operations } from "./operations.js";

const server = new McpServer({ name: "code-context", version: "0.1.0" });

const json = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message}` }],
  isError: true,
});

// Every tool comes from src/operations.js -- the same declarations the CLI
// dispatches -- so a new capability is exposed on both surfaces at once and
// the descriptions, schemas and defaults can't drift apart.
for (const op of operations) {
  server.tool(op.name, op.description, op.input, async (args) => {
    try {
      // Operations that report progress (index_project) collect their log
      // lines into the response, since stdout is the MCP transport here.
      const logs = [];
      const result = await op.handler(args, { log: (m) => logs.push(m) });
      return json(logs.length ? { stats: result, logs } : result);
    } catch (e) {
      return fail(e);
    }
  });
}

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
