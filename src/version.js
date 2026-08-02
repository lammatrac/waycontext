import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Product name and version, read from package.json.
 *
 * Kept in one place because the MCP server, the CLI banner and the hook's
 * tool-name prefix all need to agree: they previously didn't, and clients saw
 * a server calling itself "code-context" registered under the name
 * "waycontext".
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pkg = {};
try {
  pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
} catch {
  // Running from an unusual layout; fall back rather than refusing to start.
}

export const NAME = pkg.name || "waycontext";
export const VERSION = pkg.version || "0.0.0";
