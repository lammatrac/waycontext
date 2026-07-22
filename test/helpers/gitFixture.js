import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function createGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitdiff-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

export function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

export function writeRepoFile(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

export function cleanupGitRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
