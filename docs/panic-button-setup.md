# Panic Button: Setup and Usage

What is here and how to use it. Design reasons are in
[architecture/panic-button-redis.md](architecture/panic-button-redis.md).

## What was built

| Piece | Where |
|---|---|
| Tables, security policies, starter messages | `database/schema/`, `database/rls/`, `database/seed/` (already on the shared Supabase) |
| `POST /panic`, `PATCH /panic/:id` | `supabase/functions/panic` |
| Reminders: `GET/POST /reminders`, `DELETE /reminders/:id` | `supabase/functions/reminders` |
| Streak cache refresh/delete, for the Streak Engine | `supabase/functions/streak-cache` |
| Redis (Upstash) client, cache logic, fallbacks | `supabase/functions/_shared/` |
| React screen | `frontend/panic-button/` |
| Tests | `supabase/functions/_shared/*_test.ts`, `frontend/panic-button/PanicButton.test.tsx`, `database/tests/panic_button_rls_test.sql` |

Everything works without Redis (it reads Postgres directly), so you can try it before Upstash is set up.

## One-time setup

1. **Upstash (free).** Create an account at upstash.com, then **Create database** (Redis), pick the region closest to the Supabase project. On the database page copy the **REST URL** and **REST token**.
2. **Put them in Supabase as secrets** (never in git or chat):
   ```
   cp supabase/.env.example supabase/.env      # then edit supabase/.env
   supabase secrets set --env-file supabase/.env --project-ref <project-ref>
   ```
   Or in the dashboard: **Edge Functions → Secrets**. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are added automatically.
3. **Deploy:**
   ```
   supabase functions deploy panic reminders streak-cache --project-ref <project-ref>
   ```
   Keep "Verify JWT" on (the default). The functions also check the token themselves.

Run locally instead: `supabase functions serve --env-file supabase/.env`.

## Try it with curl

Get a user's access token (from the signed-in app, or the dashboard), then:

```
curl -X POST  "$SUPABASE_URL/functions/v1/panic" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY"
curl -X PATCH "$SUPABASE_URL/functions/v1/panic/<eventId>" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
     -H "Content-Type: application/json" -d '{"urgeLevel": 7, "outcome": "resolved"}'
```

The response of `POST /panic` has `source` set to `cache`, `database` or `fallback`, so you can see which path was used. Press twice: the second should say `cache`.

## Using the React screen

1. Copy `frontend/panic-button/` into the app (for example `src/features/panic/`).
2. Render it where the app needs it:
   ```tsx
   import PanicButton from "./features/panic/PanicButton";
   <PanicButton supabase={supabase} />            // or goalId={goal.id} to link a goal
   ```
3. Only the app's existing Supabase client is needed. No Redis or secret ever reaches the browser.

## For the Streak Engine (Sahar)

After each check-in, relapse or goal edit, refresh the cached streak. That keeps Redis out of your code:

```ts
await supabase.functions.invoke("streak-cache", { method: "POST",   body: { goalId } });  // refresh
await supabase.functions.invoke("streak-cache", { method: "DELETE", body: { goalId } });  // goal deleted
```

If you call it from your own server code instead, import `writeStreakCache` / `deleteStreakCache` from `supabase/functions/_shared/streakCache.ts`. A missed call is harmless: the entry expires within 10 minutes (or at the goal's local midnight) and the panic screen falls back to the database.

## After the Streak Engine SQL is on the shared Supabase

1. Run `database/schema/panic_events_goal_link.sql`, then `database/rls/panic_events_goal_link_rls.sql`.
2. Press the panic button with a `goalId` and check that the event row has it.
3. Streaks start appearing in the `POST /panic` response with no code change.

## Run the tests

```
deno test supabase/functions/_shared/          # server logic (41 tests)
npx vitest run frontend/panic-button           # React screen (needs vitest, jsdom, @testing-library/react in the app)
```

The SQL security test is `database/tests/panic_button_rls_test.sql`: paste it into the Supabase SQL editor. It ends with a deliberate error that lists the results and rolls back its own test rows.

## Privacy rules the code follows

- Every database query runs as the signed-in user, so row-level security applies. The service role key is not used.
- Logs contain error codes only, never user ids, notes or message text.
- A user can only link an event to their own goal, and can only edit or delete their own events and reminders.
