/**
 * يستخرج نص الخطأ من القيمة الملتقطة في `catch` لعرضه في التنبيه، ويعود إلى
 * `fallback` بدل أن يعرض `[object Object]` أو نصاً فارغاً.
 *
 * Server-function errors reach the browser as real `Error` instances (TanStack
 * Start ships them through seroval and rethrows on arrival), so the first
 * branch is the one that runs in practice. The string and `{ message }` cases
 * cover values thrown by hand or by third-party code; anything else has no
 * text worth showing an admin, and `String(err)` on it is what produced the
 * unreadable toasts this helper replaced.
 */
export function extractErrorMessage(err: unknown, fallback = "Unknown error"): string {
  if (err instanceof Error) return err.message.trim() || fallback;
  if (typeof err === "string") return err.trim() || fallback;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}
