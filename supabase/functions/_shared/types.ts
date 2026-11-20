// Shared types for the Panic Button functions.
// Nothing in here is Deno-specific, so the logic that uses it can be unit tested.

export type Category = "motivation" | "grounding" | "crisis";

export interface Message {
  id: string;
  category: Category;
  body: string;
}

export interface Reminder {
  id: string;
  body: string;
  created_at?: string;
}

/** A recovery goal as far as the cache needs to know. */
export interface GoalInfo {
  goalId: string;
  timeZone: string; // IANA name, e.g. "America/Chicago"
}

/** One row of Sahar's streak_stats view. */
export interface StreakStatsRow {
  goal_id: string;
  goal_name: string;
  local_today: string; // YYYY-MM-DD in the goal's time zone
  current_streak: number | string;
  longest_streak: number | string;
}

/**
 * The streak cache contract. Keep in sync with
 * docs/architecture/panic-button-redis.md.
 */
export interface StreakCache {
  goalId: string;
  goalName: string;
  currentStreak: number;
  longestStreak: number;
  asOf: string; // YYYY-MM-DD
}

export type Outcome = "resolved" | "still_struggling" | "contacted_support";

export interface NewEvent {
  id: string;
  userId: string;
  occurredAt: string; // ISO timestamp
  messageId: string | null;
  goalId: string | null;
}

export interface EventPatch {
  urgeLevel?: number;
  triggerNote?: string;
  outcome?: Outcome;
}

/** The small slice of Redis the app needs. */
export interface Redis {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Everything the app reads from or writes to Postgres. */
export interface Db {
  loadMessages(): Promise<Message[]>;
  loadReminders(userId: string): Promise<Reminder[]>;
  /** Returns [] when the Streak Engine tables do not exist yet. */
  loadGoals(userId: string): Promise<GoalInfo[]>;
  loadStreakStats(goalIds: string[]): Promise<StreakStatsRow[]>;
  goalOwnedByUser(userId: string, goalId: string): Promise<boolean>;
  insertEvent(event: NewEvent): Promise<void>;
  /** Returns false when no row matched (wrong id or not the user's event). */
  updateEvent(userId: string, eventId: string, patch: EventPatch): Promise<boolean>;
  addReminder(userId: string, body: string): Promise<Reminder>;
  /** Returns false when no row matched. */
  deleteReminder(userId: string, reminderId: string): Promise<boolean>;
}

export interface Deps {
  db: Db;
  /** null means "no Redis configured": everything goes straight to Postgres. */
  redis: Redis | null;
  rng: () => number;
  now: () => Date;
  newId: () => string;
  /** Runs work after the response is ready (EdgeRuntime.waitUntil in production). */
  defer: (work: Promise<unknown>) => void;
  /** Never pass user content to this. Error codes and key names only. */
  log: (message: string) => void;
  retryDelayMs: number;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
