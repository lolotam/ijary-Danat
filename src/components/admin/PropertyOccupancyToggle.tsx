import { ChevronDown } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/i18n/provider";

/**
 * يفتح دائرتي الإشغال (مؤجّرة / شاغرة) تحت رقم الوحدات في بطاقة العقار.
 *
 * Counts come from active contracts, not `units.status`. The trigger is
 * full-width so the two circles have a labelled section rather than hanging
 * off the units chip, and the click is stopped so it does not open the property.
 */
export function PropertyOccupancyToggle({
  occupiedUnits,
  vacantUnits,
}: {
  occupiedUnits: number;
  vacantUnits: number;
}) {
  const { t } = useI18n();

  return (
    <Collapsible
      className="w-full"
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      <CollapsibleTrigger
        type="button"
        className="flex w-full items-center justify-between rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
      >
        {t("properties.occupancy")}
        <ChevronDown className="size-3.5" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex justify-around gap-4 pt-2">
          <OccupancyCircle label={t("properties.occupied")} count={occupiedUnits} />
          <OccupancyCircle label={t("properties.vacant")} count={vacantUnits} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * دائرة واحدة لعدد الإشغال مع تسميتها تحتها.
 */
function OccupancyCircle({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="grid size-12 place-items-center rounded-full border text-sm font-semibold">
        {count}
      </div>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
