import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProfileYaml, assertEnvironmentAllowed, assertAuthMode } from "../src/browser/profileSchema.js";

const GOOD = `
profile_id: staging-admin
environment: staging
base_url: https://staging.example.test
allowed_origins:
  - https://staging.example.test
  - https://sso.example.test:8443
auth:
  mode: fresh_login
  save_state: true
login:
  url: https://staging.example.test/wp-login.php
  url_pattern: /wp-login.php
  username_selector: "#user_login"
  password_selector: "#user_pass"
  submit_selector: "#wp-submit"
  username_secret: STAGING_ADMIN_USER
  password_secret: STAGING_ADMIN_PASS
verify:
  url: https://staging.example.test/wp-admin/
  selector: "#wpadminbar"
  text: Dashboard
  identity_selector: "#wp-admin-bar-my-account .display-name"
`;

const rejects = (yaml, code, msg) =>
  assert.throws(() => parseProfileYaml(yaml), (e) => e.code === code && (!msg || msg.test(e.message)), yaml.slice(0, 80));

const variant = (mut) => {
  const o = JSON.parse(JSON.stringify(parseProfileYaml(GOOD)));
  mut(o);
  return JSON.stringify(o); // JSON is valid YAML
};

test("a complete fresh_login profile parses and normalizes origins", () => {
  const p = parseProfileYaml(GOOD);
  assert.equal(p.profile_id, "staging-admin");
  assert.equal(p.environment, "staging");
  assert.deepEqual(p.allowed_origins, ["https://staging.example.test", "https://sso.example.test:8443"]);
  assert.equal(p.auth.mode, "fresh_login");
  assert.equal(p.login.password_secret, "STAGING_ADMIN_PASS");
  assert.equal(p.verify.selector, "#wpadminbar");
});

test("production is rejected with environment_not_allowed (Q-002 A, AC-012)", () => {
  rejects(variant((o) => { o.environment = "production"; }), "environment_not_allowed");
  rejects(variant((o) => { o.environment = "prod"; }), "invalid_profile");
});

test("base_url, login.url and verify.url must each be on an allowed origin (AC-001)", () => {
  rejects(variant((o) => { o.verify.url = "https://evil.test/wp-admin/"; }), "invalid_profile", /verify\.url/);
  rejects(variant((o) => { o.login.url = "http://staging.example.test/login"; }), "invalid_profile", /login\.url/);
  rejects(variant((o) => { o.base_url = "https://staging.example.test:8443/"; }), "invalid_profile", /base_url/);
});

test("wildcard and path allowlist entries are rejected at import", () => {
  rejects(variant((o) => { o.allowed_origins.push("https://*.example.test"); }), "invalid_origin");
  rejects(variant((o) => { o.allowed_origins = []; }), "invalid_profile");
});

test("unknown keys are refused, so a secret value or state path cannot ride along (REQ-001)", () => {
  rejects(variant((o) => { o.login.password = "hunter2"; }), "invalid_profile");
  rejects(variant((o) => { o.state_path = "/home/x/state.json"; }), "invalid_profile");
});

test("the validation error never echoes a secret-looking value", () => {
  try {
    parseProfileYaml(variant((o) => { o.login.password = "hunter2-SECRET"; }));
    assert.fail("should reject");
  } catch (e) {
    assert.doesNotMatch(e.message, /hunter2/);
  }
});

test("secret names are env-var suffixes, not values or paths", () => {
  rejects(variant((o) => { o.login.password_secret = "lower case"; }), "invalid_profile");
  rejects(variant((o) => { o.login.password_secret = "WAYCONTEXT_BROWSER_SECRET_X"; }), "invalid_profile");
});

test("fresh_login requires a login block; saved_state does not", () => {
  rejects(variant((o) => { delete o.login; }), "invalid_profile", /login/);
  const p = parseProfileYaml(variant((o) => { o.auth.mode = "saved_state"; delete o.login; }));
  assert.equal(p.auth.mode, "saved_state");
  assert.equal(p.login, undefined);
});

test("verify needs a selector or text; identity_selector alone is not enough", () => {
  rejects(variant((o) => { delete o.verify.selector; delete o.verify.text; }), "invalid_profile", /verify/);
  assert.ok(parseProfileYaml(variant((o) => { delete o.verify.selector; })).verify.text);
});

test("unknown auth.mode, bad profile_id and non-YAML input are invalid_profile", () => {
  rejects(variant((o) => { o.auth.mode = "cdp_attach"; }), "invalid_profile");
  rejects(variant((o) => { o.profile_id = "Has Space"; }), "invalid_profile");
  rejects("::: not: [yaml", "invalid_profile");
  rejects("- a\n- b", "invalid_profile");
});

test("assertEnvironmentAllowed refuses anything but local/staging", () => {
  assertEnvironmentAllowed("local");
  assertEnvironmentAllowed("staging");
  assert.throws(() => assertEnvironmentAllowed("production"), (e) => e.code === "environment_not_allowed");
  assert.throws(() => assertEnvironmentAllowed(undefined), (e) => e.code === "environment_not_allowed");
});

test("assertAuthMode throws auth_mode_mismatch when the requested mode differs", () => {
  assertAuthMode({ auth_mode: "fresh_login" }, "fresh_login");
  assert.throws(() => assertAuthMode({ auth_mode: "saved_state" }, "fresh_login"), (e) => e.code === "auth_mode_mismatch");
});
