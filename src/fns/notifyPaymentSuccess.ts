import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { notifyPaymentSuccess } from "@/fns/notifyPaymentSuccess.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { QueuedDocumentJob } from "@/jobs/handlers/documents";

const paymentIdsSchema = z.object({ paymentIds: z.array(z.string().uuid()).min(1) });

/**
 * دالة خادم محمية بصلاحية إنشاء الدفعات لإطلاق إشعارات نجاح الدفعة من الواجهة.
 *
 * The button is a manual trigger, so the receipt it queues carries no dedupe
 * key: the admin may ask for the receipt again.
 */
export const notifyPaymentSuccessFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => paymentIdsSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "payments.create",
      attempted: "notification.payment_success",
      refusal: "You do not have permission to record a payment.",
    });
    const result = await notifyPaymentSuccess(data.paymentIds, { dedupe: false });
    if (!result.ok) throw new Error(result.error);
    return { queued: true, jobRequestIds: result.ids } satisfies QueuedDocumentJob;
  });
