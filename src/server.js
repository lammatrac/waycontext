#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "./db.js";
import { buildMcpServer } from "./mcpServer.js";
import { NAME, VERSION } from "./version.js";

// The server used to identify as "code-context" while install.sh registered it
// as "waycontext", so clients saw two different names for one server and the
// hook's hardcoded tool names never matched. One name, read from package.json
// so it can't drift again.
//
// Tool registration lives in src/mcpServer.js, shared with the `/mcp` transport
// `waycontext serve` exposes: two copies of that loop would drift the moment one
// transport gained a tool the other didn't.
async function main() {
  await initDb();
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${NAME} MCP server ${VERSION} running on stdio`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
