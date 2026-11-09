import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  compareVersions, detectInstall, checkForUpdate, updatePlan, describeCheck,
} from "../src/selfUpdate.js";

/**
 * A fake command runner: `responses` maps "cmd arg1 arg2" to a result. Any
 * command not listed fails, so a test only passes on the calls it expects.
 */
function fakeRun(responses) {
  const calls = [];
  const run = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    const r = responses[key];
    if (r === undefined) return { status: 1, stdout: "", stderr: `unexpected: ${key}` };
    return { status: 0, stdout: "", stderr: "", ...(typeof r === "string" ? { stdout: r } : r) };
  };
  run.calls = calls;
  return run;
}

const ROOT = "/opt/wc-clone";
const git = (...a) => ["git", "-C", ROOT, ...a].join(" ");

test("compareVersions orders dotted versions numerically, not lexically", () => {
  assert.equal(compareVersions("0.9.0", "0.8.0"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.9.0", "0.9.0"), 0);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.9.0", "0.9.1"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("detectInstall: a clone is git only when the package root is the work tree's top", () => {
  const run = fakeRun({ [git("rev-parse", "--show-toplevel")]: ROOT });
  assert.equal(detectInstall({ root: ROOT, run }).kind, "git");
});

test("detectInstall: a copy nested inside some other repo is not treated as a clone", () => {
  // e.g. node_modules/waycontext inside an app repo: pulling the app is wrong.
  const root = "/work/app/node_modules/waycontext";
  const run = fakeRun({
    [["git", "-C", root, "rev-parse", "--show-toplevel"].join(" ")]: "/work/app",
    "npm root -g": "/usr/lib/node_modules",
  });
  assert.equal(detectInstall({ root, run }).kind, "unknown");
});

test("detectInstall: a copy under npm's global root is an npm install", () => {
  const root = "/opt/homebrew/lib/node_modules/waycontext";
  const run = fakeRun({ "npm root -g": "/opt/homebrew/lib/node_modules" });
  assert.equal(detectInstall({ root, run }).kind, "npm");
});

test("checkForUpdate (git): reports commits behind and the upstream version", () => {
  const run = fakeRun({
    [git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")]: "origin/main",
    [git("fetch", "--quiet")]: "",
    [git("rev-list", "--count", "HEAD..@{u}")]: "2",
    [git("show", "@{u}:package.json")]: JSON.stringify({ version: "0.9.1" }),
    [git("status", "--porcelain")]: "",
    [git("log", "--oneline", "HEAD..@{u}")]: "abc1234 fix: one\ndef5678 feat: two",
  });
  const c = checkForUpdate({ kind: "git", root: ROOT }, { run, current: "0.9.0" });
  assert.equal(c.available, true);
  assert.equal(c.behind, 2);
  assert.equal(c.latest, "0.9.1");
  assert.equal(c.dirty, false);
  assert.deepEqual(c.commits, ["abc1234 fix: one", "def5678 feat: two"]);
});

test("checkForUpdate (git): up to date when nothing is behind", () => {
  const run = fakeRun({
    [git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")]: "origin/main",
    [git("fetch", "--quiet")]: "",
    [git("rev-list", "--count", "HEAD..@{u}")]: "0",
    [git("show", "@{u}:package.json")]: JSON.stringify({ version: "0.9.0" }),
    [git("status", "--porcelain")]: " M src/cli.js",
  });
  const c = checkForUpdate({ kind: "git", root: ROOT }, { run, current: "0.9.0" });
  assert.equal(c.available, false);
  assert.equal(c.dirty, true);
  assert.equal(c.error, undefined);
});

test("checkForUpdate (git): no upstream and a failed fetch are errors, not 'up to date'", () => {
  const noUpstream = checkForUpdate({ kind: "git", root: ROOT }, { run: fakeRun({}), current: "0.9.0" });
  assert.match(noUpstream.error, /upstream/);

  const offline = checkForUpdate({ kind: "git", root: ROOT }, {
    run: fakeRun({
      [git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")]: "origin/main",
      [git("fetch", "--quiet")]: { status: 128, stderr: "Could not resolve host: github.com" },
    }),
    current: "0.9.0",
  });
  assert.match(offline.error, /Could not resolve host/);
});

test("checkForUpdate (npm): compares the registry's latest with the running version", () => {
  const run = fakeRun({ "npm view waycontext version": "0.9.0" });
  const older = checkForUpdate({ kind: "npm", root: "/x" }, { run, current: "0.8.0" });
  assert.equal(older.available, true);
  assert.equal(older.latest, "0.9.0");
  const same = checkForUpdate({ kind: "npm", root: "/x" }, { run, current: "0.9.0" });
  assert.equal(same.available, false);
  const newer = checkForUpdate({ kind: "npm", root: "/x" }, { run, current: "0.10.0" });
  assert.equal(newer.available, false);
});

test("checkForUpdate (npm): a registry failure is an error", () => {
  const run = fakeRun({ "npm view waycontext version": { status: 1, stderr: "ENOTFOUND registry.npmjs.org" } });
  const c = checkForUpdate({ kind: "npm", root: "/x" }, { run, current: "0.8.0" });
  assert.match(c.error, /ENOTFOUND/);
});

test("checkForUpdate (unknown): explains it cannot update this copy", () => {
  const c = checkForUpdate({ kind: "unknown", root: "/work/app/node_modules/waycontext" }, { run: fakeRun({}) });
  assert.match(c.error, /neither a git clone nor a global npm install/);
});

test("updatePlan (git): runs update.sh, but refuses a dirty tree up front", () => {
  const clean = updatePlan({ kind: "git", root: ROOT, available: true, dirty: false }, { platform: "darwin" });
  assert.deepEqual(clean.steps.map((s) => [s.cmd, ...s.args]), [["bash", path.join(ROOT, "update.sh")]]);
  assert.equal(clean.steps[0].cwd, ROOT);

  const dirty = updatePlan({ kind: "git", root: ROOT, available: true, dirty: true }, { platform: "linux" });
  assert.match(dirty.blocked, /uncommitted changes/);
});

test("updatePlan (git): Windows has no bash to run update.sh with", () => {
  const p = updatePlan({ kind: "git", root: ROOT, available: true, dirty: false }, { platform: "win32" });
  assert.match(p.blocked, /update\.sh/);
});

test("updatePlan (npm): installs the exact latest version, then migrates with the new code", () => {
  const root = "/opt/homebrew/lib/node_modules/waycontext";
  const p = updatePlan(
    { kind: "npm", root, available: true, latest: "0.9.0" },
    { platform: "darwin", npmWritable: true, nodePath: "/usr/bin/node" },
  );
  assert.deepEqual(p.steps.map((s) => [s.cmd, ...s.args]), [
    ["npm", "install", "-g", "waycontext@0.9.0"],
    ["/usr/bin/node", path.join(root, "src", "cli.js"), "migrate"],
  ]);
  assert.equal(p.steps[0].optional, undefined);
  assert.equal(p.steps[1].optional, true); // no database is not a failed update
});

test("updatePlan (npm): an unwritable global prefix gets the sudo command, not a failed run", () => {
  // apt's Node on Ubuntu installs globals under root-owned /usr/lib/node_modules.
  const p = updatePlan(
    { kind: "npm", root: "/usr/lib/node_modules/waycontext", available: true, latest: "0.9.0" },
    { platform: "linux", npmWritable: false },
  );
  assert.match(p.blocked, /sudo npm install -g waycontext@0\.9\.0/);
});

test("updatePlan: nothing to do when no update is available", () => {
  const p = updatePlan({ kind: "npm", root: "/x", available: false, latest: "0.9.0" }, { platform: "linux", npmWritable: true });
  assert.deepEqual(p.steps, []);
});

test("describeCheck: names the versions, the install type and the commits", () => {
  const upToDate = describeCheck({ kind: "npm", root: "/x", current: "0.9.0", latest: "0.9.0", available: false });
  assert.match(upToDate.join("\n"), /waycontext 0\.9\.0 is up to date \(global npm install\)/);

  const npm = describeCheck({ kind: "npm", root: "/x", current: "0.8.0", latest: "0.9.0", available: true });
  assert.match(npm.join("\n"), /0\.8\.0 -> 0\.9\.0/);

  const gitSameVersion = describeCheck({
    kind: "git", root: ROOT, current: "0.9.0", latest: "0.9.0", available: true, behind: 1,
    upstream: "origin/main", commits: ["abc1234 fix: one"],
  });
  const text = gitSameVersion.join("\n");
  assert.match(text, /1 new commit\(s\) on origin\/main/);
  assert.match(text, /abc1234 fix: one/);
});
