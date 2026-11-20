// Needs: vitest, jsdom, @testing-library/react, @testing-library/user-event
// (environment: "jsdom", css: true or a css stub).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import PanicButton from "./PanicButton";

afterEach(cleanup);

const CONTENT = {
  eventId: "eeeeeeee-0000-4000-8000-000000000001",
  source: "cache",
  motivation: { id: "m1", category: "motivation", body: "You can do this." },
  grounding: { id: "g1", category: "grounding", body: "Breathe slowly." },
  crisis: [{ id: "c1", category: "crisis", body: "Call or text 988." }],
  reminders: [{ id: "r1", body: "My family" }],
  streaks: [{ goalId: "g", goalName: "Quit smoking", currentStreak: 12, longestStreak: 30, asOf: "2026-11-14" }],
};

function fakeSupabase(handler: (name: string, options?: { method?: string; body?: unknown }) => unknown) {
  const invoke = vi.fn(async (name: string, options?: { method?: string; body?: unknown }) => handler(name, options));
  return { client: { functions: { invoke } } as unknown as SupabaseClient, invoke };
}

describe("PanicButton", () => {
  it("shows the message, grounding prompt, streak, reasons and crisis lines after a press", async () => {
    const { client, invoke } = fakeSupabase(() => ({ data: CONTENT, error: null }));
    render(<PanicButton supabase={client} />);

    fireEvent.click(screen.getByRole("button", { name: /i need help now/i }));

    expect(await screen.findByText("You can do this.")).toBeTruthy();
    expect(screen.getByText("Breathe slowly.")).toBeTruthy();
    expect(screen.getByText("Quit smoking", { exact: false })).toBeTruthy();
    expect(screen.getAllByText("My family").length).toBeGreaterThan(0);
    expect(screen.getByText("Call or text 988.")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("panic", { body: {} });
  });

  it("sends the goal id when one is given", async () => {
    const { client, invoke } = fakeSupabase(() => ({ data: CONTENT, error: null }));
    render(<PanicButton supabase={client} goalId="11111111-0000-4000-8000-00000000000a" />);
    fireEvent.click(screen.getByRole("button", { name: /i need help now/i }));
    await screen.findByText("You can do this.");
    expect(invoke).toHaveBeenCalledWith("panic", { body: { goalId: "11111111-0000-4000-8000-00000000000a" } });
  });

  it("still helps (with 988 and SAMHSA) when the server cannot be reached", async () => {
    const { client } = fakeSupabase(() => ({ data: null, error: new Error("network") }));
    render(<PanicButton supabase={client} />);
    fireEvent.click(screen.getByRole("button", { name: /i need help now/i }));

    expect(await screen.findByText(/this urge is temporary/i)).toBeTruthy();
    expect(screen.getByText(/988/)).toBeTruthy();
    expect(screen.getByText(/1-800-662-4357/)).toBeTruthy();
    // No event was saved, so there is nothing to rate.
    expect(screen.queryByLabelText(/how strong is the urge/i)).toBeNull();
  });

  it("also survives the call throwing", async () => {
    const client = { functions: { invoke: vi.fn().mockRejectedValue(new Error("boom")) } } as unknown as SupabaseClient;
    render(<PanicButton supabase={client} />);
    fireEvent.click(screen.getByRole("button", { name: /i need help now/i }));
    expect(await screen.findByText(/988/)).toBeTruthy();
  });

  it("saves the outcome with PATCH /panic/:id", async () => {
    const { client, invoke } = fakeSupabase((name) => (name === "panic" ? { data: CONTENT, error: null } : { data: {}, error: null }));
    render(<PanicButton supabase={client} />);
    fireEvent.click(screen.getByRole("button", { name: /i need help now/i }));
    await screen.findByText("You can do this.");

    fireEvent.click(screen.getByRole("button", { name: /i'm okay now/i }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(`panic/${CONTENT.eventId}`, { method: "PATCH", body: { outcome: "resolved" } }));
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getByRole("button", { name: /i'm okay now/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("saves the urge level when the slider is released", async () => {
    const { client, invoke } = fakeSupabase((name) => (name === "panic" ? { data: CONTENT, error: null } : { data: {}, error: null }));
    render(<PanicButton supabase={client} />);
    fireEvent.click(screen.getByRole("button", { name: /i need help now/i }));
    await screen.findByText("You can do this.");

    const slider = screen.getByLabelText(/how strong is the urge/i);
    fireEvent.change(slider, { target: { value: "8" } });
    fireEvent.keyUp(slider);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(`panic/${CONTENT.eventId}`, { method: "PATCH", body: { urgeLevel: 8 } }));
  });

  it("a failed save is gentle, not an error", async () => {
    const { client } = fakeSupabase((name) => (name === "panic" ? { data: CONTENT, error: null } : { data: null, error: new Error("x") }));
    render(<PanicButton supabase={client} />);
    fireEvent.click(screen.getByRole("button", { name: /i need help now/i }));
    await screen.findByText("You can do this.");
    fireEvent.click(screen.getByRole("button", { name: /still struggling/i }));
    expect(await screen.findByText(/that's okay/i)).toBeTruthy();
  });

  it("adds and removes a reminder", async () => {
    const { client, invoke } = fakeSupabase((name, options) => {
      if (name === "panic") return { data: CONTENT, error: null };
      if (options?.method === "POST") return { data: { reminder: { id: "r2", body: "My health" } }, error: null };
      return { data: null, error: null };
    });
    render(<PanicButton supabase={client} />);
    fireEvent.click(screen.getByRole("button", { name: /i need help now/i }));
    await screen.findByText("You can do this.");

    fireEvent.change(screen.getByLabelText(/a reason i'm doing this/i), { target: { value: "My health" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findAllByText("My health", { exact: false })).length).toBeGreaterThan(0);
    expect(invoke).toHaveBeenCalledWith("reminders", { method: "POST", body: { body: "My health" } });

    fireEvent.click(screen.getByRole("button", { name: "Remove: My health" }));
    await waitFor(() => expect(screen.queryByText("My health", { exact: false })).toBeNull());
    expect(invoke).toHaveBeenCalledWith("reminders/r2", { method: "DELETE" });
  });

  it("Done returns to the start screen", async () => {
    const { client } = fakeSupabase(() => ({ data: CONTENT, error: null }));
    render(<PanicButton supabase={client} />);
    fireEvent.click(screen.getByRole("button", { name: /i need help now/i }));
    await screen.findByText("You can do this.");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: /i need help now/i })).toBeTruthy();
  });
});
