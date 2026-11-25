// Server-only Supabase admin client. Uses service_role — never import from
// browser-reachable modules. The `.server.ts` extension enforces the boundary.
import { createClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

// SELF_* aliases exist because Lovable reserves the `SUPABASE_` prefix on its
// preview environment; production/Dokploy uses the plain names.
const url = process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL;
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SELF_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.warn("[supabase/client.server] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}

export const supabaseAdmin = createClient<Database>(
  url ?? "http://localhost:54321",
  serviceRoleKey ?? "service-role-key",
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);
