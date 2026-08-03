/**
 * The MCP server, built once and mounted on two transports.
 *
 * Extracted from src/server.js when Phase 5 added `/mcp` over HTTP: the tool
 * registration loop is the contract between WayContext and every MCP client, and
 * two copies of it would drift the moment one transport gained a tool the other
 * didn't.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operations } from "./operations.js";
import { NAME, VERSION } from "./version.js";

const json = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message}` }],
  isError: true,
});

/**
 * Every tool comes from src/operations.js -- the same declarations the CLI
 * dispatches and /v1/ops/:name routes -- so a new capability is exposed
 * everywhere at once and the descriptions, schemas and defaults can't drift.
 */
export function buildMcpServer() {
  const server = new McpServer({ name: NAME, version: VERSION });
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
  return server;
}
