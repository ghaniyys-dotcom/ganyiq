/**
 * lib/worker-auth.ts — Shared authentication for worker API routes.
 *
 * Worker auth uses Bearer tokens with SHA-256 hashed keys stored in DB.
 * Registration is the only unauthenticated endpoint.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { query } from '@/db/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerRecord {
  id: string;
  worker_name: string;
  api_key_hash: string;
  status: string;
  last_heartbeat: string | null;
  jobs_completed: number;
  jobs_failed: number;
}

// ---------------------------------------------------------------------------
// Key Hashing
// ---------------------------------------------------------------------------

/** Hash a raw API key to its SHA-256 hex digest for storage/comparison. */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf-8').digest('hex');
}

/** Constant-time comparison of two strings (hex digests). */
export function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) return false;
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auth Middleware
// ---------------------------------------------------------------------------

export interface AuthResult {
  worker: WorkerRecord;
}

/**
 * Authenticate a request using the Bearer token in the Authorization header.
 * Looks up worker by ID from the URL param, hashes the provided key,
 * and compares against stored hash.
 *
 * Returns the worker record on success.
 * Throws an object with { status, body } for direct NextResponse use.
 */
export async function authenticateWorker(
  workerId: string,
  authHeader: string | null,
): Promise<AuthResult> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { status: 401, body: { error: 'Missing or invalid Authorization header.', code: 'UNAUTHORIZED' } };
  }

  const rawKey = authHeader.slice('Bearer '.length).trim();
  if (!rawKey) {
    throw { status: 401, body: { error: 'Empty token in Authorization header.', code: 'UNAUTHORIZED' } };
  }

  const workers = await query<WorkerRecord>(
    'SELECT id, worker_name, api_key_hash, status, last_heartbeat, jobs_completed, jobs_failed FROM workers WHERE id = $1',
    [workerId],
  );

  if (workers.rows.length === 0) {
    throw { status: 401, body: { error: 'Worker not found.', code: 'WORKER_NOT_FOUND' } };
  }

  const worker = workers.rows[0];
  const providedHash = hashApiKey(rawKey);

  if (!safeCompare(providedHash, worker.api_key_hash)) {
    throw { status: 401, body: { error: 'Invalid API key.', code: 'FORBIDDEN' } };
  }

  return { worker };
}
