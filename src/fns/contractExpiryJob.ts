import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { runContractExpiryJob } from "@/fns/contractExpiryJob.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({ asOf: z.string().date().nullable().optional() });

export type ContractExpiryJobInput = z.infer<typeof schema>;

/** نقطة دخول المستخدم لتشغيل تنبيهات انتهاء العقود فوراً بعد التحقق من الصلاحية. */
export const contractExpiryJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "notifications.create",
      attempted: "contract_expiry.run",
      refusal: "You do not have permission to queue notifications.",
    });
    return runContractExpiryJob(data.asOf ?? null);
  });
