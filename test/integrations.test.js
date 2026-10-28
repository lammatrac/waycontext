import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { integrationStatus } from "../src/integrations.js";

const MCP_FIX = "claude mcp add --scope user waycontext -- waycontext-mcp";
const down = async () => ({ running: false, url: "http://127.0.0.1:4747" });
const up = async () => ({ running: true, url: "http://127.0.0.1:4747", version: "1.2.3" });

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wc-integ-"));
}
function put(home, rel, content) {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const byId = (items, id) => items.find((i) => i.id === id);
const run = (home, extra = {}) => integrationStatus({ home, env: {}, service: down, ...extra });

test("returns the five integrations in order", async () => {
  const items = await run(tmpHome());
  assert.deepEqual(items.map((i) => i.id), ["mcp_registration", "gate_script", "gate_hooks", "config_file", "service"]);
  for (const i of items) assert.ok(i.label && i.detail !== undefined);
});

test("mcp_registration: missing file, missing entry, malformed, ok", async () => {
  const home = tmpHome();
  let r = byId(await run(home), "mcp_registration");
  assert.equal(r.status, "missing");
  assert.equal(r.fix, MCP_FIX);

  put(home, ".claude.json", JSON.stringify({ mcpServers: {} }));
  r = byId(await run(home), "mcp_registration");
  assert.equal(r.status, "missing");
  assert.equal(r.fix, MCP_FIX);

  put(home, ".claude.json", "{nope");
  r = byId(await run(home), "mcp_registration");
  assert.equal(r.status, "error");
  assert.ok(r.fix);

  put(home, ".claude.json", JSON.stringify({ mcpServers: { waycontext: { command: "waycontext-mcp" } } }));
  r = byId(await run(home), "mcp_registration");
  assert.equal(r.status, "ok");
  assert.equal(r.fix, null);
});

test("gate_script: missing then ok", async () => {
  const home = tmpHome();
  let r = byId(await run(home), "gate_script");
  assert.equal(r.status, "missing");
  assert.ok(r.fix);
  put(home, ".claude/hooks/waycontext_gate.py", "# gate\n");
  r = byId(await run(home), "gate_script");
  assert.equal(r.status, "ok");
  assert.equal(r.fix, null);
});

test("gate_hooks: missing, malformed, hook without the gate, ok", async () => {
  const home = tmpHome();
  let r = byId(await run(home), "gate_hooks");
  assert.equal(r.status, "missing");
  assert.ok(r.fix);

  put(home, ".claude/settings.json", "{nope");
  r = byId(await run(home), "gate_hooks");
  assert.equal(r.status, "error");
  assert.ok(r.fix);

  put(home, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "other.py" }] }] } }));
  r = byId(await run(home), "gate_hooks");
  assert.equal(r.status, "missing");

  put(home, ".claude/settings.json", JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "python3 ~/.claude/hooks/waycontext_gate.py" }] }] },
  }));
  r = byId(await run(home), "gate_hooks");
  assert.equal(r.status, "ok");
  assert.equal(r.fix, null);
});

test("config_file: absent, malformed, ok (WAYCONTEXT_CONFIG wins over home)", async () => {
  const home = tmpHome();
  let r = byId(await run(home), "config_file");
  assert.equal(r.status, "missing");
  assert.ok(r.fix);

  put(home, ".config/waycontext/config.json", "{nope");
  r = byId(await run(home), "config_file");
  assert.equal(r.status, "error");
  assert.ok(r.fix);

  put(home, ".config/waycontext/config.json", "{}");
  r = byId(await run(home), "config_file");
  assert.equal(r.status, "ok");
  assert.equal(r.fix, null);

  const custom = path.join(home, "custom.json");
  r = byId(await run(home, { env: { WAYCONTEXT_CONFIG: custom } }), "config_file");
  assert.equal(r.status, "missing");
});

test("service: running is ok, not running has a fix, a throw is an error", async () => {
  const home = tmpHome();
  let r = byId(await run(home, { service: up }), "service");
  assert.equal(r.status, "ok");
  assert.equal(r.fix, null);
  r = byId(await run(home), "service");
  assert.equal(r.status, "missing");
  assert.equal(r.fix, "waycontext service ensure");
  r = byId(await run(home, { service: async () => { throw new Error("boom"); } }), "service");
  assert.equal(r.status, "error");
});
