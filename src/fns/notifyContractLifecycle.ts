import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  notifyContractCreatedRecord,
  notifyContractEndedRecord,
  type ContractEvent,
} from "@/fns/notifyContractLifecycle.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const schema = z.object({
  contractId: z.string().uuid(),
  event: z.enum(["created", "ended"]),
});

/** الصلاحية التي تسمح بإطلاق تنبيه هذا الحدث يدوياً. */
function requiredContractPermission(event: ContractEvent) {
  return event === "created" ? "contracts.create" : "contracts.update";
}

/** دالة خادم محمية بصلاحية العقود تطلق تنبيه إنشاء العقد أو انتهائه من الواجهة. */
export const notifyContractLifecycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: requiredContractPermission(data.event),
      attempted: "notification.contract_lifecycle",
      refusal: "You do not have permission to change this contract.",
    });
    return data.event === "created"
      ? notifyContractCreatedRecord(data.contractId)
      : notifyContractEndedRecord(data.contractId);
  });
