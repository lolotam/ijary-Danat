import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";

/**
 * ينفّذ تقييم الفواتير المتأخرة للشركة الحالية عبر دور خدمة الشركة.
 *
 * Server-only: it reaches `companyClient.server` and the request company
 * context. Only server code (cronJobs.ts) imports it; the browser-imported
 * `evaluateOverdue.ts` keeps just the server function.
 */
export async function runEvaluateOverdueJob(asOf: string | null = null, companyId?: string) {
  const db = companyClient(companyId ?? requireRequestCompany().id);
  const { data, error } = await db.rpc("evaluate_overdue", { p_as_of: asOf });
  if (error) throw new Error(error.message);
  return { count: data?.length ?? 0, transitions: data };
}
