// Calls to the Panic Button Edge Functions. Uses the app's own Supabase client,
// which adds the signed-in user's token to every request automatically.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PanicMessage {
  id: string;
  category: "motivation" | "grounding" | "crisis";
  body: string;
}
export interface Reminder {
  id: string;
  body: string;
}
export interface StreakInfo {
  goalId: string;
  goalName: string;
  currentStreak: number;
  longestStreak: number;
  asOf: string;
}
export type Outcome = "resolved" | "still_struggling" | "contacted_support";

export interface PanicContent {
  /** null when the server could not be reached, so there is no event to update. */
  eventId: string | null;
  source: "cache" | "database" | "fallback" | "offline";
  motivation: PanicMessage;
  grounding: PanicMessage;
  crisis: PanicMessage[];
  reminders: Reminder[];
  streaks: StreakInfo[];
}

// Shown if the server cannot be reached at all. Keep in sync with
// supabase/functions/_shared/fallback.ts. Helping beats showing an error.
const OFFLINE_CONTENT: PanicContent = {
  eventId: null,
  source: "offline",
  motivation: {
    id: "offline-motivation",
    category: "motivation",
    body: "This urge is temporary. It will peak and then fall, even if it does not feel that way right now.",
  },
  grounding: {
    id: "offline-grounding",
    category: "grounding",
    body: "Name 5 things you can see, 4 you can touch, 3 you can hear, 2 you can smell and 1 you can taste.",
  },
  crisis: [
    {
      id: "offline-crisis-1",
      category: "crisis",
      body: "If you are in crisis or thinking about hurting yourself, call or text 988 (Suicide & Crisis Lifeline, US).",
    },
    {
      id: "offline-crisis-2",
      category: "crisis",
      body: "For help with substance use, call SAMHSA's National Helpline at 1-800-662-4357 (free, 24/7).",
    },
  ],
  reminders: [],
  streaks: [],
};

/** Never throws: if anything goes wrong the user still gets something helpful. */
export async function pressPanic(supabase: SupabaseClient, goalId?: string): Promise<PanicContent> {
  try {
    const { data, error } = await supabase.functions.invoke("panic", {
      body: goalId ? { goalId } : {},
    });
    if (error || !data?.motivation) return OFFLINE_CONTENT;
    return data as PanicContent;
  } catch {
    return OFFLINE_CONTENT;
  }
}

/** Returns true if saved. A failure is not shown as an error: it is optional detail. */
export async function updatePanicEvent(
  supabase: SupabaseClient,
  eventId: string,
  changes: { urgeLevel?: number; triggerNote?: string; outcome?: Outcome },
): Promise<boolean> {
  try {
    const { error } = await supabase.functions.invoke(`panic/${eventId}`, {
      method: "PATCH",
      body: changes,
    });
    return !error;
  } catch {
    return false;
  }
}

export async function addReminder(supabase: SupabaseClient, body: string): Promise<Reminder | null> {
  const { data, error } = await supabase.functions.invoke("reminders", { method: "POST", body: { body } });
  return error ? null : (data.reminder as Reminder);
}

export async function deleteReminder(supabase: SupabaseClient, id: string): Promise<boolean> {
  const { error } = await supabase.functions.invoke(`reminders/${id}`, { method: "DELETE" });
  return !error;
}
