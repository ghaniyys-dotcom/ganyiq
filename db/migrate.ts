/**
 * db/migrate.ts — Migration runner for ganyIQ.
 *
 * Reads all .sql files from db/migrations/ in alphabetical order and
 * executes them against the Neon database. Tracks which migrations have
 * already been applied in a `_migrations` table so the script is
 * idempotent — safe to run multiple times.
 *
 * Usage:
 *   npx tsx db/migrate.ts
 *
 * Environment:
 *   DATABASE_URL  (required) — Neon PostgreSQL connection string
 *
 * Behavior:
 *   - Creates `_migrations` tracking table if it does not exist.
 *   - Reads migration SQL files sorted by filename.
 *   - Skips migrations already recorded in `_migrations`.
 *   - Executes each pending migration inside its own transaction.
 *   - Records the filename in `_migrations` on success.
 *   - Stops on the first failure — no partial migration chains.
 *   - Prints clear success/failure messages to stdout.
 */

import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join, parse } from "node:path";
import { query, closePool } from "./client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(parse(process.argv[1]).dir, "migrations");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(level: "OK" | "SKIP" | "ERR" | "INFO", message: string): void {
  const prefix =
    level === "OK" ? "✅" : level === "SKIP" ? "⏭" : level === "ERR" ? "❌" : "ℹ️";
  console.log(`${prefix} [${level}] ${message}`);
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

async function runMigrations(): Promise<void> {
  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log("  ganyIQ — Database Migration Runner");
  console.log("═══════════════════════════════════════════");
  console.log("");

  // 1. Ensure _migrations tracking table exists
  log("INFO", "Ensuring _migrations tracking table exists...");
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  // 2. Fetch already-executed migrations
  const { rows: executed } = await query<{ filename: string }>(
    "SELECT filename FROM _migrations ORDER BY filename"
  );
  const executedSet = new Set(executed.map((r) => r.filename));

  // 3. Discover migration files
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    log("INFO", "No migration files found. Nothing to do.");
    await closePool();
    return;
  }

  log("INFO", `Found ${files.length} migration file(s): ${files.join(", ")}`);
  console.log("");

  // 4. Execute pending migrations in order
  let applied = 0;
  let skipped = 0;

  for (const file of files) {
    if (executedSet.has(file)) {
      log("SKIP", `${file} — already applied`);
      skipped++;
      continue;
    }

    const filePath = join(MIGRATIONS_DIR, file);
    const sql = readFileSync(filePath, "utf-8");

    log("INFO", `Applying ${file}...`);

    try {
      // Execute the migration — wraps in an implicit transaction
      // (Neon's @neondatabase/serverless auto-commits each query, so
      // we run the full migration as a single query string. Each
      // migration .sql file should contain all statements for one
      // migration step.)
      await query(sql);

      // Record the migration
      await query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);

      log("OK", `${file} — applied successfully`);
      applied++;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      log("ERR", `${file} — FAILED: ${message}`);
      console.error("");
      console.error("═══════════════════════════════════════════");
      console.error("  MIGRATION FAILED — pipeline halted.");
      console.error("  Fix the error, then re-run this script.");
      console.error("  Already-applied migrations will be skipped.");
      console.error("═══════════════════════════════════════════");
      await closePool();
      process.exit(1);
    }
  }

  // 5. Summary
  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log(`  Applied: ${applied}  |  Skipped: ${skipped}  |  Total: ${files.length}`);
  console.log("═══════════════════════════════════════════");

  await closePool();
}

runMigrations().catch((err: unknown) => {
  console.error("❌ [FATAL] Migration runner crashed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
