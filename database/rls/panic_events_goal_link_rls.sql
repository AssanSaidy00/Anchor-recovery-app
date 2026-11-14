-- Replaces the insert/update policies on panic_events so a user can only link an
-- event to one of THEIR OWN recovery goals.
--
-- Run AFTER database/schema/panic_events_goal_link.sql.
-- Note: the subquery on recovery_goals is itself subject to that table's RLS.
-- Once recovery_goals has a "select own rows" policy (Auth/Security + Streak
-- Engine), this works as intended; with RLS on and no policy, goal links fail.

drop policy if exists "log own panic events" on public.panic_events;
create policy "log own panic events"
  on public.panic_events
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      goal_id is null
      or exists (
        select 1
        from public.recovery_goals g
        where g.goal_id = panic_events.goal_id
          and g.user_id = (select auth.uid())
      )
    )
  );

drop policy if exists "update own panic events" on public.panic_events;
create policy "update own panic events"
  on public.panic_events
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (
      goal_id is null
      or exists (
        select 1
        from public.recovery_goals g
        where g.goal_id = panic_events.goal_id
          and g.user_id = (select auth.uid())
      )
    )
  );
