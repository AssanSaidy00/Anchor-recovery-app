import assert from "node:assert/strict";
import { KEY_MESSAGES, keyGoals, keyReminders, keyStreak } from "./cache.ts";
import { getPanicContent, updatePanicEvent } from "./panic.ts";
import { HttpError } from "./types.ts";
import { GOAL, makeHarness, MSG_MOTIVATION, OTHER_USER, SAMPLE_MESSAGES, STREAK_ROW, USER } from "./testing.ts";

Deno.test("cache hit returns content without calling the database", async () => {
  const h = makeHarness();
  await h.redis.set(KEY_MESSAGES, SAMPLE_MESSAGES, 3600);
  await h.redis.set(keyReminders(USER), [{ id: "r1", body: "My kids" }], 3600);
  await h.redis.set(keyGoals(USER), [], 600);

  const result = await getPanicContent(h.deps, USER);

  assert.equal(result.source, "cache");
  assert.equal(h.db.calls.messages, 0);
  assert.equal(h.db.calls.reminders, 0);
  assert.equal(result.reminders[0].body, "My kids");
  assert.equal(result.motivation.body, "You can do this.");
  assert.equal(result.crisis.length, 1);
});

Deno.test("cache miss loads from the database and fills Redis with a TTL", async () => {
  const h = makeHarness();
  const result = await getPanicContent(h.deps, USER);

  assert.equal(result.source, "database");
  assert.equal(h.db.calls.messages, 1);
  assert.ok(h.redis.store.has(KEY_MESSAGES));
  assert.equal(h.redis.ttls.get(KEY_MESSAGES), 3600);
  assert.equal(h.redis.ttls.get(keyReminders(USER)), 3600);
});

Deno.test("a second press is served from cache", async () => {
  const h = makeHarness();
  await getPanicContent(h.deps, USER);
  const second = await getPanicContent(h.deps, USER);
  assert.equal(second.source, "cache");
  assert.equal(h.db.calls.messages, 1);
});

Deno.test("Redis down falls back to the database", async () => {
  const h = makeHarness();
  h.redis.fail = true;
  const result = await getPanicContent(h.deps, USER);
  assert.equal(result.source, "database");
  assert.equal(result.motivation.id, MSG_MOTIVATION);
});

Deno.test("Redis and database both down returns built-in messages incl. 988 and SAMHSA", async () => {
  const h = makeHarness();
  h.redis.fail = true;
  h.db.failMessages = true;

  const result = await getPanicContent(h.deps, USER);
  await h.settle();

  assert.equal(result.source, "fallback");
  const crisisText = result.crisis.map((m) => m.body).join(" ");
  assert.match(crisisText, /988/);
  assert.match(crisisText, /1-800-662-4357/);
  // Built-in ids are not UUIDs, so they must never reach panic_events.message_id.
  assert.equal(h.db.events[0].messageId, null);
});

Deno.test("no Redis configured works straight from the database", async () => {
  const h = makeHarness({ redis: false });
  const result = await getPanicContent(h.deps, USER);
  assert.equal(result.source, "database");
});

Deno.test("the event is saved with the shown message id", async () => {
  const h = makeHarness();
  const result = await getPanicContent(h.deps, USER);
  await h.settle();
  assert.equal(h.db.events.length, 1);
  assert.equal(h.db.events[0].id, result.eventId);
  assert.equal(h.db.events[0].userId, USER);
  assert.equal(h.db.events[0].messageId, MSG_MOTIVATION);
  assert.equal(h.db.events[0].goalId, null);
});

Deno.test("a failed event insert does not change the response, and is retried once", async () => {
  const h = makeHarness();
  h.db.failInsertTimes = 1;
  const result = await getPanicContent(h.deps, USER);
  await h.settle();
  assert.equal(result.motivation.body, "You can do this.");
  assert.equal(h.db.calls.insert, 2);
  assert.equal(h.db.events.length, 1);
});

Deno.test("an insert that keeps failing still never throws", async () => {
  const h = makeHarness();
  h.db.failInsertTimes = 5;
  const result = await getPanicContent(h.deps, USER);
  await h.settle(); // must not reject
  assert.ok(result.eventId);
  assert.equal(h.db.calls.insert, 2);
  assert.equal(h.db.events.length, 0);
});

Deno.test("log messages never contain user ids or content", async () => {
  const h = makeHarness();
  h.redis.fail = true;
  h.db.failInsertTimes = 5;
  await getPanicContent(h.deps, USER);
  await h.settle();
  for (const line of h.logs) assert.doesNotMatch(line, new RegExp(USER));
});

Deno.test("streaks: a miss reads streak_stats, writes the contract shape and a capped TTL", async () => {
  const h = makeHarness({ now: new Date("2026-11-14T18:00:00Z") }); // noon in Chicago
  h.db.goals = [{ goalId: GOAL, timeZone: "America/Chicago" }];
  h.db.streakRows = [STREAK_ROW];

  const result = await getPanicContent(h.deps, USER);

  assert.deepEqual(result.streaks, [{
    goalId: GOAL,
    goalName: "Quit smoking",
    currentStreak: 12, // string "12" from the database became a number
    longestStreak: 30,
    asOf: "2026-11-14",
  }]);
  assert.equal(h.redis.ttls.get(keyStreak(USER, GOAL)), 600);
});

Deno.test("streaks: the TTL ends at the goal's local midnight when that is sooner", async () => {
  // 05:58:00 UTC on Nov 15 = 23:58:00 on Nov 14 in Chicago (CST) -> 120 seconds to midnight
  const h = makeHarness({ now: new Date("2026-11-15T05:58:00Z") });
  h.db.goals = [{ goalId: GOAL, timeZone: "America/Chicago" }];
  h.db.streakRows = [STREAK_ROW];
  await getPanicContent(h.deps, USER);
  assert.equal(h.redis.ttls.get(keyStreak(USER, GOAL)), 120);
});

Deno.test("streaks: a cache hit does not read streak_stats", async () => {
  const h = makeHarness();
  h.db.goals = [{ goalId: GOAL, timeZone: "UTC" }];
  await h.redis.set(keyGoals(USER), h.db.goals, 600);
  const entry = { goalId: GOAL, goalName: "Quit smoking", currentStreak: 5, longestStreak: 9, asOf: "2026-11-14" };
  await h.redis.set(keyStreak(USER, GOAL), entry, 600);

  const result = await getPanicContent(h.deps, USER);
  assert.deepEqual(result.streaks, [entry]);
  assert.equal(h.db.calls.streaks, 0);
});

Deno.test("streaks: missing Streak Engine tables do not break the panic screen", async () => {
  const h = makeHarness(); // goals = [] like before Sahar's schema is applied
  const result = await getPanicContent(h.deps, USER);
  assert.deepEqual(result.streaks, []);
});

Deno.test("a panic event can only be linked to a goal the user owns", async () => {
  const h = makeHarness();
  h.db.goals = [{ goalId: GOAL, timeZone: "UTC" }];
  h.db.streakRows = [STREAK_ROW];

  const mine = await getPanicContent(h.deps, USER, GOAL);
  await h.settle();
  assert.ok(mine.eventId);
  assert.equal(h.db.events[0].goalId, GOAL);

  const someoneElses = "22222222-0000-4000-8000-00000000000b";
  await assert.rejects(() => getPanicContent(h.deps, USER, someoneElses), (e: unknown) =>
    e instanceof HttpError && e.status === 400);
  await assert.rejects(() => getPanicContent(h.deps, USER, "not-a-uuid"), (e: unknown) =>
    e instanceof HttpError && e.status === 400);
});

Deno.test("a goal created after the goal list was cached is still accepted", async () => {
  const h = makeHarness();
  h.db.goals = []; // stale
  h.db.ownedGoals.add(GOAL); // but the database knows it belongs to the user
  const result = await getPanicContent(h.deps, USER, GOAL);
  assert.ok(result.eventId);
});

Deno.test("update: records urge level, note and outcome for the owner", async () => {
  const h = makeHarness();
  const { eventId } = await getPanicContent(h.deps, USER);
  await h.settle();

  await updatePanicEvent(h.deps, USER, eventId, { urgeLevel: 7, triggerNote: " stressed ", outcome: "resolved" });
  assert.deepEqual(h.db.patches[0].patch, { urgeLevel: 7, triggerNote: "stressed", outcome: "resolved" });
});

Deno.test("update: another user's event is a 404", async () => {
  const h = makeHarness();
  const { eventId } = await getPanicContent(h.deps, USER);
  await h.settle();
  await assert.rejects(() => updatePanicEvent(h.deps, OTHER_USER, eventId, { outcome: "resolved" }),
    (e: unknown) => e instanceof HttpError && e.status === 404);
});

Deno.test("update: rejects bad input", async () => {
  const h = makeHarness();
  const id = "eeeeeeee-0000-4000-8000-000000000099";
  const bad = [
    { urgeLevel: 11 },
    { urgeLevel: -1 },
    { urgeLevel: 3.5 },
    { urgeLevel: "5" },
    { outcome: "won" },
    { triggerNote: "x".repeat(1001) },
    {},
    null,
    [],
  ];
  for (const body of bad) {
    await assert.rejects(() => updatePanicEvent(h.deps, USER, id, body), (e: unknown) =>
      e instanceof HttpError && e.status === 400, JSON.stringify(body));
  }
  await assert.rejects(() => updatePanicEvent(h.deps, USER, "nope", { outcome: "resolved" }),
    (e: unknown) => e instanceof HttpError && e.status === 400);
});
