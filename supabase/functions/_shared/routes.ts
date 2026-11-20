import { getPanicContent, updatePanicEvent } from "./panic.ts";
import { addReminder, deleteReminder, listReminders } from "./reminders.ts";
import { deleteStreakCache, writeStreakCache } from "./streakCache.ts";
import { isUuid } from "./fallback.ts";
import { type Deps, HttpError } from "./types.ts";

// The app calls these functions from the browser, so CORS is needed.
// Requests are protected by the user's login token, not by the origin.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const noContent = () => new Response(null, { status: 204, headers: CORS_HEADERS });

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

/** Path segments after the function name: /panic/abc -> ["abc"]. */
export function subPath(req: Request, functionName: string): string[] {
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const at = segments.indexOf(functionName);
  return at === -1 ? segments : segments.slice(at + 1);
}

export type Authenticate<C extends { userId: string }> = (req: Request) => Promise<C>;

/**
 * Handles CORS preflight, login check and error mapping for every function.
 * Unexpected errors return a generic message so internals never leak.
 */
export function withAuth<C extends { userId: string }>(
  authenticate: Authenticate<C>,
  run: (req: Request, context: C) => Promise<Response>,
  log: (message: string) => void = console.error,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return noContent();
    try {
      const context = await authenticate(req);
      return await run(req, context);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      log("unexpected error in function");
      return json(500, { error: "Something went wrong" });
    }
  };
}

// POST /panic            -> press the button
// PATCH /panic/:eventId  -> add urge level, note, outcome afterwards
export async function panicRoute(req: Request, deps: Deps, userId: string): Promise<Response> {
  const segments = subPath(req, "panic");

  if (req.method === "POST" && segments.length === 0) {
    const body = await readJson(req) as { goalId?: unknown };
    const goalId = body && typeof body === "object" ? body.goalId : undefined;
    if (goalId !== undefined && goalId !== null && typeof goalId !== "string") {
      throw new HttpError(400, "goalId must be a UUID");
    }
    return json(200, await getPanicContent(deps, userId, goalId as string | null | undefined));
  }
  if (req.method === "PATCH" && segments.length === 1) {
    await updatePanicEvent(deps, userId, segments[0], await readJson(req));
    return json(200, { ok: true });
  }
  throw new HttpError(404, "Not found");
}

// GET /reminders, POST /reminders {body}, DELETE /reminders/:id
export async function remindersRoute(req: Request, deps: Deps, userId: string): Promise<Response> {
  const segments = subPath(req, "reminders");

  if (req.method === "GET" && segments.length === 0) {
    return json(200, { reminders: await listReminders(deps, userId) });
  }
  if (req.method === "POST" && segments.length === 0) {
    const body = await readJson(req) as { body?: unknown };
    return json(201, { reminder: await addReminder(deps, userId, body?.body) });
  }
  if (req.method === "DELETE" && segments.length === 1) {
    if (!isUuid(segments[0])) throw new HttpError(400, "Invalid reminder id");
    await deleteReminder(deps, userId, segments[0]);
    return noContent();
  }
  throw new HttpError(404, "Not found");
}

// For the Streak Engine. POST /streak-cache {goalId} refreshes the entry,
// DELETE /streak-cache {goalId} removes it (use when a goal is deleted).
export async function streakCacheRoute(req: Request, deps: Deps, userId: string): Promise<Response> {
  if (subPath(req, "streak-cache").length !== 0) throw new HttpError(404, "Not found");
  if (req.method !== "POST" && req.method !== "DELETE") throw new HttpError(404, "Not found");

  const body = await readJson(req) as { goalId?: unknown };
  const goalId = body?.goalId;
  if (typeof goalId !== "string" || !isUuid(goalId)) {
    throw new HttpError(400, "goalId must be a UUID");
  }
  if (req.method === "POST") {
    return json(200, { streak: await writeStreakCache(deps, userId, goalId) });
  }
  await deleteStreakCache(deps, userId, goalId);
  return noContent();
}
