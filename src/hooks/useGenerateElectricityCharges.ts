import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { logAuditForCurrentSession } from "@/lib/audit";
import { generateElectricityChargesForCurrentSession } from "@/lib/generateElectricityCharges";
import { PERMISSIONS } from "@/lib/permissions";

export function useGenerateElectricityCharges() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: {
      periodMonth: number;
      periodYear: number;
      unitId?: string | null;
    }) => {
      if (!permissions.can(PERMISSIONS.ELECTRICITY_CREATE)) {
        throw new Error("Permission denied.");
      }
      const generatedCharges = await generateElectricityChargesForCurrentSession(input);
      await logAuditForCurrentSession({
        action: "electricity_charge.generate",
        entityType: "electricity_charge_batch",
        after: { input, generated: generatedCharges.length },
      });
      return generatedCharges;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["electricity-charges"] }),
  });
}
