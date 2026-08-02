#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "./db.js";
import { operations } from "./operations.js";
import { NAME, VERSION } from "./version.js";

// The server used to identify as "code-context" while install.sh registered it
// as "waycontext", so clients saw two different names for one server and the
// hook's hardcoded tool names never matched. One name, read from package.json
// so it can't drift again.
const server = new McpServer({ name: NAME, version: VERSION });

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
  console.error(`${NAME} MCP server ${VERSION} running on stdio`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
