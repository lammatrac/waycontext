/**
 * Pieces of `waycontext uninstall` that touch state outside ~/.claude, kept
 * here so the parts that can be checked without a real crontab are.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cacheDir } from "./projectCache.js";

// Must match CRON_MARKER in check-update.sh, which writes the entry.
export const UPDATE_CRON_MARKER = "# waycontext-update-check";

// Files check-update.sh keeps next to projects.json.
const UPDATE_CHECK_FILES = ["status", "last-notified-date", "update-check.log"];

/** Drop the update-check line from a crontab, leaving every other entry as-is. */
export function stripUpdateCron(text) {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !line.includes(UPDATE_CRON_MARKER));
  if (kept.length === lines.length) return { content: text, removed: false };
  const content = kept.filter((line) => line !== "").join("\n");
  return { content: content ? content + "\n" : "", removed: true };
}

/**
 * Remove the cron entry `check-update.sh --install` added. No crontab binary,
 * or no crontab for this user, means there is nothing to remove.
 */
export function removeUpdateCron() {
  const list = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (list.error || list.status !== 0) return false;
  const { content, removed } = stripUpdateCron(list.stdout);
  if (!removed) return false;
  const write = spawnSync("crontab", ["-"], { input: content, encoding: "utf8" });
  if (write.error || write.status !== 0) {
    throw new Error(`crontab rejected the update: ${(write.stderr || write.error?.message || "").trim()}`);
  }
  return true;
}

/** Delete check-update.sh's status/log files; returns the paths removed. */
export function removeUpdateCheckFiles(dir = cacheDir()) {
  const removed = [];
  for (const name of UPDATE_CHECK_FILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return removed;
}

/** Remove a directory if it is empty; never touches one with content. */
export function removeIfEmpty(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      return true;
    }
  } catch {
    // Missing or unreadable: nothing to do.
  }
  return false;
}
