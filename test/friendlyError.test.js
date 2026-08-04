import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { friendlyError, redactUrl, reportError, composeCommand } from "../src/friendlyError.js";

// These are the errors a first-time user actually hits, so each case asserts
// both that it's recognised and that the message names the remedy -- a friendly
// message that doesn't say what to do next is no better than the stack trace it
// replaced.

test("redactUrl hides the password but keeps host, port and database", () => {
  assert.equal(
    redactUrl("postgres://codectx:sup3r-s3cret@localhost:5432/codectx"),
    "postgres://codectx:***@localhost:5432/codectx",
  );
});

test("redactUrl leaves a passwordless URL alone", () => {
  assert.equal(redactUrl("postgres://localhost:5432/codectx"), "postgres://localhost:5432/codectx");
});

test("a refused connection explains how to start a database", () => {
  const e = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  const out = friendlyError(e);
  assert.match(out.message, /Can't reach the PostgreSQL database/);
  assert.match(out.hint, /docker compose/);
  // The URL it tried, and where that came from, are the whole point.
  assert.match(out.hint, /WayContext used postgres:\/\//);
  assert.match(out.hint, /\(from: /);
});

test("a refused connection never leaks the password", () => {
  const e = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.doesNotMatch(friendlyError(e).hint, /codectx:codectx@/);
});

test("the suggested compose command points at a file that exists", () => {
  // A bare `docker/docker-compose.yml` is only right from a clone's root. Told to
  // an `npm install -g` user -- the audience the message is for -- it names a file
  // that isn't in their working directory at all.
  const cmd = composeCommand();
  assert.ok(cmd, "the compose file should ship with the package");
  const file = cmd.match(/-f (\S+)/)[1];
  assert.ok(fs.existsSync(file), `suggested compose file should exist: ${file}`);
  assert.match(cmd, /^DB_PASS=/, "DB_PASS is required by the compose file");
});

test("both database messages name the same compose file", () => {
  const refused = friendlyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })).hint;
  const auth = friendlyError(Object.assign(new Error("x"), { code: "28P01" })).hint;
  const file = composeCommand().match(/-f (\S+)/)[1];
  assert.ok(refused.includes(file), "the start command should use the resolved path");
  assert.ok(auth.includes(file), "the down -v command should use the same path");
});

test("bad credentials mention the volume that keeps its original password", () => {
  const e = Object.assign(new Error('password authentication failed for user "codectx"'), { code: "28P01" });
  const out = friendlyError(e);
  assert.match(out.message, /rejected these credentials/);
  assert.match(out.hint, /down -v/);
});

test("a missing schema says to run migrate", () => {
  const e = Object.assign(new Error('relation "projects" does not exist'), { code: "42P01" });
  assert.match(friendlyError(e).hint, /waycontext migrate/);
});

test("a missing database says to create it and migrate", () => {
  const e = Object.assign(new Error('database "codectx" does not exist'), { code: "3D000" });
  assert.match(friendlyError(e).hint, /waycontext migrate/);
});

test("missing pgvector is distinguished from other undefined objects", () => {
  const vector = Object.assign(new Error('type "vector" does not exist'), { code: "42704" });
  assert.match(friendlyError(vector).message, /pgvector/);

  const other = Object.assign(new Error('function nope() does not exist'), { code: "42704" });
  assert.equal(friendlyError(other), null, "an unrelated 42704 should not be claimed");
});

test("a rejected embedding key points at the provider's env var", () => {
  const e = new Error('Voyage API 401: {"detail":"invalid key"}');
  const out = friendlyError(e);
  assert.match(out.message, /Voyage rejected the API key/);
  assert.match(out.hint, /VOYAGE_API_KEY/);
  assert.match(out.hint, /EMBEDDING_PROVIDER=none/);
});

test("an empty embedding key is explained as configuration, not as an API failure", () => {
  const e = new Error("EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is empty.");
  const out = friendlyError(e);
  assert.match(out.message, /VOYAGE_API_KEY is empty/);
  assert.match(out.hint, /EMBEDDING_PROVIDER=none/);
});

test("a domain error keeps its own message and gets no hint", () => {
  const e = new Error('Project "x" not found. Run index_project first.');
  const out = friendlyError(e);
  assert.equal(out.message, 'Project "x" not found. Run index_project first.');
  assert.equal(out.hint, undefined, "already actionable; a hint would be noise");
});

test("a programming bug is not dressed up as a user error", () => {
  // TypeError/ReferenceError mean WayContext is broken, and the frames are the
  // useful part -- returning null makes the caller print the raw error.
  assert.equal(friendlyError(new TypeError("x is not a function")), null);
  assert.equal(friendlyError(new ReferenceError("y is not defined")), null);
});

test("an unrecognised system error is passed through untouched", () => {
  assert.equal(friendlyError(Object.assign(new Error("boom"), { code: "EACCES" })), null);
});

test("reportError exits 1 and suppresses frames for a recognised error", () => {
  const lines = [];
  const code = reportError(
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    { log: (m) => lines.push(String(m)) },
  );
  assert.equal(code, 1);
  const text = lines.join("\n");
  assert.doesNotMatch(text, /\n\s+at /, "no stack frames");
  assert.match(text, /--debug/);
});

test("reportError prints the raw error under debug", () => {
  const lines = [];
  const e = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  reportError(e, { debug: true, log: (m) => lines.push(m) });
  assert.equal(lines[0], e, "debug hands the caller the error object itself");
});

test("reportError prints a domain message without offering --debug", () => {
  const lines = [];
  reportError(new Error('Project "x" not found. Run index_project first.'), {
    log: (m) => lines.push(String(m)),
  });
  assert.doesNotMatch(lines.join("\n"), /--debug/);
});
