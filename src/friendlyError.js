import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, describeSource } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The `docker compose` command to suggest, with a path that actually exists.
 *
 * A bare `docker/docker-compose.yml` is only correct from a clone's root. Told to
 * an `npm install -g` user -- the audience this whole message exists for -- it
 * points at a file that isn't in their working directory at all, since the compose
 * file ships inside the package. Resolve it relative to this module and print
 * whichever spelling is shorter to read from where they are.
 */
export function composeCommand() {
  const abs = path.join(__dirname, "..", "docker", "docker-compose.yml");
  if (!fs.existsSync(abs)) return null;
  const rel = path.relative(process.cwd(), abs);
  const target = rel && !rel.startsWith("..") ? rel : abs;
  return `DB_PASS=your-password docker compose -f ${target} up -d`;
}

/**
 * Turn an expected failure into a one-line explanation plus a remedy.
 *
 * The CLI used to be `main().catch((e) => console.error(e))`, which printed a
 * `pg-pool` stack trace for the most common first-run situation there is: no
 * database yet. MCP (mcpServer.js) and HTTP (http.js) both already reduce errors
 * to a message; this is the CLI's equivalent, kept in its own module because
 * cli.js is the one file with no unit test.
 *
 * Returns null when the error isn't one we recognise -- the caller then prints
 * it raw, because guessing at an unknown failure is worse than showing it.
 */

/** Strip the password out of a connection string before showing it. */
export function redactUrl(url) {
  return String(url).replace(/^(\w+:\/\/[^:/@]+):[^@]*@/, "$1:***@");
}

function databaseHint() {
  const url = redactUrl(config.databaseUrl);
  return `WayContext used ${url} (from: ${describeSource("DATABASE_URL")}).`;
}

function providerKeyMissing(provider) {
  const envKey = provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY";
  return {
    message: `EMBEDDING_PROVIDER=${provider} is set, but ${envKey} is empty.`,
    hint: [
      `Set ${envKey}, or set EMBEDDING_PROVIDER=none to run without semantic`,
      "search (the graph tools and the full-text half of search_code still work).",
    ].join(" "),
  };
}

export function friendlyError(e) {
  const code = e?.code;
  const msg = String(e?.message ?? e);

  // Nothing is listening, or the host doesn't resolve. Overwhelmingly the
  // first-run case: the user has not started a database yet.
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ETIMEDOUT") {
    const compose = composeCommand();
    return {
      message: "Can't reach the PostgreSQL database.",
      hint: [
        databaseHint(),
        "",
        ...(compose
          ? [
            "Start one with:",
            `  ${compose}`,
            "",
            "or point DATABASE_URL at an existing PostgreSQL that has the pgvector extension.",
          ]
          : ["Point DATABASE_URL at a PostgreSQL that has the pgvector extension."]),
      ].join("\n"),
    };
  }

  // 28P01 = invalid_password, 28000 = invalid_authorization_specification.
  if (code === "28P01" || code === "28000") {
    const compose = composeCommand();
    // Reuse the resolved compose path from the start command rather than a second
    // literal, so both stay pointing at the file that actually exists.
    const composeFile = compose?.match(/-f (\S+)/)?.[1];
    return {
      message: "The database rejected these credentials.",
      hint: [
        databaseHint(),
        "",
        "If the database already existed, note that PostgreSQL only applies",
        "POSTGRES_PASSWORD when it first initialises its data directory -- an existing",
        "waycontext-pgdata volume keeps the password it was created with, and passing a",
        "new one to `docker compose up` changes nothing. Either use the original",
        "password, or discard the volume and start over (this deletes the index):",
        composeFile
          ? `  docker compose -f ${composeFile} down -v`
          : "  docker compose down -v",
      ].join("\n"),
    };
  }

  // 3D000 = invalid_catalog_name (no such database).
  if (code === "3D000") {
    return {
      message: "That database doesn't exist yet.",
      hint: `${databaseHint()}\n\nCreate it (the Docker compose file does this for you), then run: waycontext migrate`,
    };
  }

  // 42P01 = undefined_table. The schema was never created.
  if (code === "42P01") {
    return {
      message: "The database is reachable but has no WayContext schema.",
      hint: "Run: waycontext migrate",
    };
  }

  // 42704 = undefined_object, which is what CREATE EXTENSION vector raises when
  // pgvector isn't installed in the server.
  if (code === "42704" && /vector/i.test(msg)) {
    return {
      message: "This PostgreSQL doesn't have the pgvector extension available.",
      hint: [
        "Use the pgvector/pgvector:pg16 image (docker/docker-compose.yml does),",
        "or install the extension package for your server -- see docs/installation.md.",
      ].join("\n"),
    };
  }

  // An embedding provider refused the key. embeddings.js catches the empty-key
  // case up front, so reaching here means a key is set but not accepted.
  const providerAuth = msg.match(/^(Voyage|OpenAI) API (401|403)\b/);
  if (providerAuth) {
    const provider = providerAuth[1].toLowerCase() === "voyage" ? "voyage" : "openai";
    const envKey = provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY";
    return {
      message: `${providerAuth[1]} rejected the API key (HTTP ${providerAuth[2]}).`,
      hint: [
        `${envKey} came from: ${describeSource(envKey)}.`,
        "Check the key is current and has embeddings access, or set EMBEDDING_PROVIDER=none",
        "to index without semantic search.",
      ].join("\n"),
    };
  }

  // Thrown by embeddings.js before any request is made.
  const emptyKey = msg.match(/^EMBEDDING_PROVIDER=(voyage|openai) but /);
  if (emptyKey) return providerKeyMissing(emptyKey[1]);

  // A deliberate domain error -- `Project "x" not found. Run index_project
  // first.`, the resolveTarget family, and so on. These messages are already
  // written for a human; the only thing wrong with them was the stack trace
  // stapled underneath.
  //
  // Everything this codebase raises on purpose is a plain `new Error(...)`.
  // A TypeError or ReferenceError is a bug in WayContext, not a user mistake,
  // so those keep their frames -- that is the one case where the trace is the
  // useful part.
  if (!code && e?.constructor === Error && msg) return { message: msg };

  return null;
}

/**
 * Print a failure and return the exit code to use.
 *
 * Frames are suppressed unless asked for, since for every recognised error here
 * they say nothing a user can act on. `--debug`/WAYCONTEXT_DEBUG=1 brings them
 * back for anyone actually debugging WayContext itself.
 */
export function reportError(e, { debug = false, log = console.error } = {}) {
  const friendly = debug ? null : friendlyError(e);
  if (!friendly) {
    log(e);
    return 1;
  }
  log(`Error: ${friendly.message}`);
  // Only environment/configuration failures get the offer. A domain message like
  // `Project "x" not found. Run index_project first.` is already the whole
  // answer, and inviting the user to go find a stack trace implies otherwise.
  if (friendly.hint) {
    log(`\n${friendly.hint}`);
    log("\nRe-run with --debug for the full stack trace.");
  }
  return 1;
}
