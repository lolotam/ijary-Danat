import type { Json } from "@/integrations/supabase/database.types";

/**
 * PostgREST returns numeric aggregates as strings inside a jsonb payload.
 * Every summary hook funnels through this rather than trusting `as number`.
 */
export function numberValue(value: Json | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
