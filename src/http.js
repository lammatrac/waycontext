/**
 * The HTTP surface: `waycontext serve`.
 *
 * Three routes and no framework, because that is genuinely all this needs and a
 * dependency here would be paid for by every install:
 *
 *   GET  /health          liveness, version, query-cache stats
 *   POST /v1/context      the composer -- the billing unit, later
 *   POST /v1/ops/:name    any operation from the registry, by name
 *   GET  /                the web knowledge graph (Phase 6)
 *
 * `/v1/ops/:name` is what makes "every surface reads the same registry" literal
 * rather than aspirational: the VSCode extension and the web UI call it, so a new
 * operation appears in both without either of them being edited.
 *
 * SECURITY, stated plainly: there is no authentication here. It binds to
 * 127.0.0.1 and refuses to bind anywhere else unless WAYCONTEXT_ALLOW_PUBLIC_BIND
 * is set, because an unauthenticated endpoint that reads your source code must
 * not be one config typo away from being on the network. Auth, rate limiting and
 * multi-tenancy are Team/Enterprise concerns and are deliberately absent rather
 * than half-present.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { initDb, getProject } from "./db.js";
import { operations, findOperation } from "./operations.js";
import { buildMcpServer } from "./mcpServer.js";
import { composeContext } from "./context/compose.js";
import { queryCacheStats } from "./embeddings.js";
import { NAME, VERSION } from "./version.js";
import { config } from "./config.js";
import { slugify } from "./reasoning/slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");

const MAX_BODY_BYTES = 256 * 1024;

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "Content-Length": Buffer.byteLength(payload),
    // The web UI is served from this same origin, so no CORS is needed and none
    // is granted: a wildcard here would let any page you visit read your index.
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Body must be valid JSON");
  }
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Static files for the web UI, path-traversal-checked against WEB_DIR. */
function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const abs = path.resolve(WEB_DIR, rel);
  if (!abs.startsWith(path.resolve(WEB_DIR) + path.sep)) {
    return send(res, 403, { error: "Forbidden" });
  }
  fs.readFile(abs, (err, data) => {
    if (err) return send(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(abs)] ?? "application/octet-stream",
      "Content-Length": data.length,
    });
    res.end(data);
  });
}

async function serveReview(res, projectName, slug) {
  const project = await getProject(projectName);
  if (!project) return send(res, 404, { error: `Project "${projectName}" not found` });

  const resolvedRoot = path.resolve(project.root_path);
  const safeSlug = slugify(slug);
  const abs = path.resolve(resolvedRoot, config.reasoningDir, safeSlug, "waycontext-review.html");
  if (!abs.startsWith(resolvedRoot + path.sep)) {
    return send(res, 403, { error: "Forbidden" });
  }

  fs.readFile(abs, (err, data) => {
    if (err) return send(res, 404, { error: "Review not found" });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": data.length,
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  });
}

/**
 * MCP over HTTP, stateless.
 *
 * This is the distribution channel the whole surface exists for:
 * `claude mcp add --transport http waycontext http://127.0.0.1:4747/mcp` is a
 * one-liner, where the stdio transport needs a command, a path and an
 * environment.
 *
 * A fresh server and transport per request (`sessionIdGenerator: undefined`) is
 * the SDK's stateless mode. Sessions would buy resumable SSE streams; nothing
 * here streams, every operation is a single request/response, and per-session
 * state would be the first thing to leak in a long-running process.
 */
async function handleMcp(req, res) {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  // The body has to be parsed here and handed over: the transport cannot read
  // the stream itself once anything else has touched it.
  const body = req.method === "POST" ? await readJsonBody(req) : undefined;
  await transport.handleRequest(req, res, body);
}

/** The operation catalogue, as JSON a UI can render without hardcoding anything. */
function catalogue() {
  return operations.map((op) => ({
    name: op.name,
    description: op.description,
    aliases: op.cli?.aliases ?? [],
    args: op.cli?.args ?? [],
    required: (op.cli?.args ?? []).filter((k) => !op.input[k]?.isOptional?.()),
  }));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;

  if (req.method === "GET" && route === "/health") {
    return send(res, 200, {
      ok: true, name: NAME, version: VERSION,
      operations: operations.length,
      query_cache: queryCacheStats(),
    });
  }

  if (req.method === "GET" && route === "/v1/ops") {
    return send(res, 200, { operations: catalogue() });
  }

  if (req.method === "POST" && route === "/v1/context") {
    const body = await readJsonBody(req);
    if (!body.project || !body.task) {
      return send(res, 400, { error: "Both `project` and `task` are required" });
    }
    const result = await composeContext(body.project, body.task, {
      budget: body.budget,
      format: body.format,
      snippets: body.snippets,
      deadlineMs: body.deadline_ms,
    });
    return typeof result === "string"
      ? send(res, 200, result)
      : send(res, 200, result);
  }

  if (req.method === "POST" && route.startsWith("/v1/ops/")) {
    const name = decodeURIComponent(route.slice("/v1/ops/".length));
    const op = findOperation(name);
    // The registry is the allow-list. There is no path from here to a function
    // that isn't declared as an operation, which is what keeps the human-only
    // commands (rule confirm, knowledge-import) off this surface too.
    if (!op) return send(res, 404, { error: `Unknown operation "${name}"` });

    const body = await readJsonBody(req);
    let args;
    try {
      args = z.object(op.input).parse(body);
    } catch (e) {
      return send(res, 400, {
        error: "Invalid arguments",
        issues: e.issues?.map((i) => ({ path: i.path.join("."), message: i.message })) ?? [],
      });
    }
    const logs = [];
    const result = await op.handler(args, { log: (m) => logs.push(m) });
    return send(res, 200, logs.length ? { result, logs } : { result });
  }

  if (route === "/mcp") {
    return handleMcp(req, res);
  }

  if (req.method === "GET" && route.startsWith("/reviews/")) {
    const parts = route.split("/").filter(Boolean);
    if (parts.length === 3) {
      const projectName = decodeURIComponent(parts[1]);
      const slug = decodeURIComponent(parts[2]);
      return serveReview(res, projectName, slug);
    }
    return send(res, 404, { error: "Not found" });
  }

  if (req.method === "GET" && (route === "/" || /^\/[\w.-]+\.(html|js|css|svg)$/.test(route))) {
    return serveStatic(req, res, route);
  }

  send(res, 404, {
    error: "Not found",
    routes: ["/health", "/v1/ops", "/v1/ops/:name", "/v1/context", "/mcp", "/reviews/:project/:slug", "/"],
  });
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      // Operations throw for ordinary reasons -- unknown project, unresolvable
      // target -- so a thrown message is a 400 with the message, not a 500 with
      // a stack. Genuine bugs surface the same way; the alternative is hiding
      // "Project not found" behind "Internal error".
      if (!res.headersSent) send(res, 400, { error: e.message });
    });
  });
}

/**
 * @param {{port?:number, host?:string}} opts
 */
export async function serve(opts = {}) {
  // `Number(undefined)` is NaN, and NaN ?? fallback is NaN, so the coercion has
  // to happen before the fallback rather than after it.
  const envPort = process.env.PORT ? Number(process.env.PORT) : null;
  const port = opts.port ?? (Number.isFinite(envPort) ? envPort : 4747);
  const host = opts.host ?? "127.0.0.1";

  if (host !== "127.0.0.1" && host !== "localhost" && !process.env.WAYCONTEXT_ALLOW_PUBLIC_BIND) {
    throw new Error(
      `Refusing to bind to ${host}: this server has no authentication. ` +
      `Set WAYCONTEXT_ALLOW_PUBLIC_BIND=1 if you have put your own auth in front of it.`
    );
  }

  await initDb();
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { server, url: `http://${host}:${port}` };
}
