// POST /panic and PATCH /panic/:eventId. See docs/architecture/panic-button-redis.md
import { panicRoute, withAuth } from "../_shared/routes.ts";
import { authenticateRequest, buildDeps } from "../_shared/runtime.ts";

Deno.serve(withAuth(
  authenticateRequest,
  (req, auth) => panicRoute(req, buildDeps(auth), auth.userId),
));
