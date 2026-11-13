import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sqlPath = fileURLToPath(new URL("./subset.sql", import.meta.url));

/**
 * Load the redacted V-D review subset into an already-created SQLite database.
 *
 * The caller owns the database (typically `new DatabaseSync(":memory:")` with
 * `schema.sql` applied first). Message/outbox/chat_decisions rowids are kept
 * exactly as they are in the production export, so tests can address rows by
 * the real rowid from the case list.
 */
export function loadReviewSubset(database) {
  database.exec(readFileSync(sqlPath, "utf8"));
  return database;
}
