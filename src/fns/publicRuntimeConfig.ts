import { createServerFn } from "@tanstack/react-start";

export interface PublicSupabaseConfig {
  url: string;
  publishableKey: string;
}

// Anon (publishable) config only — never expose SUPABASE_SERVICE_ROLE_KEY here.
// Served from runtime env so rotating Supabase keys needs an env update +
// container restart instead of a rebuild of the browser bundle.
export const getPublicSupabaseConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicSupabaseConfig> => ({
    url:
      process.env.SUPABASE_URL ??
      process.env.SELF_SUPABASE_URL ??
      process.env.VITE_SUPABASE_URL ??
      "",
    publishableKey:
      process.env.SUPABASE_PUBLISHABLE_KEY ??
      process.env.SELF_SUPABASE_PUBLISHABLE_KEY ??
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      "",
  }),
);
