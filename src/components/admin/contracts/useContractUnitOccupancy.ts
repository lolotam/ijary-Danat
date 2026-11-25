import { useMemo } from "react";

import { useUnitsActiveContracts } from "@/hooks/useContracts";
import { aggregateUnitsForProperties, cappedOccupancyUnitIds } from "@/lib/contractUnits";

type OccupancyUnit = { id: string; property_id: string };

/**
 * يجلب العقود النشطة على وحدات العقارات المختارة ويستخرج تعارضات الوحدات المختارة.
 *
 * `occupiedUnitIds` greys out taken units in the picker; `conflicts` is the
 * subset the operator has actually selected, which is what blocks the save.
 * `conflicts.data` stays undefined until occupancy has loaded.
 */
export function useContractUnitOccupancy({
  units,
  propertyIds,
  selectedUnitIds,
  excludeContractId,
}: {
  units: OccupancyUnit[] | undefined;
  propertyIds: string[];
  selectedUnitIds: string[];
  excludeContractId: string | undefined;
}) {
  const occupancyUnitIds = useMemo(
    () =>
      cappedOccupancyUnitIds(
        aggregateUnitsForProperties(units ?? [], propertyIds).map((unit) => unit.id),
        selectedUnitIds,
      ),
    [units, propertyIds, selectedUnitIds],
  );
  const occupancy = useUnitsActiveContracts(occupancyUnitIds, excludeContractId);
  const occupiedUnitIds = useMemo(() => new Set(occupancy.data?.keys() ?? []), [occupancy.data]);
  const conflicts = useMemo(() => {
    if (!occupancy.data) return { data: undefined };
    const selected = new Map(
      selectedUnitIds.flatMap((id) => {
        const contract = occupancy.data?.get(id);
        return contract ? [[id, contract] as const] : [];
      }),
    );
    return { data: selected };
  }, [occupancy.data, selectedUnitIds]);
  return { occupiedUnitIds, conflicts };
}
