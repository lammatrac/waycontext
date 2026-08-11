import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";

// End-to-end proof that a real indexProject run over JSON/CSS/SCSS/HTML/XML
// fixture files parses cleanly and lands the expected symbol kinds in the
// database -- the parser-unit tests in parser.test.js cover parseFile()
// directly, this covers the full path through runIndex's glob/hash/insert
// machinery.

const PROJECT = "new_languages_fixture";
let dir;

async function symbolsFor(rel) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT s.name, s.kind FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND f.path = $2
      ORDER BY s.start_line`,
    [project.id, rel]
  );
  return res.rows;
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-newlangs-"));

  fs.writeFileSync(path.join(dir, "config.json"), `{
  "name": "demo",
  "settings": { "debug": true, "port": 8080 }
}
`);

  fs.writeFileSync(path.join(dir, "styles.css"), `
.header { color: navy; }
@media screen { .footer { color: gray; } }
`);

  fs.writeFileSync(path.join(dir, "styles.scss"), `
.card { .title { color: navy; } }
@mixin button-variant { color: gray; }
`);

  fs.writeFileSync(path.join(dir, "page.html"), `
<div id="app">
  <span class="widget">hi</span>
  <p>no attrs, no symbol</p>
</div>
`);

  fs.writeFileSync(path.join(dir, "data.xml"), `
<catalog><book id="1"><title>Dune</title></book></catalog>
`);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("a full index run over the five new fixture types has zero failures", async () => {
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));
  assert.equal(stats.changed, 5);
});

test("json: nested keys land as kind 'key'", async () => {
  const rows = await symbolsFor("config.json");
  const names = rows.map((r) => r.name);
  assert.ok(names.includes("name"));
  assert.ok(names.includes("settings"));
  assert.ok(names.includes("debug"));
  assert.ok(names.includes("port"));
  assert.ok(rows.every((r) => r.kind === "key"));
});

test("css: rules and at-rules land as kind 'rule'", async () => {
  const rows = await symbolsFor("styles.css");
  const names = rows.map((r) => r.name);
  assert.ok(names.includes(".header"));
  assert.ok(names.includes("@media screen"));
  assert.ok(names.includes(".footer"));
  assert.ok(rows.every((r) => r.kind === "rule"));
});

test("scss: nested rules and SCSS-only at-rules land as kind 'rule'", async () => {
  const rows = await symbolsFor("styles.scss");
  const names = rows.map((r) => r.name);
  assert.ok(names.includes(".card"));
  assert.ok(names.includes(".title"));
  assert.ok(names.includes("@mixin button-variant"));
  assert.ok(rows.every((r) => r.kind === "rule"));
});

test("html: only elements with id/class land as kind 'element'", async () => {
  const rows = await symbolsFor("page.html");
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, ["div#app", "span.widget"]);
  assert.ok(rows.every((r) => r.kind === "element"));
});

test("xml: every element lands as kind 'element', unconditionally", async () => {
  const rows = await symbolsFor("data.xml");
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, ["catalog", "book", "title"]);
  assert.ok(rows.every((r) => r.kind === "element"));
});

test("no relation rows are produced for any of the five new languages", async () => {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM edges e
       JOIN files f ON f.id = e.file_id
      WHERE f.project_id = $1
        AND f.path IN ('config.json', 'styles.css', 'styles.scss', 'page.html', 'data.xml')`,
    [project.id]
  );
  assert.equal(res.rows[0].n, 0);
});
