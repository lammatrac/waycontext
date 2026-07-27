#!/usr/bin/env node
// CLI: node src/cli.js <command> [args...]
// Run `node src/cli.js help` for the full command list.
import { spawn } from "node:child_process";
import { initDb, listProjects, getEmbeddingUsage, getProject, deleteProject, pool } from "./db.js";
import { indexProject } from "./indexer.js";
import {
  searchCode, getSymbol, getCallers, getCallees,
  getSubgraph, getFileOutline, getProjectOverview, findRelated,
} from "./graph.js";
import { config } from "./config.js";
import { upsertSection, extractExistingName } from "./claudeMdInit.js";
import { createInterface } from "node:readline/promises";
import fs from "node:fs";

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

  // Split out so callers with their own interleaved log lines (e.g.
  // index_project's per-file progress) can pause/resume the animation
  // around each print instead of only getting a stop() at the very end.
  function begin() {
    if (!tty || interval || delay) return;
    delay = setTimeout(() => {
      interval = setInterval(() => {
        const secs = ((Date.now() - start) / 1000).toFixed(1);
        frame = (frame + 1) % SPINNER_FRAMES.length;
        process.stderr.write(`\r${SPINNER_FRAMES[frame]} ${label}… ${secs}s`);
      }, 80);
    }, 150);
  }

  function pause() {
    if (delay) { clearTimeout(delay); delay = null; }
    if (interval) {
      clearInterval(interval);
      interval = null;
      process.stderr.write("\r\x1b[K");
    }
  }

  begin();

  function stop(ok = true) {
    pause();
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(`${ok ? "✔" : "✖"} ${label} (${secs}s)\n`);
  }
  stop.pause = pause;
  stop.resume = begin;

  return stop;
}

async function withSpinner(label, fn) {
  const stop = startSpinner(label);
  try {
    const result = await fn();
    stop(true);
    return result;
  } catch (e) {
    stop(false);
    throw e;
  }
}

const HELP = `Commands:
  init-db
  init                                    interactively write/update the CLAUDE.md Code Context MCP section
  index_project <project> <path>        (alias: index, reindex)
  list_projects
  delete_project <project> [--yes]      delete a project and all its indexed data
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
  tables [table] [limit]                 list tables, or browse rows of one table (default limit 20)
  usage [project]                        embedding token usage per provider/model, with est. cost if configured`;

function priceFor(provider) {
  if (provider === "voyage") return config.voyage.pricePerMTokens;
  if (provider === "openai") return config.openai.pricePerMTokens;
  return null;
}

async function main() {
  switch (cmd) {
    case "init-db": {
      await withSpinner("Ensuring schema", () => initDb());
      console.log("Schema created / verified.");
      break;
    }
    case "init": {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let name = "";
      try {
        while (!name) {
          const answer = await rl.question("Project name for code-context indexing: ");
          name = answer.trim();
          if (!name) console.log("Project name cannot be empty.");
        }

        const claudeMdPath = "CLAUDE.md";
        const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf8") : "";
        const currentName = extractExistingName(existing);

        if (currentName) {
          const answer = await rl.question(
            `Already configured for project "${currentName}". Replace with "${name}"? (y/N) `
          );
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log("Aborted — CLAUDE.md left unchanged.");
            break;
          }
        }

        const { content, mode } = upsertSection(existing, name);
        fs.writeFileSync(claudeMdPath, content);

        if (mode === "created") console.log(`Created CLAUDE.md — project "${name}" registered for code-context indexing.`);
        else if (mode === "appended") console.log(`Updated CLAUDE.md — project "${name}" registered for code-context indexing.`);
        else console.log(`Updated CLAUDE.md — project is now "${name}".`);
      } finally {
        rl.close();
      }
      break;
    }
    case "index":
    case "reindex":
    case "index_project": {
      // Its own step-by-step log() output only fires at a handful of
      // milestones (git diff, file count, edge resolution, embeddings) —
      // the file-by-file processing in between is otherwise silent, which
      // reads as "stuck" on a large project. Run the spinner throughout,
      // pausing it around each log line so the two don't fight.
      const [project, dir] = args;
      if (!project || !dir) usageAndExit("Usage: index_project <project> <path>");
      await initDb();
      const t0 = Date.now();
      const stop = startSpinner(`Indexing "${project}"`);
      const log = (m) => {
        stop.pause();
        console.log("·", m);
        stop.resume();
      };
      let stats;
      try {
        stats = await indexProject(project, dir, log);
      } catch (e) {
        stop(false);
        throw e;
      }
      stop(true);
      console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, stats);
      break;
    }
    case "list_projects": {
      printJson(await withSpinner("Listing projects", () => listProjects()));
      break;
    }
    case "delete_project": {
      const [project, ...rest] = args;
      if (!project) usageAndExit("Usage: delete_project <project> [--yes]");
      const skipConfirm = rest.includes("--yes");

      const existing = await getProject(project);
      if (!existing) {
        console.error(`Project "${project}" not found.`);
        process.exit(1);
      }

      if (!skipConfirm) {
        const counts = await pool.query(
          `SELECT
             (SELECT count(*) FROM files f WHERE f.project_id = $1)   AS file_count,
             (SELECT count(*) FROM symbols s WHERE s.project_id = $1) AS symbol_count,
             (SELECT count(*) FROM edges e WHERE e.project_id = $1)   AS edge_count`,
          [existing.id]
        );
        const { file_count, symbol_count, edge_count } = counts.rows[0];
        console.log(`Project "${project}": ${file_count} files, ${symbol_count} symbols, ${edge_count} edges.`);

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let answer;
        try {
          answer = await rl.question("Delete this project and all its indexed data? (y/N) ");
        } finally {
          rl.close();
        }
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log("Aborted — no changes made.");
          break;
        }
      }

      await deleteProject(project);
      console.log(`Deleted project "${project}".`);
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
    case "usage": {
      const [project] = args;
      const rows = await withSpinner("Aggregating embedding usage", () => getEmbeddingUsage(project));
      if (!rows.length) {
        console.log(project ? `No embedding usage recorded for "${project}" yet.` : "No embedding usage recorded yet.");
        break;
      }
      let missingPrice = false;
      const report = rows.map((r) => {
        const price = priceFor(r.provider);
        if (price == null) missingPrice = true;
        return {
          provider: r.provider,
          model: r.model,
          input_type: r.input_type,
          requests: Number(r.requests),
          tokens: Number(r.tokens),
          est_cost_usd: price != null ? +((Number(r.tokens) / 1_000_000) * price).toFixed(4) : null,
        };
      });
      console.table(report);
      if (missingPrice) {
        console.log(
          "Set VOYAGE_PRICE_PER_1M_TOKENS / OPENAI_PRICE_PER_1M_TOKENS in .env to see estimated cost (check the provider's current pricing page — rates change)."
        );
      }
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
