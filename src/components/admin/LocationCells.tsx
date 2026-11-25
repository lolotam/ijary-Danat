import { EntityLink } from "@/components/admin/EntityLink";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import { propertyDisplayName } from "@/lib/propertyDisplayName";

/**
 * يعرض كل وحدات الفاتورة، لا وحدة واحدة فقط.
 *
 * A multi-unit contract bills one consolidated invoice per month covering every
 * unit (migration 112), and `invoices.unit_id` is NULL for it. Every invoice
 * table read that column and so rendered an em dash for the whole tenant —
 * blank cells that looked like missing data rather than a contract shape the
 * table could not express.
 *
 * Stacked rather than comma-joined because each unit is its own link, and three
 * links reading as one run of text is worse than three short lines.
 */
export function UnitsCell({ units }: { units: Tables<"units">[] }) {
  if (!units.length) return <>—</>;
  return (
    <ul className="space-y-0.5">
      {units.map((unit) => (
        <li key={unit.id}>
          <EntityLink kind="unit" id={unit.id}>
            {unit.name ? `${unit.code} — ${unit.name}` : unit.code}
          </EntityLink>
        </li>
      ))}
    </ul>
  );
}

/** يعرض كل العقارات التي تنتمي إليها وحدات الفاتورة. */
export function PropertiesCell({ properties }: { properties: Tables<"properties">[] }) {
  const { locale } = useI18n();
  if (!properties.length) return <>—</>;
  return (
    <ul className="space-y-0.5">
      {properties.map((property) => (
        <li key={property.id}>
          <EntityLink kind="property" id={property.id}>
            {propertyDisplayName(property, locale)}
          </EntityLink>
        </li>
      ))}
    </ul>
  );
}
