import { Building2, Layers3 } from "lucide-react";

import { PropertyOccupancyToggle } from "@/components/admin/PropertyOccupancyToggle";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import type { PropertyListItem } from "@/hooks/useProperties";
import { formatKwd } from "@/lib/money";

export interface PropertyCardProps {
  property: PropertyListItem;
  monthlyTotal: number | undefined;
  totalsError: boolean;
  locale: string;
  t: (key: string) => string;
  typeLabel: string;
  canUpdate: boolean;
  canDelete: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * بطاقة عقار في شبكة /admin/properties: الصورة، الإشغال، وحبة المستحق الشهري.
 *
 * The pill is absent while totals load, an error line on a failed read, and a
 * zero pill after a successful read that omitted this building — those three
 * states must not collapse into one.
 */
export function PropertyCard({
  property,
  monthlyTotal,
  totalsError,
  locale,
  t,
  typeLabel,
  canUpdate,
  canDelete,
  onOpen,
  onEdit,
  onDelete,
}: PropertyCardProps) {
  const propertyName = locale === "ar" ? property.name_ar : (property.name_en ?? property.name_ar);
  return (
    <div
      className="group cursor-pointer overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md"
      onClick={onOpen}
    >
      {property.image_url ? (
        <img src={property.image_url} alt={propertyName} className="h-36 w-full object-cover" />
      ) : (
        <div className="flex h-36 w-full items-center justify-center bg-muted">
          <Building2 className="size-10 text-muted-foreground" />
        </div>
      )}
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold">{propertyName}</p>
            <p className="font-mono text-xs text-muted-foreground">{property.code}</p>
          </div>
          <Badge variant="secondary">{t(`status.${property.status}`)}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{typeLabel}</Badge>
          <span className="inline-flex items-center gap-1">
            <Layers3 className="size-3.5" />
            {t("properties.unitsCount")}: {property.occupiedUnits + property.vacantUnits}
          </span>
          {property.area != null && (
            <span>
              {t("common.area")}: {property.area}
            </span>
          )}
        </div>
        <PropertyOccupancyToggle
          occupiedUnits={property.occupiedUnits}
          vacantUnits={property.vacantUnits}
        />
        {totalsError ? (
          <p className="text-xs text-destructive">{t("common.error")}</p>
        ) : monthlyTotal != null ? (
          <div
            data-testid="monthly-pill"
            className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white"
          >
            <span>{t("properties.monthlyToCollect")}</span>
            <LtrText>{formatKwd(monthlyTotal, locale)}</LtrText>
          </div>
        ) : null}
        <div
          className="flex justify-end gap-1 border-t pt-2"
          onClick={(event) => event.stopPropagation()}
        >
          <TableActionButton action="edit" disabled={!canUpdate} onClick={onEdit} />
          <TableActionButton action="delete" disabled={!canDelete} onClick={onDelete} />
        </div>
      </div>
    </div>
  );
}
