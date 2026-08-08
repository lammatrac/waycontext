#!/usr/bin/env node
import { ensureService } from "./serviceManager.js";

async function main() {
  try {
    const result = await ensureService();
    if (!process.env.npm_config_loglevel || process.env.npm_config_loglevel !== "silent") {
      console.log(`waycontext: local service ${result.status} at ${result.url}`);
    }
  } catch (e) {
    // Installation must stay successful even when a machine has no local DB yet.
    console.warn(`waycontext: service auto-start skipped (${e.message})`);
  }
}

main();
