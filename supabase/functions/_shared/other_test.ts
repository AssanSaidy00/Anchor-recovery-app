import assert from "node:assert/strict";
import { keyGoals, keyReminders, keyStreak } from "./cache.ts";
import { createUpstash } from "./redis.ts";
import { addReminder, deleteReminder, listReminders, MAX_REMINDERS_PER_USER } from "./reminders.ts";
import { CORS_HEADERS, panicRoute, remindersRoute, streakCacheRoute, withAuth } from "./routes.ts";
import { deleteStreakCache, toStreakCache, writeStreakCache } from "./streakCache.ts";
import { secondsUntilLocalMidnight, streakTtlSeconds } from "./time.ts";
import { HttpError } from "./types.ts";
import { GOAL, makeHarness, STREAK_ROW, USER } from "./testing.ts";

// ---------- time ----------

Deno.test("time: seconds until local midnight", () => {
  // 23:58:00 in Chicago (CST, UTC-6)
  assert.equal(secondsUntilLocalMidnight("America/Chicago", new Date("2026-11-15T05:58:00Z")), 120);
  // 00:00:00 -> a full day
  assert.equal(secondsUntilLocalMidnight("UTC", new Date("2026-11-14T00:00:00Z")), 86400);
  assert.equal(secondsUntilLocalMidnight("Not/AZone", new Date()), null);
});

Deno.test("time: streak TTL is 10 minutes unless midnight is sooner, and never below 1", () => {
  const noon = new Date("2026-11-14T12:00:00Z");
  assert.equal(streakTtlSeconds("UTC", noon), 600);
  assert.equal(streakTtlSeconds("UTC", new Date("2026-11-14T23:59:30Z")), 30);
  assert.equal(streakTtlSeconds("UTC", new Date("2026-11-14T23:59:59Z")), 1);
  assert.equal(streakTtlSeconds(null, noon), 600);
  assert.equal(streakTtlSeconds("Not/AZone", noon), 600);
});

// ---------- upstash client ----------

function fakeFetch(handler: (body: unknown[], init: RequestInit) => { status?: number; json: unknown }) {
  const calls: { url: string; body: unknown[]; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body, init });
    const { status = 200, json } = handler(body, init);
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
  }) as typeof fetch;
  return { impl, calls };
}

Deno.test("upstash: GET, SET with EX, and DEL send the right commands", async () => {
  const { impl, calls } = fakeFetch((body) => {
    if (body[0] === "GET") return { json: { result: JSON.stringify({ a: 1 }) } };
    return { json: { result: "OK" } };
  });
  const redis = createUpstash({ url: "https://x.upstash.io", token: "secret", fetchImpl: impl });

  assert.deepEqual(await redis.get("k"), { a: 1 });
  await redis.set("k", { a: 2 }, 90.7);
  await redis.del("k");

  assert.deepEqual(calls[0].body, ["GET", "k"]);
  assert.deepEqual(calls[1].body, ["SET", "k", '{"a":2}', "EX", 90]);
  assert.deepEqual(calls[2].body, ["DEL", "k"]);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer secret");
});

Deno.test("upstash: a missing key is null", async () => {
  const { impl } = fakeFetch(() => ({ json: { result: null } }));
  const redis = createUpstash({ url: "https://x", token: "t", fetchImpl: impl });
  assert.equal(await redis.get("nope"), null);
});

Deno.test("upstash: errors throw without leaking the key", async () => {
  const { impl } = fakeFetch(() => ({ status: 401, json: { error: "WRONGPASS" } }));
  const redis = createUpstash({ url: "https://x", token: "t", fetchImpl: impl });
  await assert.rejects(() => redis.get(keyStreak(USER, GOAL)), (e: unknown) =>
    e instanceof Error && !e.message.includes(USER));
});

Deno.test("upstash: a slow Redis is abandoned after the timeout", async () => {
  const slow = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
  const redis = createUpstash({ url: "https://x", token: "t", fetchImpl: slow, timeoutMs: 20 });
  await assert.rejects(() => redis.get("k"));
});

// ---------- reminders ----------

Deno.test("reminders: list is cached, and adding clears the cache", async () => {
  const h = makeHarness();
  await listReminders(h.deps, USER);
  await listReminders(h.deps, USER);
  assert.equal(h.db.calls.reminders, 1); // second list came from Redis
  assert.ok(h.redis.store.has(keyReminders(USER)));

  await addReminder(h.deps, USER, "  My daughter  ");
  assert.equal(h.redis.store.has(keyReminders(USER)), false);
  const after = await listReminders(h.deps, USER);
  assert.equal(after[0].body, "My daughter"); // trimmed
});

Deno.test("reminders: deleting clears the cache; unknown id is 404", async () => {
  const h = makeHarness();
  const added = await addReminder(h.deps, USER, "Stay strong");
  await listReminders(h.deps, USER); // fills cache
  assert.ok(h.redis.store.has(keyReminders(USER)));

  await deleteReminder(h.deps, USER, added.id);
  assert.equal(h.redis.store.has(keyReminders(USER)), false);
  await assert.rejects(() => deleteReminder(h.deps, USER, added.id), (e: unknown) =>
    e instanceof HttpError && e.status === 404);
});

Deno.test("reminders: validation and the per-user limit", async () => {
  const h = makeHarness();
  for (const bad of ["", "   ", "x".repeat(501), 5, null, undefined]) {
    await assert.rejects(() => addReminder(h.deps, USER, bad), (e: unknown) =>
      e instanceof HttpError && e.status === 400);
  }
  for (let i = 0; i < MAX_REMINDERS_PER_USER; i++) await addReminder(h.deps, USER, `reason ${i}`);
  await assert.rejects(() => addReminder(h.deps, USER, "one more"), (e: unknown) =>
    e instanceof HttpError && e.status === 409);
});

Deno.test("reminders: a Redis failure on cache clear does not fail the request", async () => {
  const h = makeHarness();
  h.redis.fail = true;
  const added = await addReminder(h.deps, USER, "Still works");
  assert.equal(added.body, "Still works");
});

// ---------- streak cache (for the Streak Engine) ----------

Deno.test("streak cache: the entry matches the documented contract exactly", () => {
  assert.deepEqual(toStreakCache(STREAK_ROW), {
    goalId: GOAL,
    goalName: "Quit smoking",
    currentStreak: 12,
    longestStreak: 30,
    asOf: "2026-11-14",
  });
  // Dates that arrive with a time part are cut down to YYYY-MM-DD.
  assert.equal(toStreakCache({ ...STREAK_ROW, local_today: "2026-11-14T00:00:00" }).asOf, "2026-11-14");
});

Deno.test("streak cache: write saves the entry, sets a TTL, and clears the goal list", async () => {
  const h = makeHarness();
  h.db.goals = [{ goalId: GOAL, timeZone: "UTC" }];
  h.db.streakRows = [STREAK_ROW];
  await h.redis.set(keyGoals(USER), [], 600);

  const entry = await writeStreakCache(h.deps, USER, GOAL);

  assert.equal(entry.currentStreak, 12);
  assert.deepEqual(JSON.parse(h.redis.store.get(keyStreak(USER, GOAL))!), entry);
  assert.equal(h.redis.ttls.get(keyStreak(USER, GOAL)), 600);
  assert.equal(h.redis.store.has(keyGoals(USER)), false);
});

Deno.test("streak cache: someone else's goal, or a goal without data, is a 404", async () => {
  const h = makeHarness();
  await assert.rejects(() => writeStreakCache(h.deps, USER, GOAL), (e: unknown) =>
    e instanceof HttpError && e.status === 404);
  h.db.goals = [{ goalId: GOAL, timeZone: "UTC" }];
  await assert.rejects(() => writeStreakCache(h.deps, USER, GOAL), (e: unknown) =>
    e instanceof HttpError && e.status === 404);
});

Deno.test("streak cache: delete removes the entry and the goal list", async () => {
  const h = makeHarness();
  await h.redis.set(keyStreak(USER, GOAL), { x: 1 }, 600);
  await h.redis.set(keyGoals(USER), [], 600);
  await deleteStreakCache(h.deps, USER, GOAL);
  assert.equal(h.redis.store.size, 0);
});

// ---------- routes: login check, CORS, validation ----------

const ctx = { userId: USER };
const okAuth = () => Promise.resolve(ctx);
const noAuth = () => Promise.reject(new HttpError(401, "Not signed in"));
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://example.supabase.co/functions/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

Deno.test("routes: a request without a valid login gets 401 and nothing runs", async () => {
  const h = makeHarness();
  let ran = false;
  const handler = withAuth(noAuth, (r) => {
    ran = true;
    return panicRoute(r, h.deps, USER);
  }, () => {});
  const response = await handler(req("POST", "/panic"));
  assert.equal(response.status, 401);
  assert.equal(ran, false);
  assert.equal(h.db.calls.messages, 0);
});

Deno.test("routes: CORS preflight answers 204 without checking login", async () => {
  const handler = withAuth(noAuth, () => Promise.reject(new Error("must not run")), () => {});
  const response = await handler(req("OPTIONS", "/panic"));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), CORS_HEADERS["Access-Control-Allow-Origin"]);
});

Deno.test("routes: unexpected errors give a generic 500 with no details", async () => {
  const handler = withAuth(okAuth, () => Promise.reject(new Error("secret internals")), () => {});
  const response = await handler(req("POST", "/panic"));
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secret/);
});

Deno.test("routes: POST /panic returns the content and saves the event", async () => {
  const h = makeHarness();
  const handler = withAuth(okAuth, (r) => panicRoute(r, h.deps, USER), () => {});
  const response = await handler(req("POST", "/panic")); // no body is fine
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.motivation.body, "You can do this.");
  assert.ok(body.eventId);
  await h.settle();
  assert.equal(h.db.events.length, 1);
});

Deno.test("routes: panic input problems are 400, wrong paths 404", async () => {
  const h = makeHarness();
  const handler = withAuth(okAuth, (r) => panicRoute(r, h.deps, USER), () => {});
  assert.equal((await handler(req("POST", "/panic", { goalId: 5 }))).status, 400);
  assert.equal((await handler(req("POST", "/panic", { goalId: "nope" }))).status, 400);
  assert.equal((await handler(req("PATCH", "/panic/eeeeeeee-0000-4000-8000-000000000001", { urgeLevel: 99 }))).status, 400);
  assert.equal((await handler(req("GET", "/panic"))).status, 404);
  const broken = new Request("https://x/functions/v1/panic", { method: "POST", body: "{not json" });
  assert.equal((await handler(broken)).status, 400);
});

Deno.test("routes: PATCH /panic/:id updates an event", async () => {
  const h = makeHarness();
  const handler = withAuth(okAuth, (r) => panicRoute(r, h.deps, USER), () => {});
  const press = await (await handler(req("POST", "/panic"))).json();
  await h.settle();
  const response = await handler(req("PATCH", `/panic/${press.eventId}`, { urgeLevel: 4, outcome: "resolved" }));
  assert.equal(response.status, 200);
  assert.deepEqual(h.db.patches[0].patch, { urgeLevel: 4, outcome: "resolved" });
});

Deno.test("routes: reminders list, add, delete", async () => {
  const h = makeHarness();
  const handler = withAuth(okAuth, (r) => remindersRoute(r, h.deps, USER), () => {});
  const created = await handler(req("POST", "/reminders", { body: "For my family" }));
  assert.equal(created.status, 201);
  const { reminder } = await created.json();

  const list = await (await handler(req("GET", "/reminders"))).json();
  assert.equal(list.reminders.length, 1);

  assert.equal((await handler(req("DELETE", "/reminders/not-a-uuid"))).status, 400);
  assert.equal((await handler(req("DELETE", `/reminders/${reminder.id}`))).status, 204);
  assert.equal((await handler(req("POST", "/reminders", { body: "" }))).status, 400);
});

Deno.test("routes: streak-cache refresh and delete", async () => {
  const h = makeHarness();
  h.db.goals = [{ goalId: GOAL, timeZone: "UTC" }];
  h.db.streakRows = [STREAK_ROW];
  const handler = withAuth(okAuth, (r) => streakCacheRoute(r, h.deps, USER), () => {});

  const refreshed = await handler(req("POST", "/streak-cache", { goalId: GOAL }));
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).streak.currentStreak, 12);
  assert.ok(h.redis.store.has(keyStreak(USER, GOAL)));

  assert.equal((await handler(req("POST", "/streak-cache", {}))).status, 400);
  assert.equal((await handler(req("DELETE", "/streak-cache", { goalId: GOAL }))).status, 204);
  assert.equal(h.redis.store.has(keyStreak(USER, GOAL)), false);
});
