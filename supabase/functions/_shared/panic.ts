import {
  cached,
  keyGoals,
  keyReminders,
  keyStreak,
  KEY_MESSAGES,
  safeSet,
  TTL_GOALS,
  TTL_MESSAGES,
  TTL_REMINDERS,
  type Source,
} from "./cache.ts";
import { FALLBACK_MESSAGES, isUuid } from "./fallback.ts";
import { streakTtlSeconds } from "./time.ts";
import { toStreakCache } from "./streakCache.ts";
import {
  type Category,
  type Deps,
  type EventPatch,
  type GoalInfo,
  HttpError,
  type Message,
  type Outcome,
  type Reminder,
  type StreakCache,
} from "./types.ts";

export interface PanicContent {
  eventId: string;
  occurredAt: string;
  /** Where the messages came from: cache, database, or the built-in fallback. */
  source: Source | "fallback";
  motivation: Message;
  grounding: Message;
  crisis: Message[];
  reminders: Reminder[];
  streaks: StreakCache[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadMessages(deps: Deps): Promise<{ messages: Message[]; source: Source | "fallback" }> {
  try {
    const { value, source } = await cached(deps, KEY_MESSAGES, TTL_MESSAGES, () => deps.db.loadMessages());
    return { messages: value, source };
  } catch {
    deps.log("database read failed for messages, using built-in messages");
    return { messages: FALLBACK_MESSAGES, source: "fallback" };
  }
}

async function loadReminders(deps: Deps, userId: string): Promise<Reminder[]> {
  try {
    const { value } = await cached(deps, keyReminders(userId), TTL_REMINDERS, () =>
      deps.db.loadReminders(userId));
    return value;
  } catch {
    deps.log("could not load reminders");
    return []; // reminders are a bonus, never a reason to fail
  }
}

/** Streaks are optional extras: any failure here yields an empty list. */
async function loadStreaks(
  deps: Deps,
  userId: string,
): Promise<{ goals: GoalInfo[]; streaks: StreakCache[] }> {
  try {
    const { value: goals } = await cached(deps, keyGoals(userId), TTL_GOALS, () =>
      deps.db.loadGoals(userId));
    if (goals.length === 0) return { goals, streaks: [] };

    const found: StreakCache[] = [];
    const missing: GoalInfo[] = [];
    await Promise.all(goals.map(async (goal) => {
      let hit: StreakCache | null = null;
      if (deps.redis) {
        try {
          hit = await deps.redis.get<StreakCache>(keyStreak(userId, goal.goalId));
        } catch {
          deps.log("redis read failed for a streak");
        }
      }
      if (hit) found.push(hit);
      else missing.push(goal);
    }));

    if (missing.length > 0) {
      const rows = await deps.db.loadStreakStats(missing.map((g) => g.goalId));
      for (const row of rows) {
        const entry = toStreakCache(row);
        found.push(entry);
        const goal = missing.find((g) => g.goalId === row.goal_id);
        if (deps.redis) {
          await safeSet(
            deps.redis,
            keyStreak(userId, row.goal_id),
            entry,
            streakTtlSeconds(goal?.timeZone, deps.now()),
            deps.log,
          );
        }
      }
    }
    // Same order as the goal list, so the screen is stable between presses.
    const order = new Map(goals.map((g, i) => [g.goalId, i]));
    found.sort((a, b) => (order.get(a.goalId) ?? 0) - (order.get(b.goalId) ?? 0));
    return { goals, streaks: found };
  } catch {
    deps.log("could not load streaks");
    return { goals: [], streaks: [] };
  }
}

function pick(messages: Message[], category: Category, rng: () => number): Message {
  const pool = messages.filter((m) => m.category === category);
  const use = pool.length > 0 ? pool : FALLBACK_MESSAGES.filter((m) => m.category === category);
  return use[Math.min(use.length - 1, Math.floor(rng() * use.length))];
}

/** Saves the event; one retry; never throws. Failure to log must not hurt the user. */
async function insertWithRetry(
  deps: Deps,
  event: Parameters<Deps["db"]["insertEvent"]>[0],
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await deps.db.insertEvent(event);
      return;
    } catch {
      deps.log(`panic event insert failed (attempt ${attempt})`);
      if (attempt === 1) await sleep(deps.retryDelayMs);
    }
  }
}

export async function getPanicContent(
  deps: Deps,
  userId: string,
  goalId?: string | null,
): Promise<PanicContent> {
  if (goalId != null && !isUuid(goalId)) throw new HttpError(400, "goalId must be a UUID");

  const [{ messages, source }, reminders, { goals, streaks }] = await Promise.all([
    loadMessages(deps),
    loadReminders(deps, userId),
    loadStreaks(deps, userId),
  ]);

  if (goalId != null) {
    const known = goals.some((g) => g.goalId === goalId) ||
      await deps.db.goalOwnedByUser(userId, goalId); // the cached list may be a few minutes old
    if (!known) throw new HttpError(400, "Unknown goal");
  }

  const motivation = pick(messages, "motivation", deps.rng);
  const grounding = pick(messages, "grounding", deps.rng);
  let crisis = messages.filter((m) => m.category === "crisis");
  if (crisis.length === 0) crisis = FALLBACK_MESSAGES.filter((m) => m.category === "crisis");

  const eventId = deps.newId();
  const occurredAt = deps.now().toISOString();
  deps.defer(insertWithRetry(deps, {
    id: eventId,
    userId,
    occurredAt,
    messageId: isUuid(motivation.id) ? motivation.id : null,
    goalId: goalId ?? null,
  }));

  return { eventId, occurredAt, source, motivation, grounding, crisis, reminders, streaks };
}

const OUTCOMES: Outcome[] = ["resolved", "still_struggling", "contacted_support"];

export function parseEventPatch(raw: unknown): EventPatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, "Send a JSON object");
  }
  const input = raw as Record<string, unknown>;
  const patch: EventPatch = {};

  if (input.urgeLevel !== undefined) {
    const level = input.urgeLevel;
    if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 10) {
      throw new HttpError(400, "urgeLevel must be a whole number from 0 to 10");
    }
    patch.urgeLevel = level;
  }
  if (input.triggerNote !== undefined) {
    const note = input.triggerNote;
    if (typeof note !== "string" || note.length > 1000) {
      throw new HttpError(400, "triggerNote must be text of at most 1000 characters");
    }
    patch.triggerNote = note.trim();
  }
  if (input.outcome !== undefined) {
    if (typeof input.outcome !== "string" || !OUTCOMES.includes(input.outcome as Outcome)) {
      throw new HttpError(400, `outcome must be one of: ${OUTCOMES.join(", ")}`);
    }
    patch.outcome = input.outcome as Outcome;
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "Nothing to update: send urgeLevel, triggerNote or outcome");
  }
  return patch;
}

export async function updatePanicEvent(
  deps: Deps,
  userId: string,
  eventId: string,
  rawPatch: unknown,
): Promise<void> {
  if (!isUuid(eventId)) throw new HttpError(400, "Invalid event id");
  const patch = parseEventPatch(rawPatch);
  const updated = await deps.db.updateEvent(userId, eventId, patch);
  if (!updated) throw new HttpError(404, "Event not found");
}
