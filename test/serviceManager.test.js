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
