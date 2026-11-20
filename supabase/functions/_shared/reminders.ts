import { cached, keyReminders, safeDel, TTL_REMINDERS } from "./cache.ts";
import { type Deps, HttpError, type Reminder } from "./types.ts";

export const MAX_REMINDERS_PER_USER = 50;
const MAX_BODY = 500; // matches the personal_reminders check constraint

export async function listReminders(deps: Deps, userId: string): Promise<Reminder[]> {
  const { value } = await cached(deps, keyReminders(userId), TTL_REMINDERS, () =>
    deps.db.loadReminders(userId));
  return value;
}

export async function addReminder(deps: Deps, userId: string, rawBody: unknown): Promise<Reminder> {
  if (typeof rawBody !== "string") throw new HttpError(400, "body must be text");
  const body = rawBody.trim();
  if (body.length < 1 || body.length > MAX_BODY) {
    throw new HttpError(400, `body must be 1-${MAX_BODY} characters`);
  }
  // Read fresh from Postgres so the limit cannot be dodged with a stale cache.
  const existing = await deps.db.loadReminders(userId);
  if (existing.length >= MAX_REMINDERS_PER_USER) {
    throw new HttpError(409, `Limit of ${MAX_REMINDERS_PER_USER} reminders reached`);
  }
  const reminder = await deps.db.addReminder(userId, body);
  await safeDel(deps.redis, keyReminders(userId), deps.log);
  return reminder;
}

export async function deleteReminder(deps: Deps, userId: string, reminderId: string): Promise<void> {
  const deleted = await deps.db.deleteReminder(userId, reminderId);
  if (!deleted) throw new HttpError(404, "Reminder not found");
  await safeDel(deps.redis, keyReminders(userId), deps.log);
}
