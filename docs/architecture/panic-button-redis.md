# Panic Button & Redis Caching: Design Note

Sprint 1 (Weeks 3-6). Owner: Panic Button / Redis. Database files live in
`database/schema/panic_button.sql`, `database/rls/panic_button_rls.sql` and
`database/seed/motivational_messages.sql`. Linking events to recovery goals is
a separate step: `database/schema/panic_events_goal_link.sql` and
`database/rls/panic_events_goal_link_rls.sql` (run after the Streak Engine schema).

## Goal

When a user presses the panic button, show a supportive message immediately and
record the event. The screen must still work if Redis or the database is slow
or down.

## Request flow

Implemented as Supabase Edge Functions (`supabase/functions/panic`, `reminders`,
`streak-cache`; shared code in `supabase/functions/_shared`). Setup and usage:
`docs/panic-button-setup.md`.

`POST /panic` (signed-in user, guest sessions allowed)

1. Read cached content from Redis (messages, the user's reminders, and the
   current streak of each of the user's active recovery goals).
2. On a cache miss, load from Postgres, then write it back to Redis with a TTL.
3. Pick one message per category (motivation, grounding) plus the crisis resources.
4. Respond right away with the content.
5. Log the event to `panic_events` after the response is prepared (a failure to
   log must never block or break the response).
6. Optional follow-up: `PATCH /panic/:id` to record `urge_level`, `trigger_note`
   and `outcome` once the user has a moment.

## Redis keys

| Key | Value | TTL | Invalidated when |
|---|---|---|---|
| `anchor:panic:messages:v1` | JSON array of active messages | 1 hour | message content changes (bump `v1`) |
| `anchor:user:{userId}:reminders` | JSON array of the user's reminders | 1 hour | user adds, edits or deletes a reminder |
| `anchor:user:{userId}:goal:{goalId}:streak` | JSON, see the contract below | 10 min, or until the goal's local midnight if sooner | user checks in or logs a relapse for that goal |
| `anchor:user:{userId}:goals` | JSON array of `{ goalId, timeZone }` (lets the panic endpoint find the user's streak keys without a database read) | 10 min | goal created, edited or deleted (the streak helpers clear it) |

- Streaks are per recovery goal, matching the Streak Engine's `recovery_goals`
  and `daily_checkins` tables. The JSON fields mirror the `streak_stats` view
  (`goal_name`, `current_streak`, `longest_streak`); `asOf` is its `local_today`.
- **Proposed (pending Sahar's confirmation):** the Redis helper is owned by the
  Panic Button & Redis role. The Streak Engine does not talk to Redis; it calls
  `POST /streak-cache {goalId}` (or `writeStreakCache(deps, userId, goalId)`) after a
  check-in, a relapse or a goal edit, and `DELETE /streak-cache {goalId}` when a
  goal is deleted. The helper reads `streak_stats` and overwrites the entry. The
  panic endpoint only reads the key, and falls back to querying `streak_stats`
  on a miss.
- `current_streak` depends on "today" in the goal's own time zone (one grace
  day, relapse resets to 0), so a cached value can become wrong at local
  midnight. That is why the TTL ends at the goal's local midnight.
- Keys containing a `userId` hold private recovery data: short TTLs, and never
  log their values.

### Streak cache contract (writer: the Redis helper, called by the Streak Engine; reader: Panic Button)

Both modules must use exactly this shape, so neither side guesses:

```json
{
  "goalId": "11111111-0000-0000-0000-00000000000a",
  "goalName": "Quit smoking",
  "currentStreak": 12,
  "longestStreak": 30,
  "asOf": "2026-11-14"
}
```

- Field names are camelCase, exactly as above.
- `currentStreak` and `longestStreak` are whole days, as JSON numbers (not strings).
  They come from `streak_stats.current_streak` and `longest_streak`.
- `asOf` is a calendar date, ISO 8601 `YYYY-MM-DD`, in the goal's own time zone
  (`streak_stats.local_today`). It is a date only, with no time or offset.
- There is no `lastCheckIn` field: `streak_stats` does not expose it. If the panic
  screen needs it later, add it as an ISO `YYYY-MM-DD` date and update this contract.
- The Panic Button must ignore unknown extra fields, so the Streak Engine can add
  fields without breaking it.

## Fallback behavior

| Failure | Behavior |
|---|---|
| Redis unreachable or errors | Read from Postgres directly |
| Postgres also fails | Return a small built-in set of messages hard-coded in the app, including the 988 and SAMHSA lines |
| Event logging fails | Return the content anyway and retry the insert once in the background |

The panic screen is the one place where "show something helpful" beats
"show an error".

## Latency expectations

A cache hit avoids a database round trip, which is the real win. Upstash is
accessed over HTTPS (REST), so the end-to-end time includes network latency to
the Upstash region; the proposal's "sub-10ms" target is realistic for the Redis
operation itself, not necessarily for the full request. Measure both and report
both in the final write-up. Pick the Upstash region closest to where the app is
deployed.

## Test cases (Deno test: `deno test supabase/functions/_shared/`)

- Cache hit returns content without calling the database.
- Cache miss loads from the database and populates Redis.
- Redis error falls back to the database; both failing returns built-in messages.
- A failed event insert does not change the response.
- Reminders cache is cleared after a reminder is added or deleted.
- A streak cache entry expires at the goal's local midnight, not only after 10 minutes.
- A panic event can only be linked to a goal owned by the same user.
- RLS: a user cannot read or modify another user's `panic_events` or `personal_reminders`
  (`database/tests/panic_button_rls_test.sql`, run in the Supabase SQL editor).
- The React screen (`frontend/panic-button/PanicButton.test.tsx`, Vitest): shows the
  content, still helps when the server cannot be reached, saves outcome and urge level.

## Open questions for the team

- Backend stack: **proposed** Supabase Edge Functions (the Upstash token must stay
  server-side, and no separate server is needed). Waiting for the team to agree.
- Redis client and env vars (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`):
  owned by the Panic Button & Redis role (`supabase/functions/_shared/redis.ts`).
- Confirm the per-goal streak cache entry above with the Streak Engine owner
  (Sahar), including who writes it and when it is invalidated.
- Her grace-day and time-zone rules are still "pending team approval". Proposed:
  one time zone per user on the profile. Today the TTL uses `recovery_goals.time_zone`;
  moving it to the profile only changes `loadGoals` in `supabase/functions/_shared/db.ts`.
- `streak_stats` has no `user_id` column and is a normal view, so by default it runs
  with its owner's rights and may let any signed-in user read other users' streaks.
  For Sahar: add `security_invoker = true` (or a `user_id` column plus a filter) so it
  respects RLS. The functions here filter by the user's own goal ids either way.
- Whether `panic_events` gets partitioned in Sprint 2 (the primary key already allows it).
