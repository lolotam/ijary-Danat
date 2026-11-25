import type { Locale } from "@/i18n/dictionary";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import { aggregateUnitsForProperties } from "@/lib/contractUnits";
import { propertyDisplayName, sortPropertiesByCodeNatural } from "@/lib/propertyDisplayName";

export interface ContractUnitValue {
  unit_id: string;
  monthly_amount: number;
}

/**
 * Rent rows for the currently selected units, preserving amounts already
 * typed. Selection order becomes line_order, which is the order the rent
 * lines appear in on the invoice.
 */
export function syncUnitRows(
  current: ContractUnitValue[],
  selectedUnitIds: string[],
): ContractUnitValue[] {
  const byId = new Map(current.map((row) => [row.unit_id, row]));
  return selectedUnitIds.map((unit_id) => byId.get(unit_id) ?? { unit_id, monthly_amount: 0 });
}

export interface ContractUnitsFieldProperty {
  id: string;
  code: string;
  name_ar: string;
  name_en?: string | null;
}

export interface ContractUnitsFieldUnit {
  id: string;
  property_id: string;
  code: string;
  name: string;
}

/**
 * Rent rows after the selected-properties set changes, composed from
 * `aggregateUnitsForProperties` (Task 7) and `syncUnitRows` above.
 *
 * Pulled out as its own pure function so the cascade the brief calls out in
 * prose — "deselecting a property removes its units and their amount
 * rows" — has a test that does not require rendering the component (this
 * project's Vitest runs in the node environment, no jsdom).
 */
export function unitsAfterPropertyChange(
  units: ContractUnitsFieldUnit[],
  nextPropertyIds: string[],
  currentRows: ContractUnitValue[],
): ContractUnitValue[] {
  const available = new Set(
    aggregateUnitsForProperties(units, nextPropertyIds).map((unit) => unit.id),
  );
  const nextSelectedIds = currentRows.map((row) => row.unit_id).filter((id) => available.has(id));
  return syncUnitRows(currentRows, nextSelectedIds);
}

export interface ContractUnitsFieldLabels {
  properties: string;
  units: string;
  occupied: string;
  noProperties: string;
  noUnits: string;
  selectPropertiesFirst: string;
  amount: string;
}

/**
 * Multi-select of properties -> multi-select of units (the union across the
 * selected properties, each option labelled with its property so identical
 * unit codes in different properties stay distinguishable) -> one titled
 * "Monthly Amount" section per selected unit, plus a running total.
 *
 * Not wired through react-hook-form's `Controller`/`useFieldArray`: the two
 * fields it owns (`property_ids`, `units`) are plain arrays on the parent
 * form's values, and the parent already reads/writes them with
 * `form.watch`/`form.setValue` the same way it drives `overrideEnd` — adding
 * a second wiring mechanism for two fields would be more machinery, not less.
 */
export function ContractUnitsField({
  properties,
  units,
  propertyIds,
  onPropertyIdsChange,
  unitRows,
  onUnitRowsChange,
  amountErrors,
  occupiedUnitIds,
  locale,
  labels,
}: {
  properties: ContractUnitsFieldProperty[];
  units: ContractUnitsFieldUnit[];
  propertyIds: string[];
  onPropertyIdsChange: (ids: string[]) => void;
  unitRows: ContractUnitValue[];
  onUnitRowsChange: (rows: ContractUnitValue[]) => void;
  /** Per-row Zod messages for `units[i].monthly_amount`, aligned with `unitRows`. */
  amountErrors?: Array<string | undefined>;
  /**
   * Units already held by another live contract. They stay selectable: the
   * owner asked for the badge *in addition to* the conflict error at submit,
   * not instead of it, so an operator can still see what they picked and why
   * it is refused.
   */
  occupiedUnitIds: Set<string>;
  locale: Locale;
  labels: ContractUnitsFieldLabels;
}) {
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const orderedProperties = sortPropertiesByCodeNatural(properties);
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const availableUnits = aggregateUnitsForProperties(units, propertyIds);
  const selectedUnitIds = new Set(unitRows.map((row) => row.unit_id));

  function togglePropertyId(id: string, checked: boolean) {
    const nextIds = checked
      ? [...propertyIds, id]
      : propertyIds.filter((propertyId) => propertyId !== id);
    onPropertyIdsChange(nextIds);
    onUnitRowsChange(unitsAfterPropertyChange(units, nextIds, unitRows));
  }

  function toggleUnitId(id: string, checked: boolean) {
    const currentIds = unitRows.map((row) => row.unit_id);
    const nextIds = checked ? [...currentIds, id] : currentIds.filter((unitId) => unitId !== id);
    onUnitRowsChange(syncUnitRows(unitRows, nextIds));
  }

  function setAmount(unitId: string, amount: number) {
    onUnitRowsChange(
      unitRows.map((row) => (row.unit_id === unitId ? { ...row, monthly_amount: amount } : row)),
    );
  }

  function unitLabel(unitId: string): string {
    const unit = unitById.get(unitId);
    if (!unit) return unitId;
    const property = propertyById.get(unit.property_id);
    const propertyPrefix = property ? `${property.code} — ` : "";
    return `${propertyPrefix}${unit.code} — ${unit.name}`;
  }

  return (
    <div className="space-y-4 sm:col-span-2 lg:col-span-3">
      <div className="space-y-2">
        <Label required>{labels.properties}</Label>
        <div className="max-h-40 overflow-y-auto rounded-lg border">
          {orderedProperties.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{labels.noProperties}</p>
          ) : (
            orderedProperties.map((property) => (
              <label
                key={property.id}
                className="flex cursor-pointer items-center gap-3 border-b p-2 text-sm last:border-b-0 hover:bg-muted/50"
              >
                <Checkbox
                  checked={propertyIds.includes(property.id)}
                  onCheckedChange={(checked) => togglePropertyId(property.id, checked === true)}
                />
                <span>
                  {property.code} — {propertyDisplayName(property, locale)}
                </span>
              </label>
            ))
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label required>{labels.units}</Label>
        <div className="max-h-48 overflow-y-auto rounded-lg border">
          {propertyIds.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{labels.selectPropertiesFirst}</p>
          ) : availableUnits.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{labels.noUnits}</p>
          ) : (
            availableUnits.map((unit) => (
              <label
                key={unit.id}
                className="flex cursor-pointer items-center gap-3 border-b p-2 text-sm last:border-b-0 hover:bg-muted/50"
              >
                <Checkbox
                  checked={selectedUnitIds.has(unit.id)}
                  onCheckedChange={(checked) => toggleUnitId(unit.id, checked === true)}
                />
                <span>{unitLabel(unit.id)}</span>
                {occupiedUnitIds.has(unit.id) ? (
                  <Badge variant="destructive">{labels.occupied}</Badge>
                ) : null}
              </label>
            ))
          )}
        </div>
      </div>

      {unitRows.length > 0 ? (
        <div className="space-y-3">
          {unitRows.map((row, index) => (
            <div key={row.unit_id} className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">{unitLabel(row.unit_id)}</p>
              <div className="space-y-1">
                <Label required htmlFor={`contract-unit-amount-${row.unit_id}`}>
                  {labels.amount}
                </Label>
                {/*
                  `step` must accompany `min`: the browser derives the valid set
                  from min + n*step, and the default step of 1 would make a plain
                  3500 invalid against min="0.001" — native validation then blocks
                  submission with no visible error. KWD is three decimal places.
                */}
                <Input
                  id={`contract-unit-amount-${row.unit_id}`}
                  type="number"
                  inputMode="decimal"
                  min="0.001"
                  step="0.001"
                  value={String(row.monthly_amount)}
                  onChange={(event) => setAmount(row.unit_id, Number(event.target.value) || 0)}
                />
                {amountErrors?.[index] ? (
                  <p className="text-sm text-destructive">{amountErrors[index]}</p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
