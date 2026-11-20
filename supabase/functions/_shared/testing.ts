// Fakes for unit tests. Not imported by any deployed function.
import type {
  Db,
  Deps,
  EventPatch,
  GoalInfo,
  Message,
  NewEvent,
  Redis,
  Reminder,
  StreakStatsRow,
} from "./types.ts";

export const USER = "aaaaaaaa-0000-4000-8000-000000000001";
export const OTHER_USER = "bbbbbbbb-0000-4000-8000-000000000002";
export const GOAL = "11111111-0000-4000-8000-00000000000a";
export const MSG_MOTIVATION = "cccccccc-0000-4000-8000-000000000001";

export const SAMPLE_MESSAGES: Message[] = [
  { id: MSG_MOTIVATION, category: "motivation", body: "You can do this." },
  { id: "cccccccc-0000-4000-8000-000000000002", category: "grounding", body: "Breathe slowly." },
  { id: "cccccccc-0000-4000-8000-000000000003", category: "crisis", body: "Call or text 988." },
];

export class FakeRedis implements Redis {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  fail = false;
  gets = 0;

  get<T>(key: string): Promise<T | null> {
    this.gets++;
    if (this.fail) return Promise.reject(new Error("redis down"));
    const raw = this.store.get(key);
    return Promise.resolve(raw === undefined ? null : JSON.parse(raw) as T);
  }
  set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (this.fail) return Promise.reject(new Error("redis down"));
    this.store.set(key, JSON.stringify(value));
    this.ttls.set(key, ttlSeconds);
    return Promise.resolve();
  }
  del(key: string): Promise<void> {
    if (this.fail) return Promise.reject(new Error("redis down"));
    this.store.delete(key);
    this.ttls.delete(key);
    return Promise.resolve();
  }
}

export class FakeDb implements Db {
  messages: Message[] = [...SAMPLE_MESSAGES];
  reminders: Reminder[] = [];
  goals: GoalInfo[] = [];
  streakRows: StreakStatsRow[] = [];
  events: NewEvent[] = [];
  patches: { userId: string; eventId: string; patch: EventPatch }[] = [];
  calls = { messages: 0, reminders: 0, goals: 0, streaks: 0, insert: 0 };
  failMessages = false;
  failInsertTimes = 0;
  ownedGoals = new Set<string>();

  loadMessages() {
    this.calls.messages++;
    return this.failMessages ? Promise.reject(new Error("db down")) : Promise.resolve(this.messages);
  }
  loadReminders(_userId: string) {
    this.calls.reminders++;
    return Promise.resolve([...this.reminders]);
  }
  loadGoals(_userId: string) {
    this.calls.goals++;
    return Promise.resolve(this.goals);
  }
  loadStreakStats(goalIds: string[]) {
    this.calls.streaks++;
    return Promise.resolve(this.streakRows.filter((r) => goalIds.includes(r.goal_id)));
  }
  goalOwnedByUser(_userId: string, goalId: string) {
    return Promise.resolve(this.ownedGoals.has(goalId));
  }
  insertEvent(event: NewEvent) {
    this.calls.insert++;
    if (this.failInsertTimes > 0) {
      this.failInsertTimes--;
      return Promise.reject(new Error("insert failed"));
    }
    this.events.push(event);
    return Promise.resolve();
  }
  updateEvent(userId: string, eventId: string, patch: EventPatch) {
    this.patches.push({ userId, eventId, patch });
    return Promise.resolve(this.events.some((e) => e.id === eventId && e.userId === userId));
  }
  addReminder(userId: string, body: string) {
    const reminder = { id: `dddddddd-0000-4000-8000-${String(this.reminders.length).padStart(12, "0")}`, body };
    this.reminders.push(reminder);
    void userId;
    return Promise.resolve(reminder);
  }
  deleteReminder(_userId: string, reminderId: string) {
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((r) => r.id !== reminderId);
    return Promise.resolve(this.reminders.length < before);
  }
}

export interface Harness {
  deps: Deps;
  db: FakeDb;
  redis: FakeRedis;
  logs: string[];
  deferred: Promise<unknown>[];
  /** Waits for background work, like the runtime does after the response. */
  settle: () => Promise<void>;
}

export function makeHarness(options: { redis?: boolean; now?: Date } = {}): Harness {
  const db = new FakeDb();
  const redis = new FakeRedis();
  const logs: string[] = [];
  const deferred: Promise<unknown>[] = [];
  let counter = 0;
  const deps: Deps = {
    db,
    redis: options.redis === false ? null : redis,
    rng: () => 0,
    now: () => options.now ?? new Date("2026-11-14T18:00:00Z"),
    newId: () => `eeeeeeee-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    defer: (work) => deferred.push(work),
    log: (m) => logs.push(m),
    retryDelayMs: 0,
  };
  return { deps, db, redis, logs, deferred, settle: async () => void await Promise.all(deferred) };
}

export const STREAK_ROW: StreakStatsRow = {
  goal_id: GOAL,
  goal_name: "Quit smoking",
  local_today: "2026-11-14",
  current_streak: "12", // PostgREST can return bigint as a string; the code must cope
  longest_streak: 30,
};
