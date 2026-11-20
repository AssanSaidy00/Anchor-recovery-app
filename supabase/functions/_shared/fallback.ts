import type { Message } from "./types.ts";

// Shown only when both Redis and Postgres are unavailable. The panic screen is
// the one place where "show something helpful" beats "show an error".
// Ids are not UUIDs on purpose: they must never be written to panic_events.message_id.
export const FALLBACK_MESSAGES: Message[] = [
  {
    id: "fallback-motivation-1",
    category: "motivation",
    body: "This urge is temporary. It will peak and then fall, even if it does not feel that way right now.",
  },
  {
    id: "fallback-motivation-2",
    category: "motivation",
    body: "You have gotten through hard moments before. You only need to get through this one.",
  },
  {
    id: "fallback-grounding-1",
    category: "grounding",
    body: "Name 5 things you can see, 4 you can touch, 3 you can hear, 2 you can smell and 1 you can taste.",
  },
  {
    id: "fallback-grounding-2",
    category: "grounding",
    body: "Breathe in for 4 seconds, hold for 4, breathe out for 6. Repeat five times.",
  },
  {
    id: "fallback-crisis-1",
    category: "crisis",
    body: "If you are in crisis or thinking about hurting yourself, call or text 988 (Suicide & Crisis Lifeline, US).",
  },
  {
    id: "fallback-crisis-2",
    category: "crisis",
    body: "For help with substance use, call SAMHSA's National Helpline at 1-800-662-4357 (free, 24/7).",
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);
