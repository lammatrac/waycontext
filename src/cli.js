#!/usr/bin/env node
// CLI: node src/cli.js init-db | index <name> <path> | stats
import { initDb, listProjects, pool } from "./db.js";
import { indexProject } from "./indexer.js";

const [, , cmd, ...args] = process.argv;

async function main() {
  switch (cmd) {
    case "init-db": {
      await initDb();
      console.log("Schema created / verified.");
      break;
    }
    case "index": {
      const [name, dir] = args;
      if (!name || !dir) {
        console.error("Usage: node src/cli.js index <project-name> <path>");
        process.exit(1);
      }
      await initDb();
      const t0 = Date.now();
      const stats = await indexProject(name, dir, (m) => console.log("·", m));
      console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, stats);
      break;
    }
    case "stats": {
      console.table(await listProjects());
      break;
    }
    default:
      console.log("Commands: init-db | index <name> <path> | stats");
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
