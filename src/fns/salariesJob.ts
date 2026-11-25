import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * توليد الرواتب الشهرية: صف واحد لكل موظف نشط في الشهر.
 *
 * Monthly salary generation.
 *
 * Creates one `salaries` row per active employee for the month `asOf` falls in,
 * copying each employee's current `employees.salary` onto the row. Registered in
 * src/fns/cronJobs.ts as "salaries".
 *
 * Idempotent, and that is the point rather than a nicety: the underlying
 * `generate_salaries_for_month` inserts with `on conflict do nothing` against
 * `unique (employee_id, year, month)`, so a retried tick — or a second cron
 * entry, or a manual run on the same day — cannot pay anyone twice.
 *
 * Scheduled in production at 01:30 on the 1st of each month by
 * `/etc/cron.d/danat-ermp` (installed 2026-07-29; see deploy/README.md). The
 * Salary tab's manual "generate this month" action stays as a second path —
 * safe for the idempotency reason above.
 */
export interface SalariesJobResult {
  created: number;
  year: number;
  month: number;
}

/**
 * يولّد صفوف رواتب الشهر الذي يقع فيه `asOf` ويرجع عدد الصفوف الجديدة.
 *
 * Safe to run more than once for the same month; see the note above.
 */
export async function runSalariesJob(asOf?: string | null): Promise<SalariesJobResult> {
  // The job is driven by `asOf` rather than the database's `current_date` so a
  // late-running or replayed tick generates the month it was meant to, not the
  // month it happened to execute in.
  const reference = asOf ? new Date(asOf) : new Date();
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth() + 1;

  const { data, error } = await supabaseAdmin.rpc("generate_salaries_for_month", {
    p_year: year,
    p_month: month,
  });
  if (error) throw new Error(error.message);

  return { created: Array.isArray(data) ? data.length : 0, year, month };
}
