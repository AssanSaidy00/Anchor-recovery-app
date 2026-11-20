import type { Redis } from "./types.ts";

export interface UpstashOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** A slow cache must never make the panic screen slow. */
  timeoutMs?: number;
}

/**
 * Minimal Upstash Redis client over its REST API.
 * One command per request: POST <url> with the command as a JSON array.
 * Docs: https://upstash.com/docs/redis/features/restapi
 */
export function createUpstash(options: UpstashOptions): Redis {
  const { url, token, fetchImpl = fetch, timeoutMs = 800 } = options;

  async function command(args: (string | number)[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) {
        // Do not include args: keys can contain user ids.
        throw new Error(`Redis ${args[0]} failed (${response.status})`);
      }
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      const result = await command(["GET", key]);
      if (result === null || result === undefined) return null;
      return JSON.parse(result as string) as T;
    },
    async set(key, value, ttlSeconds) {
      const ttl = Math.max(1, Math.floor(ttlSeconds));
      await command(["SET", key, JSON.stringify(value), "EX", ttl]);
    },
    async del(key) {
      await command(["DEL", key]);
    },
  };
}
