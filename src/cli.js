#!/usr/bin/env node
// CLI: node src/cli.js <command> [args...]
// Run `node src/cli.js help` for the full command list.
import { spawn } from "node:child_process";
import { initDb, listProjects, getEmbeddingUsage, getProject, deleteProject, pool } from "./db.js";
import { migrationStatus } from "./migrate.js";
import { backfillProjectIdentity, identityBackfillStatus } from "./backfillIdentity.js";
import { listCandidates, setRuleState } from "./knowledge/rules.js";
import { exportKnowledge, importKnowledge } from "./knowledge/knowledgeFiles.js";
import { NAME, VERSION } from "./version.js";
import { operations, findOperation, parseCliArgs, usageLine } from "./operations.js";
import { config } from "./config.js";
import { upsertSection, extractExistingName, removeGlobalSection } from "./claudeMdInit.js";
import { upsertHook, removeHook } from "./hookInit.js";
import {
  writeProjectCache, cachePath, HOOK_MODES, DEFAULT_MODE,
} from "./projectCache.js";
import { createInterface } from "node:readline/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [, , cmd, ...args] = process.argv;

function printJson(data) {
  // An operation that already returned text -- compose_context with
  // format=markdown -- is printed as-is. JSON-encoding it would hand the user a
  // single escaped line with literal \n in it, which is unreadable and
  // un-pasteable, and the point of that format is pasting it somewhere.
  if (typeof data === "string") {
    console.log(data);
    return;
  }
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

// The operation lines are generated from src/operations.js, so a new
// capability shows up in `help` automatically and the usage strings can't
// drift from what the parser actually accepts.
function buildHelp() {
  const opLines = operations.map((op) => {
    const aliases = op.cli.aliases?.length ? `(alias: ${op.cli.aliases.join(", ")})` : "";
    return `  ${usageLine(op).padEnd(38)}${aliases}`.trimEnd();
  });
  return [
    "Commands:",
    "  init-db",
    "  migrate [--status]                    apply pending SQL migrations, or just report their state",
    "  backfill-identity [project] [--status] [--json]",
    "                                        give pre-existing symbols stable keys + entities (batched, resumable)",
    "  init                                  interactively write/update the CLAUDE.md Code Context MCP section",
    "  hook install [--global] [--mode M]    install the opt-in search hook (M: advise|ask|deny, default advise)",
    "  hook uninstall [--global]             remove the search hook",
    "  hook refresh                          rebuild the hook's project cache from the database",
    "  uninstall                             remove the hook, the global CLAUDE.md section and the project cache",
    "  rule candidates [project] [--json]    review extracted rule candidates (human-only, not an MCP tool)",
    "  rule confirm|reject <id> [project]    activate or permanently discard a candidate",
    "  knowledge-export [project]            write .waycontext/knowledge/*.yaml for team sharing",
    "  knowledge-import [project]            read them back (additive: never deactivates a rule)",
    "  serve [--port=4747] [--host=…]        HTTP API + web knowledge graph on localhost (no auth)",
    ...opLines,
    "  delete_project <project> [--yes]      delete a project and all its indexed data",
    "  stats                                 (alias for list_projects, table output)",
    "  db                                    interactive psql session",
    "  tables [table] [limit]                list tables, or browse rows of one table (default limit 20)",
    "  usage [project]                       embedding token usage per provider/model, with est. cost if configured",
    "  version                               print the installed version",
  ].join("\n");
}

const HELP = buildHelp();

/**
 * The project to act on when the argument was omitted.
 *
 * Only guesses when there is exactly one indexed project. With several, naming
 * one for the user would be a coin flip that silently confirms a rule in the
 * wrong place, so it lists them and stops instead.
 */
async function defaultProjectName() {
  const projects = await listProjects();
  if (projects.length === 1) return projects[0].name;
  if (!projects.length) usageAndExit("No indexed projects yet. Run `waycontext index <name> <path>` first.");
  usageAndExit(
    `Several projects are indexed — name one: ${projects.map((p) => p.name).join(", ")}`
  );
}

function priceFor(provider) {
  if (provider === "voyage") return config.voyage.pricePerMTokens;
  if (provider === "openai") return config.openai.pricePerMTokens;
  return null;
}

/**
 * Run one operation from src/operations.js.
 *
 * Argument names, defaults, validation ranges and the usage line all come
 * from the declaration -- this function knows nothing about any specific
 * command, so adding an operation needs no change here.
 */
async function runOperation(op) {
  let parsed;
  try {
    parsed = parseCliArgs(op, args);
  } catch (e) {
    const detail = e.issues
      ? e.issues.map((i) => `  ${i.path.join(".") || "(argument)"}: ${i.message}`).join("\n")
      : e.message;
    usageAndExit(`Usage: ${usageLine(op)}\n${detail}`);
  }

  if (op.cli.ensureSchema) await initDb();

  // A streaming operation prints its own milestones, so the spinner has to
  // step aside for each line rather than fight it for the same terminal row.
  if (op.cli.streams) {
    const t0 = Date.now();
    const stop = startSpinner(op.cli.label(parsed));
    const log = (m) => {
      stop.pause();
      console.log("·", m);
      stop.resume();
    };
    let result;
    try {
      result = await op.handler(parsed, { log });
    } catch (e) {
      stop(false);
      throw e;
    }
    stop(true);
    try {
      writeProjectCache({ projects: await listProjects() });
    } catch { /* the hook cache going stale must not fail an index */ }
    console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, result);
    return;
  }

  printJson(await withSpinner(op.cli.label(parsed), () => op.handler(parsed, { log: () => {} })));
}

async function main() {
  // Operations first: anything declared in src/operations.js is dispatched
  // generically. The switch below is only for commands that are genuinely
  // CLI-shaped -- interactive prompts, a psql shell, local config.
  const op = findOperation(cmd);
  if (op) {
    await runOperation(op);
    await pool.end();
    return;
  }

  switch (cmd) {
    case "init-db": {
      const result = await withSpinner("Ensuring schema", () => initDb());
      console.log(
        result.applied.length
          ? `Schema up to date. Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`
          : "Schema up to date. No pending migrations."
      );
      for (const w of result.warnings) console.warn(`Warning: ${w}`);
      break;
    }
    case "migrate": {
      if (args.includes("--status")) {
        const rows = await withSpinner("Reading migration ledger", () => migrationStatus());
        console.table(
          rows.map((r) => ({
            version: r.version,
            file: r.file,
            status: r.status,
            applied_at: r.applied_at ? r.applied_at.toISOString() : "",
            checksum: r.checksum_ok ? "ok" : "CHANGED",
          }))
        );
        break;
      }
      const result = await withSpinner("Applying migrations", () => initDb());
      console.log(
        result.applied.length
          ? `Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`
          : `No pending migrations (${result.skipped} already applied).`
      );
      for (const w of result.warnings) console.warn(`Warning: ${w}`);
      break;
    }
    case "rule": {
      // Deliberately NOT an entry in src/operations.js. Confirming a rule is a
      // human act: an agent that could promote its own extracted guesses into
      // injected rules is exactly the failure this phase is built to prevent.
      // Keeping it out of the registry makes it structurally absent from MCP
      // rather than filtered out of it.
      await initDb();
      const [sub, ...restArgs] = args.filter((a) => !a.startsWith("--"));

      if (sub === "candidates") {
        const [maybeProject] = restArgs;
        const rows = await listCandidates(maybeProject ?? (await defaultProjectName()));
        if (args.includes("--json")) printJson(rows);
        else if (!rows.length) console.log("No rule candidates pending review.");
        else console.table(rows.map((r) => ({
          id: r.id,
          confidence: r.confidence,
          scope: r.scope ?? "(project-wide)",
          origin: r.origin,
          statement: r.statement.length > 68 ? `${r.statement.slice(0, 65)}…` : r.statement,
        })));
        break;
      }

      if (sub === "confirm" || sub === "reject") {
        const [idOrKey, maybeProject] = restArgs;
        if (!idOrKey) usageAndExit("Usage: waycontext rule confirm|reject <id|key> [project]");
        const who = process.env.USER || process.env.USERNAME || "cli";
        printJson(await setRuleState(
          maybeProject ?? (await defaultProjectName()),
          idOrKey,
          sub === "confirm" ? "active" : "rejected",
          who
        ));
        break;
      }

      usageAndExit("Usage: waycontext rule candidates|confirm <id>|reject <id> [project]");
      break;
    }
    // Flat names rather than `knowledge export`: `knowledge` is already the CLI
    // alias of the search_knowledge operation, and operations are dispatched
    // before this switch -- so `knowledge export` would have run a *search* for
    // the word "export".
    case "knowledge-export":
    case "knowledge-import": {
      await initDb();
      const [maybeProject] = args.filter((a) => !a.startsWith("--"));
      const target = maybeProject ?? (await defaultProjectName());
      const sync = cmd === "knowledge-export" ? exportKnowledge : importKnowledge;
      printJson(await sync(target));
      break;
    }
    // Human-only, like the rule and knowledge commands: starting a server is not
    // something an agent should be able to ask for through a tool call.
    case "serve": {
      const { serve } = await import("./http.js");
      const flag = (name, fallback) => {
        const hit = args.find((a) => a.startsWith(`--${name}=`));
        return hit ? hit.slice(name.length + 3) : fallback;
      };
      const { url } = await serve({
        port: Number(flag("port", 4747)),
        host: flag("host", "127.0.0.1"),
      });
      console.log(`${url}  — web UI at ${url}/, operations at ${url}/v1/ops`);
      console.log("No authentication. Bound to localhost. Ctrl-C to stop.");
      return; // hold the process open; the server owns the event loop now
    }
    case "backfill-identity": {
      // Symbols indexed before migration 0006 have no symbol_key and no
      // entity, so nothing durable can be attached to them yet. They would
      // acquire one anyway the next time their file changes; this does it now
      // without waiting for that, and without reparsing a line.
      await initDb();
      const [maybeProject] = args.filter((a) => !a.startsWith("--"));

      if (args.includes("--status")) {
        const target = maybeProject ? await getProject(maybeProject) : null;
        if (maybeProject && !target) usageAndExit(`Project "${maybeProject}" not found.`);
        const rows = await identityBackfillStatus(target?.id ?? null);
        // --json so this is scriptable: a table is unparseable, and CI needs
        // to assert on the numbers, not eyeball them.
        if (args.includes("--json")) printJson(rows);
        else console.table(rows);
        break;
      }

      const targets = maybeProject
        ? [await getProject(maybeProject)].filter(Boolean)
        : await listProjects();
      if (!targets.length) usageAndExit(`Project "${maybeProject}" not found.`);

      for (const project of targets) {
        const stop = startSpinner(`Backfilling identity for "${project.name}"`);
        const log = (m) => { stop.pause(); console.log("·", m); stop.resume(); };
        let result;
        try {
          result = await backfillProjectIdentity(project, { log });
        } catch (e) {
          stop(false);
          throw e;
        }
        stop(true);
        console.log(
          result.files
            ? `${project.name}: keyed ${result.symbols} symbol(s) across ${result.files} file(s).`
            : `${project.name}: already up to date.`
        );
      }
      break;
    }
    case "init": {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let name = "";
      try {
        while (!name) {
          const answer = await rl.question("Project name for WayContext indexing: ");
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

        if (mode === "created") console.log(`Created CLAUDE.md — project "${name}" registered for WayContext indexing.`);
        else if (mode === "appended") console.log(`Updated CLAUDE.md — project "${name}" registered for WayContext indexing.`);
        else console.log(`Updated CLAUDE.md — project is now "${name}".`);
      } finally {
        rl.close();
      }
      break;
    }
    case "hook": {
      // The search hook is opt-in and project-scoped by default. It used to be
      // installed globally and unattended by install.sh, which degraded every
      // project on the machine -- including ones that have nothing to do with
      // WayContext -- and denied greps outright. Now you ask for it, per
      // project, and it only advises unless you choose otherwise.
      const [sub] = args;
      const global = args.includes("--global");
      const settingsPath = global
        ? path.join(os.homedir(), ".claude", "settings.json")
        : path.join(process.cwd(), ".claude", "settings.json");
      const scope = global ? "global" : "project";

      if (sub === "uninstall") {
        if (!fs.existsSync(settingsPath)) {
          console.log(`No ${settingsPath} — nothing to remove.`);
          break;
        }
        const { settings, mode } = removeHook(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
        if (mode === "absent") {
          console.log(`${settingsPath} has no WayContext search hook — nothing to remove.`);
        } else {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
          console.log(`Removed the WayContext search hook from ${settingsPath}.`);
        }
        break;
      }

      if (sub === "refresh") {
        // The cache is rewritten after every index, from whichever database
        // that run used. Pointing the CLI at a different DATABASE_URL (a
        // scratch container, say) therefore leaves it describing that
        // database until the next normal index. This puts it right without
        // needing to reindex anything.
        const cache = writeProjectCache({ projects: await listProjects() });
        console.log(`Refreshed ${cachePath()} — ${cache.projects.length} project(s), mode: ${cache.mode}.`);
        break;
      }

      if (sub !== "install") {
        usageAndExit(
          "Usage: hook install [--project|--global] [--mode advise|ask|deny]\n" +
          "       hook uninstall [--project|--global]\n" +
          "       hook refresh"
        );
      }

      const modeFlag = args.indexOf("--mode");
      const hookMode = modeFlag === -1 ? DEFAULT_MODE : args[modeFlag + 1];
      if (!HOOK_MODES.includes(hookMode)) {
        usageAndExit(`Unknown --mode "${hookMode}". Expected one of: ${HOOK_MODES.join(", ")}`);
      }

      // The hook reads project roots from the cache rather than the database,
      // so seed it now -- otherwise the hook silently no-ops until the next index.
      const projects = await listProjects();
      writeProjectCache({ mode: hookMode, projects });

      const hookScriptPath = path.join(__dirname, "..", "hooks", "codectx-primary-search.sh");
      const existingSettings = fs.existsSync(settingsPath)
        ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
        : {};
      const { settings, mode: result } = upsertHook(existingSettings, hookScriptPath);

      if (result === "unchanged") {
        console.log(`${settingsPath} already has the WayContext search hook (mode: ${hookMode}).`);
      } else {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        console.log(`Installed the WayContext search hook (${scope} scope, mode: ${hookMode}) in ${settingsPath}.`);
      }
      if (hookMode === "advise") {
        console.log("Mode 'advise': grep still runs; the agent is just told WayContext is available.");
      }
      break;
    }
    case "uninstall": {
      // Reverse everything WayContext put outside its own directory. Cheap to
      // provide, and a product that can't be cleanly removed doesn't get installed.
      const globalDir = path.join(os.homedir(), ".claude");
      for (const settingsPath of [
        path.join(process.cwd(), ".claude", "settings.json"),
        path.join(globalDir, "settings.json"),
      ]) {
        if (!fs.existsSync(settingsPath)) continue;
        const { settings, mode } = removeHook(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
        if (mode === "removed") {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
          console.log(`Removed the search hook from ${settingsPath}.`);
        }
      }

      const globalClaudeMd = path.join(globalDir, "CLAUDE.md");
      if (fs.existsSync(globalClaudeMd)) {
        const before = fs.readFileSync(globalClaudeMd, "utf8");
        const after = removeGlobalSection(before);
        if (after !== before) {
          fs.writeFileSync(globalClaudeMd, after);
          console.log(`Removed the Code Context MCP Workflow section from ${globalClaudeMd}.`);
        }
      }

      const cache = cachePath();
      if (fs.existsSync(cache)) {
        fs.rmSync(cache, { force: true });
        console.log(`Removed ${cache}.`);
      }

      console.log("\nStill installed (remove by hand if you want them gone):");
      console.log("  claude mcp remove --scope user waycontext");
      console.log("  npm unlink -g waycontext   # or: code-context-mcp, if installed before v0.2.0");
      console.log("  the codectx Postgres database (waycontext db, then DROP DATABASE)");
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
    case "version":
    case "--version":
    case "-v": {
      console.log(`${NAME} ${VERSION}`);
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
