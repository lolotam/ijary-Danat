import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";

/**
 * نتيجة توليد الرواتب الشهرية للشركة الحالية.
 */
export interface SalariesJobResult {
  created: number;
  year: number;
  month: number;
}

/**
 * يولّد صفوف رواتب الشهر الذي يقع فيه `asOf` للشركة الحالية ويرجع عدد الصفوف الجديدة.
 */
export async function runSalariesJob(
  asOf?: string | null,
  companyId?: string,
): Promise<SalariesJobResult> {
  const reference = asOf ? new Date(asOf) : new Date();
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth() + 1;

  const db = companyClient(companyId ?? requireRequestCompany().id);
  const { data, error } = await db.rpc("generate_salaries_for_month", {
    p_year: year,
    p_month: month,
  });
  if (error) throw new Error(error.message);

  return { created: Array.isArray(data) ? data.length : 0, year, month };
}
