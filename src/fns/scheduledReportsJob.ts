import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { runScheduledReportsJob } from "@/fns/scheduledReportsJob.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({ asOf: z.string().date().nullable().optional() });

export type ScheduledReportsJobInput = z.infer<typeof schema>;

/** نقطة دخول المستخدم لتشغيل التقارير المجدولة فوراً. */
export const scheduledReportsJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "reports.read",
      attempted: "scheduled_reports.run",
      refusal: "You do not have permission to read reports.",
    });
    return runScheduledReportsJob(data.asOf ?? null);
  });
