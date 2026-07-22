import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getChangedFiles, getHeadSha } from "../src/gitDiff.js";
import {
  createGitRepo, git, writeRepoFile, commitAll, cleanupGitRepo,
} from "./helpers/gitFixture.js";

const repos = [];
function repo() {
  const dir = createGitRepo();
  repos.push(dir);
  return dir;
}

after(() => {
  for (const dir of repos) cleanupGitRepo(dir);
});

test("getHeadSha returns the HEAD sha for a repo with a commit", () => {
  const dir = repo();
  writeRepoFile(dir, "a.js", "1");
  const sha = commitAll(dir, "first");
  return getHeadSha(dir).then((result) => assert.equal(result, sha));
});

test("getHeadSha returns null for a non-git directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
  repos.push(dir);
  return getHeadSha(dir).then((result) => assert.equal(result, null));
});

test("getChangedFiles returns null when lastSha is not provided (first-ever index)", async () => {
  const dir = repo();
  writeRepoFile(dir, "a.js", "1");
  commitAll(dir, "first");
  assert.equal(await getChangedFiles(dir, null), null);
});

test("getChangedFiles returns null for a non-git directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
  repos.push(dir);
  assert.equal(await getChangedFiles(dir, "deadbeef"), null);
});

test("getChangedFiles reports no changes on a clean no-op", async () => {
  const dir = repo();
  writeRepoFile(dir, "a.js", "1");
  const sha = commitAll(dir, "first");
  const result = await getChangedFiles(dir, sha);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.headSha, sha);
});

test("getChangedFiles reports an uncommitted modification to a tracked file", async () => {
  const dir = repo();
  writeRepoFile(dir, "a.js", "1");
  const sha = commitAll(dir, "first");
  writeRepoFile(dir, "a.js", "2"); // modified, NOT committed
  const result = await getChangedFiles(dir, sha);
  assert.deepEqual(result.changed, ["a.js"]);
  assert.deepEqual(result.deleted, []);
});

test("getChangedFiles reports a new untracked file", async () => {
  const dir = repo();
  writeRepoFile(dir, "a.js", "1");
  const sha = commitAll(dir, "first");
  writeRepoFile(dir, "b.js", "2"); // new, never git-added
  const result = await getChangedFiles(dir, sha);
  assert.deepEqual(result.changed, ["b.js"]);
});

test("getChangedFiles reports a deleted tracked file", async () => {
  const dir = repo();
  writeRepoFile(dir, "a.js", "1");
  writeRepoFile(dir, "b.js", "2");
  const sha = commitAll(dir, "first");
  fs.unlinkSync(path.join(dir, "b.js"));
  const result = await getChangedFiles(dir, sha);
  assert.deepEqual(result.deleted, ["b.js"]);
  assert.ok(!result.changed.includes("b.js"));
});

test("getChangedFiles reports a rename as delete-old + add-new, never a rename entry", async () => {
  const dir = repo();
  writeRepoFile(dir, "old.js", "content");
  const sha = commitAll(dir, "add old");
  git(dir, ["mv", "old.js", "new.js"]);
  commitAll(dir, "rename");
  const result = await getChangedFiles(dir, sha);
  assert.deepEqual(result.deleted, ["old.js"]);
  assert.deepEqual(result.changed, ["new.js"]);
});

test("getChangedFiles scopes paths to root when root is a subdirectory of the repo", async () => {
  const dir = repo();
  writeRepoFile(dir, "outside.js", "1");
  writeRepoFile(dir, "sub/project/inside.js", "1");
  const sha = commitAll(dir, "first");
  writeRepoFile(dir, "sub/project/inside.js", "2"); // modify the in-scope file
  writeRepoFile(dir, "outside.js", "2"); // modify the out-of-scope file
  const result = await getChangedFiles(path.join(dir, "sub", "project"), sha);
  assert.deepEqual(result.changed, ["inside.js"]);
});

test("getChangedFiles returns null when lastSha is no longer an ancestor of HEAD", async () => {
  const dir = repo();
  writeRepoFile(dir, "a.js", "1");
  commitAll(dir, "first");
  writeRepoFile(dir, "b.js", "1");
  const shaB = commitAll(dir, "second");
  // Rewrite "second" via amend -- shaB is now orphaned, not an ancestor of HEAD.
  writeRepoFile(dir, "b.js", "1-amended");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--amend", "-q", "-m", "second-amended"]);
  const result = await getChangedFiles(dir, shaB);
  assert.equal(result, null);
});
