/** Longest a cached streak may live (see docs/architecture/panic-button-redis.md). */
export const STREAK_MAX_TTL_SECONDS = 600;

/**
 * Seconds from `now` until the next midnight in `timeZone`, or null if the
 * time zone name is not valid.
 */
export function secondsUntilLocalMidnight(timeZone: string, now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const secondsIntoDay = get("hour") * 3600 + get("minute") * 60 + get("second");
    if (Number.isNaN(secondsIntoDay)) return null;
    return Math.max(1, 86400 - secondsIntoDay);
  } catch {
    return null; // RangeError for an unknown time zone
  }
}

/**
 * A cached streak is wrong once the goal's local day rolls over, so it expires
 * at local midnight if that is sooner than the normal 10 minutes.
 */
export function streakTtlSeconds(timeZone: string | null | undefined, now: Date): number {
  if (!timeZone) return STREAK_MAX_TTL_SECONDS;
  const untilMidnight = secondsUntilLocalMidnight(timeZone, now);
  if (untilMidnight === null) return STREAK_MAX_TTL_SECONDS;
  return Math.min(STREAK_MAX_TTL_SECONDS, untilMidnight);
}
