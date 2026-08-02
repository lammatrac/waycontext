import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";

// PHP symbols are stored under their namespaced name, but call sites almost
// never repeat the namespace. These cover the resolution passes that bridge
// that gap -- without them, recording namespaces would strand most PHP edges.

const PROJECT = "namespace_resolution_fixture";
let dir;

async function edgesFor(dstName) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT e.dst_name, e.relation, s.name AS resolved_to
       FROM edges e LEFT JOIN symbols s ON s.id = e.dst
      WHERE e.project_id = $1 AND e.dst_name = $2`,
    [project.id, dstName]
  );
  return res.rows;
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ns-"));

  fs.writeFileSync(path.join(dir, "Invoice.php"), `<?php
namespace App\\Domain;

class Invoice {
  public function total() { return 0; }
}
`);

  fs.writeFileSync(path.join(dir, "Service.php"), `<?php
namespace App\\Services;

use App\\Domain\\Invoice;

class Billing {
  public function charge() {
    $invoice = new Invoice();
    $other = new \\App\\Domain\\Invoice();
    return $invoice->total();
  }
}
`);

  // Two same-named classes in different namespaces: the suffix pass must
  // refuse to guess between them.
  fs.writeFileSync(path.join(dir, "AmbiguousA.php"), `<?php
namespace App\\Alpha;
class Duplicated {}
`);
  fs.writeFileSync(path.join(dir, "AmbiguousB.php"), `<?php
namespace App\\Beta;
class Duplicated {}
`);
  fs.writeFileSync(path.join(dir, "UsesAmbiguous.php"), `<?php
namespace App\\Consumer;
class Consumer {
  public function make() { return new Duplicated(); }
}
`);

  await indexProject(PROJECT, dir);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("symbols are stored under their fully-qualified namespaced name", async () => {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT name FROM symbols WHERE project_id = $1 ORDER BY name`, [project.id]
  );
  const names = res.rows.map((r) => r.name);
  assert.ok(names.includes("App\\Domain\\Invoice"), names.join(", "));
  assert.ok(names.includes("App\\Domain\\Invoice::total"));
  assert.ok(names.includes("App\\Services\\Billing"));
});

test("an unqualified reference resolves to the namespaced symbol", async () => {
  const rows = await edgesFor("Invoice");
  assert.ok(rows.length > 0, "expected an INSTANTIATES edge for `new Invoice()`");
  assert.ok(
    rows.some((r) => r.resolved_to === "App\\Domain\\Invoice"),
    `unresolved: ${JSON.stringify(rows)}`
  );
});

test("a fully-qualified reference with a leading backslash resolves too", async () => {
  const rows = await edgesFor("\\App\\Domain\\Invoice");
  assert.ok(rows.length > 0, "expected an edge for `new \\App\\Domain\\Invoice()`");
  assert.ok(
    rows.some((r) => r.resolved_to === "App\\Domain\\Invoice"),
    `unresolved: ${JSON.stringify(rows)}`
  );
});

test("a method call still resolves through the namespaced class", async () => {
  const rows = await edgesFor("total");
  assert.ok(
    rows.some((r) => r.resolved_to === "App\\Domain\\Invoice::total"),
    `unresolved: ${JSON.stringify(rows)}`
  );
});

test("an ambiguous short name is left unresolved rather than guessed", async () => {
  const rows = await edgesFor("Duplicated");
  assert.ok(rows.length > 0, "expected an edge referencing the duplicated name");
  assert.ok(
    rows.every((r) => r.resolved_to === null),
    `two classes share this name, so linking either would be a guess: ${JSON.stringify(rows)}`
  );
});

test("reindexing is stable: resolution does not change on a second run", async () => {
  const project = await getProject(PROJECT);
  const before = await pool.query(
    `SELECT count(*)::int AS n FROM edges WHERE project_id = $1 AND dst IS NOT NULL`,
    [project.id]
  );
  await indexProject(PROJECT, dir);
  const after = await pool.query(
    `SELECT count(*)::int AS n FROM edges WHERE project_id = $1 AND dst IS NOT NULL`,
    [project.id]
  );
  assert.equal(after.rows[0].n, before.rows[0].n);
});
