import { keyGoals, keyStreak, safeDel, safeSet } from "./cache.ts";
import { streakTtlSeconds } from "./time.ts";
import { type Deps, HttpError, type StreakCache, type StreakStatsRow } from "./types.ts";

/** Builds the cache entry exactly as the contract in the design doc describes. */
export function toStreakCache(row: StreakStatsRow): StreakCache {
  return {
    goalId: row.goal_id,
    goalName: row.goal_name,
    currentStreak: Number(row.current_streak),
    longestStreak: Number(row.longest_streak),
    asOf: String(row.local_today).slice(0, 10),
  };
}

/**
 * For the Streak Engine: call this after a check-in, a relapse, or a goal edit.
 * It reads the goal's streak_stats row and overwrites the cache entry.
 */
export async function writeStreakCache(
  deps: Deps,
  userId: string,
  goalId: string,
): Promise<StreakCache> {
  const goals = await deps.db.loadGoals(userId);
  const goal = goals.find((g) => g.goalId === goalId);
  if (!goal) throw new HttpError(404, "Goal not found");

  const [row] = await deps.db.loadStreakStats([goalId]);
  if (!row) throw new HttpError(404, "No streak data for this goal yet");

  const entry = toStreakCache(row);
  if (deps.redis) {
    await safeSet(
      deps.redis,
      keyStreak(userId, goalId),
      entry,
      streakTtlSeconds(goal.timeZone, deps.now()),
      deps.log,
    );
    // The goal list is cached too, so a new or renamed goal shows up right away.
    await safeDel(deps.redis, keyGoals(userId), deps.log);
  }
  return entry;
}

/** For the Streak Engine: call this when a goal is deleted (or to force a refresh). */
export async function deleteStreakCache(
  deps: Pick<Deps, "redis" | "log">,
  userId: string,
  goalId: string,
): Promise<void> {
  await safeDel(deps.redis, keyStreak(userId, goalId), deps.log);
  await safeDel(deps.redis, keyGoals(userId), deps.log);
}
