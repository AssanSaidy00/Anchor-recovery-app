-- Links a panic event to the recovery goal it relates to.
--
-- Streaks are tracked per recovery goal (public.recovery_goals, Streak Engine),
-- so a panic press can optionally point at the goal the user is struggling with.
-- The column is nullable: a user can press the button without choosing a goal.
--
-- Run AFTER database/schema/streak_engine.sql (needs public.recovery_goals)
-- and database/schema/panic_button.sql.
-- This is a separate file so the panic button tables can be applied on their own.

alter table public.panic_events
  add column if not exists goal_id uuid
  references public.recovery_goals (goal_id) on delete set null;

create index if not exists panic_events_goal_idx
  on public.panic_events (goal_id, occurred_at desc)
  where goal_id is not null;
