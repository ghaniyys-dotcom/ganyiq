import { Pool, type QueryResult, type QueryResultRow } from 'pg';

/**
 * Singleton Neon database pool.
 * Created once, reused across all serverless function invocations.
 * Falls back to a fresh pool if the cached one was somehow drained.
 */
let pool: Pool | null = null;
let poolErrorHandlerAttached = false;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL environment variable is not set. ' +
        'Create a .env.local file with: DATABASE_URL=postgresql://user:***@host/db?sslmode=require'
      );
    }
    pool = new Pool({ connectionString });

    // ATTACH POOL ERROR HANDLER — prevents uncaughtException crash
    // Without this, PostgreSQL idle-killed connections emit 'error' on the pool
    // and Node.js throws an uncaughtException, crashing the process (PM2 restart).
    if (!poolErrorHandlerAttached) {
      poolErrorHandlerAttached = true;
      pool.on('error', (err: Error) => {
        // Log with full context but DO NOT crash the process
        console.error('[DB POOL] Connection error (non-fatal):', err.message);
        if (process.env.NODE_ENV === 'development') {
          console.error('[DB POOL] Stack:', err.stack?.slice(0, 500));
        }
      });
    }
  }
  return pool;
}

/**
 * Execute a parameterized SQL query.
 *
 * ALWAYS use parameterized queries (`$1`, `$2`, …) for dynamic values.
 * NEVER concatenate user input into SQL strings — no exceptions.
 *
 * @param sql  - SQL with optional positional parameters ($1, $2, …)
 * @param params - Values bound to the positional parameters
 * @returns Standard pg QueryResult
 *
 * @example
 *   const { rows } = await query(
 *     'SELECT * FROM videos WHERE youtube_id = $1',
 *     [videoId]
 *   );
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  const client = getPool();
  return client.query<T>(sql, params);
}

/**
 * Gracefully close the database pool.
 * Call during application shutdown (e.g., SIGTERM handler).
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
