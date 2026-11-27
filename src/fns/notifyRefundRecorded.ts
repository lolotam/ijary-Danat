import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { notifyRefundRecordedRecord } from "@/fns/notifyRefundRecorded.server";
import { requireAnyPermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const schema = z.object({ refundId: z.string().uuid() });

/** دالة خادم محمية بصلاحية الاسترداد تطلق تنبيه تسجيل الاسترداد من الواجهة. */
export const notifyRefundRecorded = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    // Recording a refund and editing one both send this alert.
    await requireAnyPermission(context, {
      codes: ["refunds.update", "refunds.create"],
      attempted: "notification.refund_recorded",
      refusal: "You do not have permission to record a refund.",
      entityType: "refund",
      entityId: data.refundId,
    });
    return notifyRefundRecordedRecord(data.refundId);
  });
