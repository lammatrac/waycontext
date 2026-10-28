import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serviceStatus } from "./serviceManager.js";

const MCP_FIX = "claude mcp add --scope user waycontext -- waycontext-mcp";
const GATE_FIX = "waycontext gate install";
const GATE_NAME = "waycontext_gate.py";

/** Read and parse a JSON file: { exists, value } or { exists, error }. */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return e.code === "ENOENT" ? { exists: false } : { exists: true, error: e.message };
  }
  try {
    return { exists: true, value: JSON.parse(text) };
  } catch (e) {
    return { exists: true, error: e.message };
  }
}

function item(id, label, status, detail, fix = null) {
  return { id, label, status, detail, fix: status === "ok" ? null : fix };
}

/** True when any hook command under `hooks` mentions the gate script. */
function hasGateHook(hooks) {
  if (!hooks || typeof hooks !== "object") return false;
  return Object.values(hooks).some((groups) =>
    Array.isArray(groups) &&
    groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => String(h?.command ?? "").includes(GATE_NAME))));
}

/**
 * Health of the pieces WayContext is wired together with, read fresh from disk.
 * Every non-ok item carries a `fix` the dashboard can show verbatim. `env`,
 * `service` and `home` are injectable so tests never touch the real machine.
 *
 * @returns {Promise<Array<{id:string,label:string,status:"ok"|"missing"|"error",detail:string,fix:string|null}>>}
 */
export async function integrationStatus({
  home = os.homedir(),
  env = process.env,
  service = serviceStatus,
} = {}) {
  const items = [];

  const claudeJson = path.join(home, ".claude.json");
  const mcp = readJson(claudeJson);
  if (mcp.error) {
    items.push(item("mcp_registration", "MCP registration", "error", `${claudeJson} is unreadable: ${mcp.error}`, MCP_FIX));
  } else if (mcp.value?.mcpServers?.waycontext) {
    items.push(item("mcp_registration", "MCP registration", "ok", "Registered in ~/.claude.json"));
  } else {
    items.push(item("mcp_registration", "MCP registration", "missing", "No waycontext entry under mcpServers in ~/.claude.json", MCP_FIX));
  }

  const gateScript = path.join(home, ".claude", "hooks", GATE_NAME);
  items.push(
    fs.existsSync(gateScript)
      ? item("gate_script", "Gate script", "ok", gateScript)
      : item("gate_script", "Gate script", "missing", `${gateScript} not found`, GATE_FIX),
  );

  const settingsFile = path.join(home, ".claude", "settings.json");
  const settings = readJson(settingsFile);
  if (settings.error) {
    items.push(item("gate_hooks", "Gate hooks", "error", `${settingsFile} is unreadable: ${settings.error}`, GATE_FIX));
  } else if (hasGateHook(settings.value?.hooks)) {
    items.push(item("gate_hooks", "Gate hooks", "ok", "A hook runs the gate script"));
  } else {
    items.push(item("gate_hooks", "Gate hooks", "missing", `No hook in ~/.claude/settings.json runs ${GATE_NAME}`, GATE_FIX));
  }

  const configPath = env.WAYCONTEXT_CONFIG || path.join(home, ".config", "waycontext", "config.json");
  const cfg = readJson(configPath);
  if (cfg.error) {
    items.push(item("config_file", "Config file", "error", `${configPath} is not valid JSON: ${cfg.error}`, `Fix or remove ${configPath}`));
  } else if (!cfg.exists) {
    items.push(item("config_file", "Config file", "missing", `${configPath} does not exist yet; defaults apply`, "Save a setting in the dashboard to create it"));
  } else {
    items.push(item("config_file", "Config file", "ok", configPath));
  }

  try {
    const s = await service();
    items.push(
      s.running
        ? item("service", "Background service", "ok", `Running at ${s.url}${s.version ? ` (v${s.version})` : ""}`)
        : item("service", "Background service", "missing", `Not responding at ${s.url}`, "waycontext service ensure"),
    );
  } catch (e) {
    items.push(item("service", "Background service", "error", e.message, "waycontext service ensure"));
  }

  return items;
}
