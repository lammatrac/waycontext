import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { config, dotenvKeys } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(__dirname, "serviceDaemon.js");

const stateDir = path.join(os.homedir(), ".cache", "waycontext", "service");
const statePath = path.join(stateDir, "state.json");
const lockPath = path.join(stateDir, "ensure.lock");

export function serviceStateDir() {
  return stateDir;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUnlink(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function serviceHost() {
  return config.serviceHost || "127.0.0.1";
}

function servicePort() {
  return Number(config.servicePort) || 4747;
}

export function serviceBaseUrl() {
  return `http://${serviceHost()}:${servicePort()}`;
}

async function health(baseUrl) {
  try {
    const signal = AbortSignal.timeout(700);
    const res = await fetch(`${baseUrl}/health`, { signal });
    if (!res.ok) return { ok: false };
    const body = await res.json();
    return { ok: true, body };
  } catch {
    return { ok: false };
  }
}

async function withEnsureLock(fn) {
  fs.mkdirSync(stateDir, { recursive: true });
  const timeoutMs = 5000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return await fn();
      } finally {
        fs.closeSync(fd);
        safeUnlink(lockPath);
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const stat = fs.existsSync(lockPath) ? fs.statSync(lockPath) : null;
      if (stat && Date.now() - stat.mtimeMs > 10_000) {
        safeUnlink(lockPath);
        continue;
      }
      await wait(125);
    }
  }
  throw new Error("Timed out waiting for service startup lock");
}

function killManagedGroup(pid) {
  if (!processAlive(pid)) return false;
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

// The daemon must not inherit settings that dotenv folded into this process
// from whatever ./.env the caller happened to run in, nor that project's cwd.
export function daemonSpawnOptions(env = process.env, dotenv = dotenvKeys) {
  const clean = { ...env };
  for (const key of dotenv) delete clean[key];
  return {
    cwd: os.homedir(),
    env: {
      ...clean,
      WAYCONTEXT_SERVICE_HOST: serviceHost(),
      WAYCONTEXT_SERVICE_PORT: String(servicePort()),
      WAYCONTEXT_SERVICE_INJECTED: "WAYCONTEXT_SERVICE_HOST,WAYCONTEXT_SERVICE_PORT",
    },
  };
}

function spawnDaemon() {
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
    ...daemonSpawnOptions(),
  });
  child.unref();
  return child.pid;
}

async function waitForHealthy(url, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const h = await health(url);
    if (h.ok) return h.body;
    await wait(200);
  }
  return null;
}

export async function serviceStatus() {
  const url = serviceBaseUrl();
  const state = readState();
  const h = await health(url);
  return {
    url,
    running: h.ok,
    version: h.ok ? h.body.version : null,
    managed: Boolean(state?.pid),
    pid: state?.pid ?? null,
    alive: state?.pid ? processAlive(state.pid) : false,
  };
}

export async function stopService() {
  const state = readState();
  const pid = state?.pid;
  if (!pid) {
    safeUnlink(statePath);
    return { stopped: false, reason: "no managed service state" };
  }

  const signaled = killManagedGroup(pid);
  const started = Date.now();
  while (processAlive(pid) && Date.now() - started < 4000) {
    await wait(120);
  }

  safeUnlink(statePath);
  return {
    stopped: signaled,
    pid,
    terminated: !processAlive(pid),
  };
}

export async function ensureService({ expectedVersion = VERSION } = {}) {
  const url = serviceBaseUrl();

  const initial = await health(url);
  if (initial.ok && (!expectedVersion || initial.body.version === expectedVersion)) {
    return {
      status: "running",
      managed: Boolean(readState()?.pid),
      url,
      version: initial.body.version,
    };
  }

  return withEnsureLock(async () => {
    const current = await health(url);
    if (current.ok && (!expectedVersion || current.body.version === expectedVersion)) {
      return {
        status: "running",
        managed: Boolean(readState()?.pid),
        url,
        version: current.body.version,
      };
    }

    const state = readState();
    if (state?.pid) {
      killManagedGroup(state.pid);
      await wait(180);
    }

    const pid = spawnDaemon();
    const ready = await waitForHealthy(url);
    if (!ready) {
      safeUnlink(statePath);
      throw new Error(
        `Timed out waiting for WayContext service on ${url}; run \"waycontext serve\" for foreground diagnostics.`
      );
    }

    writeState({
      pid,
      url,
      host: serviceHost(),
      port: servicePort(),
      version: ready.version,
      started_at: new Date().toISOString(),
    });

    return {
      status: "started",
      managed: true,
      pid,
      url,
      version: ready.version,
    };
  });
}

export async function restartService() {
  await stopService();
  return ensureService({ expectedVersion: VERSION });
}
