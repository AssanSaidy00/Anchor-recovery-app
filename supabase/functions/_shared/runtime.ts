// Production wiring: Deno, Supabase and Upstash. Kept out of the unit tests.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createDb } from "./db.ts";
import { createUpstash } from "./redis.ts";
import { type Deps, HttpError, type Redis } from "./types.ts";

export interface AuthContext {
  userId: string;
  client: SupabaseClient;
}

const log = (message: string) => console.error(`[anchor] ${message}`);

/** Checks the login token and returns a client that acts as that user (RLS applies). */
export async function authenticateRequest(req: Request): Promise<AuthContext> {
  const header = req.headers.get("Authorization");
  const token = header?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Not signed in");

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Not signed in");
  return { userId: data.user.id, client };
}

let redis: Redis | null | undefined;

/** Without Upstash settings the functions still work, straight from Postgres. */
function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = Deno.env.get("UPSTASH_REDIS_REST_URL");
  const token = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
  redis = url && token ? createUpstash({ url, token }) : null;
  if (!redis) log("Upstash is not configured, running without cache");
  return redis;
}

export function buildDeps(auth: AuthContext): Deps {
  return {
    db: createDb(auth.client, log),
    redis: getRedis(),
    rng: Math.random,
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
    defer: (work) => {
      // Supabase Edge Functions keep running background work after the response.
      // deno-lint-ignore no-explicit-any
      const runtime = (globalThis as any).EdgeRuntime;
      const safe = work.catch(() => log("background work failed"));
      if (runtime?.waitUntil) runtime.waitUntil(safe);
    },
    log,
    retryDelayMs: 500,
  };
}
