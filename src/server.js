#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "./db.js";
import { buildMcpServer } from "./mcpServer.js";
import { shutdownBrowserSessions } from "./browser/ops.js";
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
  // This process owns any browser it started: release it when the client goes
  // away (stdin closes) or the process is told to stop.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await shutdownBrowserSessions({ surface: "mcp" }).catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // stdin closing only means no more requests are coming -- a client that
  // pipes its requests and closes (CI's smoke test does) still expects answers
  // to the ones it sent. Exiting on "end" killed those mid-handler, so track
  // requests until their response is written and stop once none remain.
  const inFlight = new Set();
  let stdinEnded = false;
  const stopIfIdle = () => {
    if (stdinEnded && inFlight.size === 0) stop();
  };
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if ("method" in message && "id" in message) inFlight.add(message.id);
    onmessage?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    try {
      return await send(message, options);
    } finally {
      if (!("method" in message) && "id" in message) {
        inFlight.delete(message.id);
        stopIfIdle();
      }
    }
  };
  process.stdin.once("end", () => {
    stdinEnded = true;
    stopIfIdle();
  });
  console.error(`${NAME} MCP server ${VERSION} running on stdio`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
