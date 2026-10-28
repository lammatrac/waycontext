import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { daemonSpawnOptions } from "../src/serviceManager.js";

test("dotenv keys are stripped from the daemon env", () => {
  const { env } = daemonSpawnOptions({ ORG_SLUG: "leak", PATH: "/bin" }, ["ORG_SLUG"]);
  assert.equal(env.ORG_SLUG, undefined);
  assert.equal(env.PATH, "/bin");
});

test("daemon cwd is the home directory", () => {
  assert.equal(daemonSpawnOptions({}, []).cwd, os.homedir());
});

test("injected marker lists the service host and port keys", () => {
  const { env } = daemonSpawnOptions({}, []);
  assert.equal(env.WAYCONTEXT_SERVICE_INJECTED, "WAYCONTEXT_SERVICE_HOST,WAYCONTEXT_SERVICE_PORT");
  assert.ok(env.WAYCONTEXT_SERVICE_HOST);
  assert.ok(env.WAYCONTEXT_SERVICE_PORT);
});

test("restart reports an unmanaged serve instead of calling ensure", async () => {
  const { restartService } = await import("../src/serviceManager.js");
  let ensured = 0;
  const result = await restartService({
    stop: async () => ({ stopped: false, reason: "no managed service state" }),
    probe: async () => ({ ok: true, body: { version: "9.9.9" } }),
    ensure: async () => { ensured++; return { status: "running" }; },
  });
  assert.equal(result.status, "unmanaged");
  assert.equal(ensured, 0);
});

test("restart with no service at all starts one", async () => {
  const { restartService } = await import("../src/serviceManager.js");
  const result = await restartService({
    stop: async () => ({ stopped: false, reason: "no managed service state" }),
    probe: async () => ({ ok: false }),
    ensure: async () => ({ status: "started", url: "http://127.0.0.1:1" }),
  });
  assert.equal(result.status, "started");
});

test("restart message: only a fresh start says restarted", async () => {
  const { restartOutcome } = await import("../src/serviceManager.js");
  const url = "http://127.0.0.1:4747";
  const started = restartOutcome({ status: "started", url });
  assert.equal(started.exitCode, 0);
  assert.match(started.message, /restarted/);

  const unmanaged = restartOutcome({ status: "unmanaged", url });
  assert.equal(unmanaged.exitCode, 1);
  assert.match(unmanaged.message, /unmanaged `waycontext serve`/);
  assert.match(unmanaged.message, /by hand/);
  assert.doesNotMatch(unmanaged.message, /restarted/);

  const running = restartOutcome({ status: "running", url });
  assert.equal(running.exitCode, 1);
  assert.doesNotMatch(running.message, /restarted at/);
});
