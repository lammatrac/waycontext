#!/usr/bin/env node
// CLI: node src/cli.js <command> [args...]
// Run `node src/cli.js help` for the full command list.
import { spawn } from "node:child_process";
import { initDb, listProjects, pool } from "./db.js";
import { indexProject } from "./indexer.js";
import {
  searchCode, getSymbol, getCallers, getCallees,
  getSubgraph, getFileOutline, getProjectOverview, findRelated,
} from "./graph.js";
import { config } from "./config.js";

const [, , cmd, ...args] = process.argv;

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function usageAndExit(msg) {
  console.error(msg);
  process.exit(1);
}

const HELP = `Commands:
  init-db
  index_project <project> <path>        (alias: index)
  list_projects
  stats                                  (alias for list_projects, table output)
  project_overview <project>
  search_code <project> <query> [limit]
  get_symbol <project> <name>
  get_callers <project> <name>
  get_callees <project> <name>
  get_graph <project> <name> [depth]
  get_file_outline <project> <path>
  find_related <project> <name> [limit]
  db                                     interactive psql session
  tables [table] [limit]                 list tables, or browse rows of one table (default limit 20)`;

async function main() {
  switch (cmd) {
    case "init-db": {
      await initDb();
      console.log("Schema created / verified.");
      break;
    }
    case "index":
    case "index_project": {
      const [project, dir] = args;
      if (!project || !dir) usageAndExit("Usage: index_project <project> <path>");
      await initDb();
      const t0 = Date.now();
      const stats = await indexProject(project, dir, (m) => console.log("·", m));
      console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, stats);
      break;
    }
    case "list_projects": {
      printJson(await listProjects());
      break;
    }
    case "stats": {
      console.table(await listProjects());
      break;
    }
    case "project_overview": {
      const [project] = args;
      if (!project) usageAndExit("Usage: project_overview <project>");
      printJson(await getProjectOverview(project));
      break;
    }
    case "search_code": {
      const [project, query, limit] = args;
      if (!project || !query) usageAndExit("Usage: search_code <project> <query> [limit]");
      printJson(await searchCode(project, query, limit ? Number(limit) : 10));
      break;
    }
    case "get_symbol": {
      const [project, name] = args;
      if (!project || !name) usageAndExit("Usage: get_symbol <project> <name>");
      printJson(await getSymbol(project, name));
      break;
    }
    case "get_callers": {
      const [project, name] = args;
      if (!project || !name) usageAndExit("Usage: get_callers <project> <name>");
      printJson(await getCallers(project, name));
      break;
    }
    case "get_callees": {
      const [project, name] = args;
      if (!project || !name) usageAndExit("Usage: get_callees <project> <name>");
      printJson(await getCallees(project, name));
      break;
    }
    case "get_graph": {
      const [project, name, depth] = args;
      if (!project || !name) usageAndExit("Usage: get_graph <project> <name> [depth]");
      printJson(await getSubgraph(project, name, depth ? Number(depth) : 2));
      break;
    }
    case "get_file_outline": {
      const [project, path] = args;
      if (!project || !path) usageAndExit("Usage: get_file_outline <project> <path>");
      printJson(await getFileOutline(project, path));
      break;
    }
    case "find_related": {
      const [project, name, limit] = args;
      if (!project || !name) usageAndExit("Usage: find_related <project> <name> [limit]");
      printJson(await findRelated(project, name, limit ? Number(limit) : 10));
      break;
    }
    case "db": {
      const child = spawn("psql", [config.databaseUrl], { stdio: "inherit" });
      child.on("error", (e) => {
        console.error(`Failed to launch psql: ${e.message}`);
        console.error("Install it with: sudo apt install -y postgresql-client");
        process.exit(1);
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }
    case "tables": {
      const [table, limit] = args;
      const known = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      );
      if (!table) {
        const res = await pool.query(`
          SELECT relname AS table, n_live_tup AS approx_rows
          FROM pg_stat_user_tables ORDER BY relname
        `);
        console.table(res.rows);
        break;
      }
      if (!known.rows.some((r) => r.tablename === table)) {
        usageAndExit(`Unknown table "${table}". Known tables: ${known.rows.map((r) => r.tablename).join(", ")}`);
      }
      const res = await pool.query(
        `SELECT * FROM "${table}" ORDER BY id DESC LIMIT $1`,
        [limit ? Number(limit) : 20]
      );
      console.table(res.rows);
      break;
    }
    case "help":
    case undefined: {
      console.log(HELP);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
