import { createClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

declare global {
  interface Window {
    __SUPABASE_CONFIG?: { url?: string; publishableKey?: string };
  }
}

// The SSR'd HTML injects window.__SUPABASE_CONFIG from the server's runtime
// env (see routes/__root.tsx). It must win over the build-time baked values so
// a rotated Supabase key only needs an env update + restart, never a rebuild.
const runtimeConfig = typeof window !== "undefined" ? window.__SUPABASE_CONFIG : undefined;

const url =
  runtimeConfig?.url ||
  import.meta.env.VITE_SUPABASE_URL ||
  (typeof process !== "undefined"
    ? process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL
    : undefined);

const publishableKey =
  runtimeConfig?.publishableKey ||
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  (typeof process !== "undefined"
    ? process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SELF_SUPABASE_PUBLISHABLE_KEY
    : undefined);

if (!url || !publishableKey) {
  // We intentionally do not throw — the module can be imported during
  // build/SSR without env at module scope. Runtime callers get a clear error.
  console.warn("[supabase/client] Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.");
}

export const supabase = createClient<Database>(
  url ?? "http://localhost:54321",
  publishableKey ?? "public-anon-key",
  {
    auth: {
      persistSession: typeof window !== "undefined",
      autoRefreshToken: typeof window !== "undefined",
      detectSessionInUrl: typeof window !== "undefined",
    },
  },
);
