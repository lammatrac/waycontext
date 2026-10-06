process.env.EMBEDDING_PROVIDER = "none";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { pool, initDb, getProject } = await import("../src/db.js");
const { indexProject } = await import("../src/indexer.js");
const { cleanupTestProject } = await import("./helpers/testProject.js");

// A bare method name like `save` is defined by many classes in any real PHP
// codebase. These cover resolving it by what the call is made on -- the
// caller's own class, its parents, or an explicitly named class -- and
// leaving it unresolved, rather than guessing, when the receiver is unknown
// and more than one class defines it.

const PROJECT = "method_resolution_fixture";
let dir;

/** Resolved targets of `Child::run`'s calls to `dstName`, in source order. */
async function callsFromRun(dstName) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT s.name AS resolved_to
       FROM edges e
       JOIN symbols src ON src.id = e.src
       LEFT JOIN symbols s ON s.id = e.dst
      WHERE e.project_id = $1 AND src.name = 'App\\M\\Child::run'
        AND e.relation = 'CALLS' AND e.dst_name = $2
      ORDER BY e.line`,
    [project.id, dstName]
  );
  return res.rows.map((r) => r.resolved_to);
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-methods-"));

  fs.writeFileSync(path.join(dir, "Base.php"), `<?php
namespace App\\M;
class Base {
  public function save() {}
  public function helper() {}
}
`);
  fs.writeFileSync(path.join(dir, "Child.php"), `<?php
namespace App\\M;
class Child extends Base {
  public function save() {}
  public function run($obj) {
    $this->save();
    self::save();
    parent::save();
    Other::save();
    $obj->save();
    $this->helper();
    $obj->only_here();
  }
}
`);
  fs.writeFileSync(path.join(dir, "Aaa_Other.php"), `<?php
namespace App\\M;
class Other {
  public function save() {}
  public function helper() {}
  public function only_here() {}
}
`);

  await indexProject(PROJECT, dir);
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("each call to an ambiguous method name resolves by its receiver", async () => {
  assert.deepEqual(await callsFromRun("save"), [
    "App\\M\\Child::save", // $this->save()  -- own class first
    "App\\M\\Child::save", // self::save()
    "App\\M\\Base::save",  // parent::save() -- skips own class
    "App\\M\\Other::save", // Other::save()  -- the named class
    null,                  // $obj->save()   -- unknown receiver, three candidates
  ]);
});

test("$this-> falls back to an inherited method when the class doesn't define it", async () => {
  assert.deepEqual(await callsFromRun("helper"), ["App\\M\\Base::helper"]);
});

test("an unknown receiver still resolves when only one class defines the method", async () => {
  assert.deepEqual(await callsFromRun("only_here"), ["App\\M\\Other::only_here"]);
});

test("files indexed before receivers were recorded get their edges rebuilt", async () => {
  const project = await getProject(PROJECT);
  // Simulate an index written by the previous version: no receiver, a
  // guessed link, and no edges_version stamp. The file itself is unchanged,
  // so only the version stamp can tell the indexer to re-derive its edges.
  await pool.query(
    `UPDATE edges e SET receiver = NULL,
            dst = (SELECT id FROM symbols WHERE project_id = $1 AND name = 'App\\M\\Other::save')
       FROM files f
      WHERE f.id = e.file_id AND f.project_id = $1 AND f.path = 'Child.php'
        AND e.dst_name = 'save'`,
    [project.id]
  );
  await pool.query(
    `UPDATE files SET edges_version = 0 WHERE project_id = $1 AND path = 'Child.php'`,
    [project.id]
  );

  await indexProject(PROJECT, dir);

  assert.deepEqual(await callsFromRun("save"), [
    "App\\M\\Child::save",
    "App\\M\\Child::save",
    "App\\M\\Base::save",
    "App\\M\\Other::save",
    null,
  ]);
});
