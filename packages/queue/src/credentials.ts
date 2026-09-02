import { newRedisConnection } from "./redis.js";

// How long a stashed password may sit unread before it's dropped on its
// own — long enough to cover queue dispatch + browser launch, short enough
// that an unread stash doesn't linger.
const TTL_SECONDS = 600;

const credKey = (sessionId: string): string => `cred:session:${sessionId}`;

/**
 * Stashes a plaintext password for exactly one session, to be collected
 * once by the worker that runs it. This is the ONLY place a real Microsoft
 * password touches Redis — never Postgres, never a log line. Self-expires
 * if nothing ever collects it.
 */
export async function stashCredential(sessionId: string, password: string): Promise<void> {
  const r = newRedisConnection();
  try {
    await r.set(credKey(sessionId), password, "EX", TTL_SECONDS);
  } finally {
    r.disconnect();
  }
}

/**
 * Atomic get-and-delete: the password can be collected exactly once, by
 * exactly one process, and cannot be re-read afterward even by another
 * worker replica.
 */
export async function takeCredential(sessionId: string): Promise<string | null> {
  const r = newRedisConnection();
  try {
    return await r.getdel(credKey(sessionId));
  } finally {
    r.disconnect();
  }
}
