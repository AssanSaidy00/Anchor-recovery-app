// GET /reminders, POST /reminders, DELETE /reminders/:id
import { remindersRoute, withAuth } from "../_shared/routes.ts";
import { authenticateRequest, buildDeps } from "../_shared/runtime.ts";

Deno.serve(withAuth(
  authenticateRequest,
  (req, auth) => remindersRoute(req, buildDeps(auth), auth.userId),
));
