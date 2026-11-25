import type { ZodType } from "zod";

/**
 * يتحقق من مدخلات دالة الخادم بمخطط Zod ويرمي خطأً عادياً بنص مقروء بدل
 * `ZodError` الذي لا يمكن للإطار إرساله إلى المتصفح.
 *
 * `ZodError` carries own enumerable methods (`addIssue`, `addIssues`), and
 * seroval — which TanStack Start uses to ship a thrown error to the client —
 * refuses to serialize functions. The framework's own error path then throws
 * inside its catch block, and what reaches the browser is Nitro's generic 500
 * rather than anything about the field that failed. Flattening the issues into
 * a plain `Error` here keeps the message ("username: Username must be
 * alphanumeric") intact all the way to the toast.
 */
export function parseServerInput<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issueSummary = result.error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
  throw new Error(issueSummary || "Invalid input");
}
