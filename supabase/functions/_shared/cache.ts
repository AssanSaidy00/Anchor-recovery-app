import type { Deps, Redis } from "./types.ts";

// Key names and TTLs. Keep in sync with docs/architecture/panic-button-redis.md.
export const KEY_MESSAGES = "anchor:panic:messages:v1";
export const TTL_MESSAGES = 3600;

export const keyReminders = (userId: string) => `anchor:user:${userId}:reminders`;
export const TTL_REMINDERS = 3600;

export const keyStreak = (userId: string, goalId: string) =>
  `anchor:user:${userId}:goal:${goalId}:streak`;

/** Lets the panic endpoint find a user's goals without asking Postgres every press. */
export const keyGoals = (userId: string) => `anchor:user:${userId}:goals`;
export const TTL_GOALS = 600;

export type Source = "cache" | "database";

/**
 * Cache-aside read. Redis trouble never fails the request: on any Redis error
 * we read from Postgres, and a failed write-back is ignored.
 */
export async function cached<T>(
  deps: Pick<Deps, "redis" | "log">,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<{ value: T; source: Source }> {
  const { redis, log } = deps;
  if (redis) {
    try {
      const hit = await redis.get<T>(key);
      if (hit !== null) return { value: hit, source: "cache" };
    } catch {
      log("redis read failed, using database");
    }
  }
  const value = await load();
  if (redis) await safeSet(redis, key, value, ttlSeconds, log);
  return { value, source: "database" };
}

export async function safeSet(
  redis: Redis,
  key: string,
  value: unknown,
  ttlSeconds: number,
  log: (message: string) => void,
): Promise<void> {
  try {
    await redis.set(key, value, ttlSeconds);
  } catch {
    log("redis write failed");
  }
}

export async function safeDel(
  redis: Redis | null,
  key: string,
  log: (message: string) => void,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch {
    // A stale entry still ends at its TTL, so this is not fatal.
    log("redis delete failed");
  }
}
