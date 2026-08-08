#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(__dirname, "serviceWorker.js");

let child = null;
let stopping = false;
let restartDelayMs = 250;

function launchWorker() {
  child = spawn(process.execPath, [workerPath], {
    env: process.env,
    stdio: "ignore",
  });

  child.once("exit", () => {
    child = null;
    if (stopping) {
      process.exit(0);
      return;
    }
    setTimeout(launchWorker, restartDelayMs);
    restartDelayMs = Math.min(restartDelayMs * 2, 5000);
  });
}

function shutdown() {
  stopping = true;
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

launchWorker();

// Keep the daemon alive independently from the worker lifecycle.
setInterval(() => {}, 60_000);
