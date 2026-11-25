import type { AuthError } from "@supabase/supabase-js";

/**
 * يعيد رسالة مقروءة لخطأ صادر عن GoTrue بدل النص `{}` الذي يضعه auth-js في
 * `message` عند أخطاء الخادم (5xx).
 *
 * auth-js builds `AuthRetryableFetchError` for 5xx responses from
 * `JSON.stringify(response)`, and a `Response` has no enumerable fields, so
 * the message is literally `"{}"` and the body GoTrue sent ("Database error
 * loading user") is discarded. Every server function that rethrew
 * `error.message` verbatim then put a red `{}` in the admin's toast. This
 * keeps GoTrue's own text whenever it exists and otherwise names the failure
 * by status, which is the only fact auth-js preserved.
 */
export function authErrorMessage(
  error: Pick<AuthError, "message" | "status">,
  fallback: string,
): string {
  const text = error.message.trim();
  if (text && text !== "{}") return text;
  return error.status ? `${fallback} (auth service returned HTTP ${error.status})` : fallback;
}
