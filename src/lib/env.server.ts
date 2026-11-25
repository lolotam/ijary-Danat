import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1, "SUPABASE_PUBLISHABLE_KEY is required"),
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters long"),
  MYFATOORAH_API_KEY: z.string().optional(),
  MYFATOORAH_WEBHOOK_SECRET: z.string().optional(),
  MYFATOORAH_BASE_URL: z.string().url().default("https://api.myfatoorah.com"),
  // Public origin used to build gateway redirect URLs back into the app.
  APP_BASE_URL: z.string().url().optional(),
});

let isValidated = false;

export function validateEnv() {
  if (isValidated) return;

  // Skip validation during tests or if explicitly requested via SKIP_ENV_VALIDATION
  if (process.env.VITEST === "true" || process.env.SKIP_ENV_VALIDATION === "true") {
    isValidated = true;
    return;
  }

  // Lovable preview reserves the SUPABASE_ / VITE_ prefixes, so callers set
  // SELF_SUPABASE_* aliases there. Normalise so the schema still validates.
  const env = {
    ...process.env,
    SUPABASE_URL: process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY:
      process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SELF_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY:
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SELF_SUPABASE_SERVICE_ROLE_KEY,
  };

  const result = envSchema.safeParse(env);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    console.error("❌ Environment validation failed:");
    console.error(JSON.stringify(errors, null, 2));
    throw new Error(
      `Server environment variables are misconfigured: ${Object.keys(errors).join(", ")}`,
    );
  }
  isValidated = true;
}
