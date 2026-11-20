// Drop-in Panic Button screen.
//   <PanicButton supabase={supabase} goalId={optionalGoalId} />
// Copy this folder into the React app (for example src/features/panic) and
// import "./panic-button.css" once. See docs/panic-button-setup.md.
import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addReminder,
  deleteReminder,
  type Outcome,
  type PanicContent,
  pressPanic,
  type Reminder,
  updatePanicEvent,
} from "./panicApi";
import "./panic-button.css";

interface Props {
  supabase: SupabaseClient;
  /** Optional: link the press to a recovery goal the user is struggling with. */
  goalId?: string;
}

const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: "resolved", label: "I'm okay now" },
  { value: "still_struggling", label: "Still struggling" },
  { value: "contacted_support", label: "I reached out to someone" },
];

export default function PanicButton({ supabase, goalId }: Props) {
  const [content, setContent] = useState<PanicContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [urge, setUrge] = useState(5);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [saveNote, setSaveNote] = useState("");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [draft, setDraft] = useState("");
  const [reminderError, setReminderError] = useState("");

  async function press() {
    setLoading(true);
    const result = await pressPanic(supabase, goalId);
    setContent(result);
    setReminders(result.reminders);
    setUrge(5);
    setOutcome(null);
    setSaveNote("");
    setLoading(false);
  }

  async function save(changes: { urgeLevel?: number; outcome?: Outcome }) {
    if (!content?.eventId) return;
    const ok = await updatePanicEvent(supabase, content.eventId, changes);
    setSaveNote(ok ? "Saved" : "Could not save this, but that's okay.");
  }

  async function onAddReminder(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setReminderError("");
    const added = await addReminder(supabase, draft);
    if (!added) return setReminderError("Could not add that. Please try again.");
    setReminders((list) => [added, ...list]);
    setDraft("");
  }

  async function onDeleteReminder(id: string) {
    if (await deleteReminder(supabase, id)) setReminders((list) => list.filter((r) => r.id !== id));
  }

  if (!content) {
    return (
      <section className="anchor-panic anchor-panic--idle" aria-labelledby="panic-title">
        <h2 id="panic-title">Having a hard moment?</h2>
        <p>Press the button. You don't have to explain anything.</p>
        <button className="anchor-panic__big" onClick={press} disabled={loading}>
          {loading ? "One moment…" : "I need help now"}
        </button>
      </section>
    );
  }

  return (
    <section className="anchor-panic" aria-labelledby="panic-title">
      <h2 id="panic-title" className="anchor-panic__visually-hidden">Support for this moment</h2>

      <div role="status" aria-live="polite">
        <p className="anchor-panic__message">{content.motivation.body}</p>
      </div>

      <div className="anchor-panic__card">
        <h3>Try this now</h3>
        <p>{content.grounding.body}</p>
      </div>

      {content.streaks.length > 0 && (
        <ul className="anchor-panic__streaks" aria-label="Your streaks">
          {content.streaks.map((s) => (
            <li key={s.goalId}>
              <strong>{s.currentStreak}</strong> {s.currentStreak === 1 ? "day" : "days"} · {s.goalName}
            </li>
          ))}
        </ul>
      )}

      {reminders.length > 0 && (
        <div className="anchor-panic__card">
          <h3>Your reasons</h3>
          <ul>
            {reminders.map((r) => <li key={r.id}>{r.body}</li>)}
          </ul>
        </div>
      )}

      {content.eventId && (
        <div className="anchor-panic__card">
          <label htmlFor="urge">How strong is the urge right now? <strong>{urge}</strong>/10</label>
          <input
            id="urge"
            type="range"
            min={0}
            max={10}
            step={1}
            value={urge}
            onChange={(e) => setUrge(Number(e.target.value))}
            onPointerUp={() => save({ urgeLevel: urge })}
            onKeyUp={() => save({ urgeLevel: urge })}
          />
          <div className="anchor-panic__outcomes" role="group" aria-label="How are you doing?">
            {OUTCOMES.map((o) => (
              <button
                key={o.value}
                className={outcome === o.value ? "is-selected" : ""}
                aria-pressed={outcome === o.value}
                onClick={() => {
                  setOutcome(o.value);
                  save({ outcome: o.value });
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="anchor-panic__note" role="status" aria-live="polite">{saveNote}</p>
        </div>
      )}

      <div className="anchor-panic__crisis" role="note">
        <h3>If you are in crisis</h3>
        <ul>
          {content.crisis.map((m) => <li key={m.id}>{m.body}</li>)}
        </ul>
      </div>

      <details className="anchor-panic__manage">
        <summary>Add or remove my reasons</summary>
        <form onSubmit={onAddReminder}>
          <label htmlFor="reason">A reason I'm doing this</label>
          <input id="reason" value={draft} maxLength={500} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit">Add</button>
        </form>
        {reminderError && <p role="alert">{reminderError}</p>}
        <ul>
          {reminders.map((r) => (
            <li key={r.id}>
              {r.body}{" "}
              <button onClick={() => onDeleteReminder(r.id)} aria-label={`Remove: ${r.body}`}>Remove</button>
            </li>
          ))}
        </ul>
      </details>

      <button className="anchor-panic__done" onClick={() => setContent(null)}>Done</button>
    </section>
  );
}
