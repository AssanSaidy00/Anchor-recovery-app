// Postgres access through the user's own Supabase client, so Row Level
// Security applies to every query. The service role key is never used here.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Db, GoalInfo, Message, Reminder, StreakStatsRow } from "./types.ts";

function fail(what: string, error: { code?: string; message?: string }): never {
  // Only the code goes into the message: row contents must not reach logs.
  throw new Error(`${what} failed (${error.code ?? "unknown"})`);
}

export function createDb(client: SupabaseClient, log: (message: string) => void): Db {
  return {
    async loadMessages() {
      const { data, error } = await client
        .from("motivational_messages")
        .select("id, category, body")
        .eq("is_active", true);
      if (error) fail("loading messages", error);
      return (data ?? []) as Message[];
    },

    async loadReminders(userId) {
      const { data, error } = await client
        .from("personal_reminders")
        .select("id, body, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) fail("loading reminders", error);
      return (data ?? []) as Reminder[];
    },

    // The Streak Engine tables may not exist yet (or the schema may change),
    // so any error here means "no goals" and the panic screen still works.
    // When the time zone moves to the profile (team decision pending), only
    // this method needs to change.
    async loadGoals(userId) {
      const { data, error } = await client
        .from("recovery_goals")
        .select("goal_id, time_zone")
        .eq("user_id", userId);
      if (error) {
        log(`loading goals skipped (${error.code ?? "unknown"})`);
        return [];
      }
      return (data ?? []).map((row: { goal_id: string; time_zone: string }): GoalInfo => ({
        goalId: row.goal_id,
        timeZone: row.time_zone,
      }));
    },

    // streak_stats has no user_id column, so callers must pass only goal ids
    // that came from loadGoals (which RLS limits to the signed-in user).
    async loadStreakStats(goalIds) {
      if (goalIds.length === 0) return [];
      const { data, error } = await client
        .from("streak_stats")
        .select("goal_id, goal_name, local_today, current_streak, longest_streak")
        .in("goal_id", goalIds);
      if (error) fail("loading streaks", error);
      return (data ?? []) as StreakStatsRow[];
    },

    async goalOwnedByUser(userId, goalId) {
      const { data, error } = await client
        .from("recovery_goals")
        .select("goal_id")
        .eq("goal_id", goalId)
        .eq("user_id", userId)
        .maybeSingle();
      return !error && data !== null;
    },

    async insertEvent(event) {
      const row: Record<string, unknown> = {
        id: event.id,
        user_id: event.userId,
        occurred_at: event.occurredAt,
        message_id: event.messageId,
      };
      // goal_id only exists after database/schema/panic_events_goal_link.sql.
      if (event.goalId) row.goal_id = event.goalId;
      const { error } = await client.from("panic_events").insert(row);
      if (error) fail("saving panic event", error);
    },

    async updateEvent(userId, eventId, patch) {
      const changes: Record<string, unknown> = {};
      if (patch.urgeLevel !== undefined) changes.urge_level = patch.urgeLevel;
      if (patch.triggerNote !== undefined) changes.trigger_note = patch.triggerNote;
      if (patch.outcome !== undefined) changes.outcome = patch.outcome;
      const { data, error } = await client
        .from("panic_events")
        .update(changes)
        .eq("id", eventId)
        .eq("user_id", userId)
        .select("id");
      if (error) fail("updating panic event", error);
      return (data?.length ?? 0) > 0;
    },

    async addReminder(userId, body) {
      const { data, error } = await client
        .from("personal_reminders")
        .insert({ user_id: userId, body })
        .select("id, body, created_at")
        .single();
      if (error) fail("saving reminder", error);
      return data as Reminder;
    },

    async deleteReminder(userId, reminderId) {
      const { data, error } = await client
        .from("personal_reminders")
        .delete()
        .eq("id", reminderId)
        .eq("user_id", userId)
        .select("id");
      if (error) fail("deleting reminder", error);
      return (data?.length ?? 0) > 0;
    },
  };
}
