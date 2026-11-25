import { toast } from "sonner";

/**
 * Turn anything thrown into a short, human-readable line suitable for a toast.
 *
 * Handles the common failure shapes this app throws at catch sites:
 *   - `Error` instances (client-side `throw new Error(...)`)
 *   - Supabase `PostgrestError` objects — plain objects shaped
 *     `{ name, message, code, details, hint }`. These are NOT `Error`
 *     instances, which is why the old `error instanceof Error` check silently
 *     dropped their message and only the generic toast title showed.
 *   - plain strings
 *   - anything else (returns `undefined` so the toast falls back to its title)
 *
 * Deliberately separate from `showError` so it can be unit tested in isolation.
 */
export function describeError(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as { message?: string; code?: string; hint?: string };
    if (e.message) return e.code ? `[${e.code}] ${e.message}` : e.message;
    if (e.hint) return e.hint;
  }
  return undefined;
}

/**
 * Log the full error to the console (so DevTools can show its `code`,
 * `details`, `hint` and stack) and surface a short description in a toast.
 *
 * The full object is logged because a string-only log drops the structured
 * fields PostgREST returns, which are exactly what's needed to diagnose
 * schema drift like a missing column (PGRST204).
 */
export function showError(message: string, error: unknown) {
  console.error(message, error);
  toast.error(message, { description: describeError(error) });
}
