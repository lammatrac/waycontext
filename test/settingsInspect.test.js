import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectSettings, scanProjectOverrides, currentConfigPath } from "../src/settingsInspect.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wc-inspect-"));
}
function write(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}
const row = (report, key) => report.settings.find((s) => s.key === key);
const noInstall = () => path.join(tmp(), "missing.env");

test("config.json value wins over default", () => {
  const configPath = write(tmp(), "config.json", JSON.stringify({ ORG_SLUG: "acme" }));
  const r = row(inspectSettings({ env: {}, configPath, installDotenv: noInstall() }), "ORG_SLUG");
  assert.equal(r.value, "acme");
  assert.equal(r.source, configPath);
  assert.equal(r.shadowedBy, null);
});

test("env shadows file", () => {
  const configPath = write(tmp(), "config.json", JSON.stringify({ ORG_SLUG: "acme" }));
  const r = row(inspectSettings({ env: { ORG_SLUG: "x" }, configPath, installDotenv: noInstall() }), "ORG_SLUG");
  assert.equal(r.value, "x");
  assert.equal(r.source, "environment");
  assert.equal(r.fileValue, "acme");
  assert.equal(r.shadowedBy, "environment");
});

test("install .env shadows file", () => {
  const d = tmp();
  const configPath = write(d, "config.json", JSON.stringify({ ORG_SLUG: "acme" }));
  const installDotenv = write(d, ".env", "ORG_SLUG=y\n");
  const r = row(inspectSettings({ env: {}, configPath, installDotenv }), "ORG_SLUG");
  assert.equal(r.value, "y");
  assert.equal(r.shadowedBy, installDotenv);
  assert.equal(r.source, installDotenv);
});

test("env wins over install .env", () => {
  const d = tmp();
  const installDotenv = write(d, ".env", "ORG_SLUG=y\n");
  const r = row(inspectSettings({ env: { ORG_SLUG: "x" }, configPath: path.join(d, "none.json"), installDotenv }), "ORG_SLUG");
  assert.equal(r.value, "x");
  assert.equal(r.source, "environment");
});

test("injected keys are ignored", () => {
  const configPath = write(tmp(), "config.json", JSON.stringify({ WAYCONTEXT_SERVICE_PORT: 5000 }));
  const env = {
    WAYCONTEXT_SERVICE_PORT: "4747",
    WAYCONTEXT_SERVICE_INJECTED: "WAYCONTEXT_SERVICE_HOST,WAYCONTEXT_SERVICE_PORT",
  };
  const r = row(inspectSettings({ env, configPath, installDotenv: noInstall() }), "WAYCONTEXT_SERVICE_PORT");
  assert.equal(r.value, "5000");
  assert.equal(r.shadowedBy, null);
});

test("secrets carry no value", () => {
  const configPath = path.join(tmp(), "none.json");
  const report = inspectSettings({ env: { VOYAGE_API_KEY: "sk-test-123" }, configPath, installDotenv: noInstall() });
  const r = row(report, "VOYAGE_API_KEY");
  assert.equal(r.value, null);
  assert.equal(r.fileValue, null);
  assert.equal(r.default, null);
  assert.equal(r.isSet, true);
  assert.ok(!JSON.stringify(report).includes("sk-test-123"));
});

test("browser secrets appear as synthetic rows without values", () => {
  const configPath = path.join(tmp(), "none.json");
  const report = inspectSettings({ env: { WAYCONTEXT_BROWSER_SECRET_BANK: "hunter2" }, configPath, installDotenv: noInstall() });
  const r = row(report, "WAYCONTEXT_BROWSER_SECRET_BANK");
  assert.equal(r.group, "Browser");
  assert.equal(r.secret, true);
  assert.equal(r.isSet, true);
  assert.equal(r.value, null);
  assert.ok(!JSON.stringify(report).includes("hunter2"));
});

test("envOnly keys ignore file and .env", () => {
  const d = tmp();
  const configPath = write(d, "config.json", JSON.stringify({ WAYCONTEXT_CONFIG: "/nope" }));
  const installDotenv = write(d, ".env", "WAYCONTEXT_CONFIG=/nope2\n");
  const r = row(inspectSettings({ env: {}, configPath, installDotenv }), "WAYCONTEXT_CONFIG");
  assert.equal(r.fileValue, null);
  assert.equal(r.isSet, false);
  assert.equal(r.shadowedBy, null);
});

test("JSON booleans normalise like config", () => {
  const defs = inspectSettings({ env: {}, configPath: path.join(tmp(), "n.json"), installDotenv: noInstall() }).settings;
  const boolKey = defs.find((s) => s.type === "boolean" && !s.secret && !s.envOnly).key;
  const configPath = write(tmp(), "config.json", JSON.stringify({ [boolKey]: false }));
  const r = row(inspectSettings({ env: {}, configPath, installDotenv: noInstall() }), boolKey);
  assert.equal(r.value, "0");
});

test("honours WAYCONTEXT_CONFIG", () => {
  assert.equal(currentConfigPath({ WAYCONTEXT_CONFIG: "/tmp/x.json" }), "/tmp/x.json");
});

test("malformed config.json", () => {
  const configPath = write(tmp(), "config.json", "{nope");
  const report = inspectSettings({ env: { ORG_SLUG: "x" }, configPath, installDotenv: noInstall() });
  assert.ok(report.configError);
  assert.equal(row(report, "ORG_SLUG").value, "x");
  assert.equal(row(report, "ORG_SLUG").fileValue, null);
});

test("project scan lists overriding keys only", () => {
  const root = tmp();
  write(root, ".env", "ORG_SLUG=a\nDATABASE_URL=b\nAPP_KEY=c\n");
  assert.deepEqual(scanProjectOverrides([{ name: "p", root_path: root }]), [
    { project: "p", envFile: path.join(root, ".env"), keys: ["ORG_SLUG"] },
  ]);
});

test("WAYCONTEXT_IGNORE_DOTENV=1 skips the install .env", () => {
  const d = tmp();
  const configPath = write(d, "config.json", JSON.stringify({ ORG_SLUG: "acme" }));
  const installDotenv = write(d, ".env", "ORG_SLUG=y\n");
  const r = row(inspectSettings({ env: { WAYCONTEXT_IGNORE_DOTENV: "1" }, configPath, installDotenv }), "ORG_SLUG");
  assert.equal(r.value, "acme");
  assert.equal(r.source, configPath);
  assert.equal(r.shadowedBy, null);
});

test("project scan skips missing roots", () => {
  const root = path.join(tmp(), "gone");
  assert.deepEqual(scanProjectOverrides([{ name: "p", root_path: root }]), []);
});
