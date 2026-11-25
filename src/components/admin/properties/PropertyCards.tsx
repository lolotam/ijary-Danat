import { PropertyCard } from "./PropertyCard";
import {
  monthlyTotalForCard,
  usePropertyMonthlyTotals,
  type PropertyListItem,
} from "@/hooks/useProperties";
import { useI18n } from "@/i18n/provider";
import { useCurrentPeriodStart } from "@/lib/periodStart";

interface PropertyCardsProps {
  properties: PropertyListItem[];
  canRead: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  typeLabel: (type: string) => string;
  onOpen: (property: PropertyListItem) => void;
  onEdit: (property: PropertyListItem) => void;
  onDelete: (property: PropertyListItem) => void;
}

/**
 * يربط إجماليات الشهر ببطاقات العقارات؛ الغائب يصبح صفراً فقط بعد نجاح القراءة.
 * يتابع الشهر الجاري حتى لا تبقى الصفحة المفتوحة عبر منتصف الليل على شهر سابق.
 */
export function PropertyCards(props: PropertyCardsProps) {
  const { locale, t } = useI18n();
  const totals = usePropertyMonthlyTotals(useCurrentPeriodStart(), props.canRead);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {props.properties.map((property) => (
        <PropertyCard
          key={property.id}
          property={property}
          monthlyTotal={monthlyTotalForCard(totals.data, totals.isSuccess, property.id)}
          totalsError={totals.isError}
          locale={locale}
          t={t}
          typeLabel={props.typeLabel(property.type)}
          canUpdate={props.canUpdate}
          canDelete={props.canDelete}
          onOpen={() => props.onOpen(property)}
          onEdit={() => props.onEdit(property)}
          onDelete={() => props.onDelete(property)}
        />
      ))}
    </div>
  );
}
