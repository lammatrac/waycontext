/**
 * The MCP server, built once and mounted on two transports.
 *
 * Extracted from src/server.js when Phase 5 added `/mcp` over HTTP: the tool
 * registration loop is the contract between WayContext and every MCP client, and
 * two copies of it would drift the moment one transport gained a tool the other
 * didn't.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildInstructions } from "./mcpInstructions.js";
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
 *
 * `instructions` is what tells a client's agent these tools exist and are worth
 * preferring over its built-in search; see src/mcpInstructions.js. It is built
 * once per server, at connect time, which is also when the project list it
 * embeds is at its freshest.
 *
 * `readOnlyHint` is not decoration: clients auto-approve read-only tools, so
 * without it a search_code call can raise a permission prompt while the agent's
 * built-in Grep is pre-approved -- a mechanical reason to route around us that
 * has nothing to do with the tool being worse.
 */
export function buildMcpServer() {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    { instructions: buildInstructions() }
  );
  for (const op of operations) {
    const config = {
      description: op.description,
      inputSchema: op.input,
      annotations: { readOnlyHint: op.readOnly === true },
    };
    server.registerTool(op.name, config, async (args) => {
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
