import pg from "pg";
import { config } from "./config.js";

/**
 * The single shared connection pool.
 *
 * Lives in its own module (rather than in db.js) so migrate.js can use it
 * without importing db.js, which would create a cycle: db.js needs migrate.js
 * for initDb(). Everything else may keep importing `pool` from db.js, which
 * re-exports it.
 */
export const pool = new pg.Pool({ connectionString: config.databaseUrl });
