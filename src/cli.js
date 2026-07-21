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

// Spinner + elapsed-time indicator for commands that hit the DB/network.
// Animates on stderr only (so stdout JSON stays pipeable), and only starts
// rendering after a short delay so near-instant queries don't flicker.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function startSpinner(label) {
  const start = Date.now();
  const tty = Boolean(process.stderr.isTTY);
  let frame = 0;
  let interval = null;
  let delay = null;

  if (tty) {
    delay = setTimeout(() => {
      interval = setInterval(() => {
        const secs = ((Date.now() - start) / 1000).toFixed(1);
        frame = (frame + 1) % SPINNER_FRAMES.length;
        process.stderr.write(`\r${SPINNER_FRAMES[frame]} ${label}… ${secs}s`);
      }, 80);
    }, 150);
  }

  return function stop() {
    if (delay) clearTimeout(delay);
    if (interval) {
      clearInterval(interval);
      process.stderr.write("\r\x1b[K");
    }
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(`✔ ${label} (${secs}s)\n`);
  };
}

async function withSpinner(label, fn) {
  const stop = startSpinner(label);
  try {
    return await fn();
  } finally {
    stop();
  }
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
      await withSpinner("Ensuring schema", () => initDb());
      console.log("Schema created / verified.");
      break;
    }
    case "index":
    case "index_project": {
      // Its own step-by-step log() output already doubles as progress
      // reporting, so no spinner here — one would just fight the other.
      const [project, dir] = args;
      if (!project || !dir) usageAndExit("Usage: index_project <project> <path>");
      await initDb();
      const t0 = Date.now();
      const stats = await indexProject(project, dir, (m) => console.log("·", m));
      console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, stats);
      break;
    }
    case "list_projects": {
      printJson(await withSpinner("Listing projects", () => listProjects()));
      break;
    }
    case "stats": {
      console.table(await withSpinner("Listing projects", () => listProjects()));
      break;
    }
    case "project_overview": {
      const [project] = args;
      if (!project) usageAndExit("Usage: project_overview <project>");
      printJson(await withSpinner(`Building overview for "${project}"`, () => getProjectOverview(project)));
      break;
    }
    case "search_code": {
      const [project, query, limit] = args;
      if (!project || !query) usageAndExit("Usage: search_code <project> <query> [limit]");
      printJson(await withSpinner(`Searching "${query}"`, () => searchCode(project, query, limit ? Number(limit) : 10)));
      break;
    }
    case "get_symbol": {
      const [project, name] = args;
      if (!project || !name) usageAndExit("Usage: get_symbol <project> <name>");
      printJson(await withSpinner(`Fetching "${name}"`, () => getSymbol(project, name)));
      break;
    }
    case "get_callers": {
      const [project, name] = args;
      if (!project || !name) usageAndExit("Usage: get_callers <project> <name>");
      printJson(await withSpinner(`Finding callers of "${name}"`, () => getCallers(project, name)));
      break;
    }
    case "get_callees": {
      const [project, name] = args;
      if (!project || !name) usageAndExit("Usage: get_callees <project> <name>");
      printJson(await withSpinner(`Finding callees of "${name}"`, () => getCallees(project, name)));
      break;
    }
    case "get_graph": {
      const [project, name, depth] = args;
      if (!project || !name) usageAndExit("Usage: get_graph <project> <name> [depth]");
      printJson(await withSpinner(`Building graph around "${name}"`, () => getSubgraph(project, name, depth ? Number(depth) : 2)));
      break;
    }
    case "get_file_outline": {
      const [project, path] = args;
      if (!project || !path) usageAndExit("Usage: get_file_outline <project> <path>");
      printJson(await withSpinner(`Outlining "${path}"`, () => getFileOutline(project, path)));
      break;
    }
    case "find_related": {
      const [project, name, limit] = args;
      if (!project || !name) usageAndExit("Usage: find_related <project> <name> [limit]");
      printJson(await withSpinner(`Finding symbols related to "${name}"`, () => findRelated(project, name, limit ? Number(limit) : 10)));
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
      if (!table) {
        const rows = await withSpinner("Listing tables", () => pool.query(`
          SELECT relname AS table, n_live_tup AS approx_rows
          FROM pg_stat_user_tables ORDER BY relname
        `).then((r) => r.rows));
        console.table(rows);
        break;
      }
      const known = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      );
      if (!known.rows.some((r) => r.tablename === table)) {
        usageAndExit(`Unknown table "${table}". Known tables: ${known.rows.map((r) => r.tablename).join(", ")}`);
      }
      const rows = await withSpinner(`Browsing "${table}"`, () => pool.query(
        `SELECT * FROM "${table}" ORDER BY id DESC LIMIT $1`,
        [limit ? Number(limit) : 20]
      ).then((r) => r.rows));
      console.table(rows);
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
