// For the Streak Engine: POST /streak-cache {goalId} refreshes the cached streak,
// DELETE /streak-cache {goalId} removes it. Call after a check-in, relapse or goal change.
import { streakCacheRoute, withAuth } from "../_shared/routes.ts";
import { authenticateRequest, buildDeps } from "../_shared/runtime.ts";

Deno.serve(withAuth(
  authenticateRequest,
  (req, auth) => streakCacheRoute(req, buildDeps(auth), auth.userId),
));
