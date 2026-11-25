import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Locale } from "@/i18n/dictionary";
import { CONTRACT_LIMITS, type ContractPlot } from "@/lib/contractBuilder/schema";
import { joinLocalizedList } from "@/lib/contractUnits";
import {
  selectableUnits,
  togglePlot,
  toggleUnit,
  unitDisplayNumber,
  type SelectableUnitRow,
} from "@/lib/contractBuilder/units";
import { propertyDisplayName, sortPropertiesByCodeNatural } from "@/lib/propertyDisplayName";
import { unitStatusTone } from "@/lib/statusTone";
import { BuilderField, type BuilderFormProps } from "./ContractBuilderField";

export type PickerProperty = {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
};

type Props = BuilderFormProps & {
  locale: Locale;
  properties: PickerProperty[];
  /** وحدات القسائم المختارة كما جاءت من قاعدة البيانات، والسطح يُستبعد هنا. */
  units: SelectableUnitRow[];
  unitsLoading: boolean;
};

/** يحوّل صف العقار إلى لقطة القسيمة المحفوظة في قيم العقد. */
function toPlot(property: PickerProperty): ContractPlot {
  return {
    id: property.id,
    name_ar: property.name_ar.trim(),
    name_en: property.name_en?.trim() ?? "",
  };
}

/**
 * يختار القسائم من قائمة منسدلة متعددة، ثم وحدات كل قسيمة مع رقمها الآلي.
 *
 * The contract's unit lines are the source of truth for what prints; the
 * checkboxes only add and remove lines, and each line's PACI number stays
 * editable because `units.paci_no` is empty for some rows in production.
 * Occupancy is read from `units.status` for the badge only; it never enters
 * the form values or the printed contract.
 */
export function PlotUnitPicker({ form, t, locale, properties, units, unitsLoading }: Props) {
  const plots = form.watch("plots");
  const lines = form.watch("units");
  const plotById = new Map(plots.map((plot) => [plot.id, plot]));
  const selectedPlotIds = new Set(plotById.keys());
  const selectedUnitIds = new Set(lines.map((line) => line.unit_id));
  const available = selectableUnits(units);
  const atUnitLimit = lines.length >= CONTRACT_LIMITS.units;
  // Neither selection has an input for handleSubmit to focus, so an empty one
  // must say so here or Download appears to do nothing (Codex, PR #255).
  const plotsError = Boolean(form.getFieldState("plots", form.formState).error);
  const plotsMissing = plots.length === 0 && plotsError;
  // A selected plot can only fail on its snapshot name, which the property
  // form does not length-limit; say which one, since it is not editable here.
  const overlongPlots = plots.filter(
    (plot) =>
      plot.name_ar.length > CONTRACT_LIMITS.name || plot.name_en.length > CONTRACT_LIMITS.name,
  );
  const unitsMissing =
    lines.length === 0 && Boolean(form.getFieldState("units", form.formState).error);

  /** يكتب القسائم والوحدات معاً حتى لا تبقى وحدة من قسيمة أُزيلت. */
  function onPlotChange(property: PickerProperty, checked: boolean) {
    const next = togglePlot({ plots, units: lines }, toPlot(property), checked);
    form.setValue("plots", next.plots, { shouldDirty: true, shouldValidate: true });
    form.setValue("units", next.units, { shouldDirty: true, shouldValidate: true });
  }

  /** يضيف سطر وحدة أو يزيله مع احترام حد الوحدات الست. */
  function onUnitChange(row: SelectableUnitRow, checked: boolean) {
    const next = toggleUnit(lines, row, checked, CONTRACT_LIMITS.units);
    form.setValue("units", next, { shouldDirty: true, shouldValidate: true });
  }

  const orderedProperties = sortPropertiesByCodeNatural(properties);
  const summary =
    plots.length === 0
      ? t("contractBuilder.selectPlots")
      : joinLocalizedList(
          plots.map((plot) => propertyDisplayName(plot, locale)),
          locale,
        );

  return (
    <fieldset className="space-y-3">
      <legend>{t("contractBuilder.plots")}</legend>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-between">
            <span className="truncate">{summary}</span>
            <ChevronDown className="size-4 shrink-0" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="max-h-72 w-(--radix-popover-trigger-width) overflow-y-auto p-0">
          {orderedProperties.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("contractBuilder.noPlots")}</p>
          ) : (
            orderedProperties.map((property) => (
              <label
                key={property.id}
                className="flex cursor-pointer items-center gap-3 border-b p-2 text-sm last:border-b-0 hover:bg-muted/50"
              >
                <Checkbox
                  checked={selectedPlotIds.has(property.id)}
                  disabled={
                    !selectedPlotIds.has(property.id) && plots.length >= CONTRACT_LIMITS.plots
                  }
                  onCheckedChange={(checked) => onPlotChange(property, checked === true)}
                />
                <span>
                  {property.code} — {propertyDisplayName(property, locale)}
                </span>
              </label>
            ))
          )}
        </PopoverContent>
      </Popover>
      {overlongPlots.length > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {t("contractBuilder.plotNameTooLong")}:{" "}
          {joinLocalizedList(
            overlongPlots.map((plot) => propertyDisplayName(plot, locale)),
            locale,
          )}
        </p>
      )}
      {plotsMissing && (
        <p role="alert" className="text-sm text-destructive">
          {t("contractBuilder.plotsRequired")}
        </p>
      )}

      <div className="space-y-2">
        <p className="text-sm">{t("contractBuilder.units")}</p>
        {plots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("contractBuilder.selectPlotsFirst")}</p>
        ) : unitsLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : (
          plots.map((plot) => {
            const plotUnits = available.filter((row) => row.property_id === plot.id);
            return (
              <div key={plot.id} className="rounded-lg border" data-testid="plot-units">
                <p className="border-b bg-muted/40 p-2 text-sm font-medium">
                  {propertyDisplayName(plot, locale)}
                </p>
                {plotUnits.length === 0 ? (
                  <p className="p-2 text-sm text-muted-foreground">
                    {t("contractBuilder.noUnits")}
                  </p>
                ) : (
                  <div className="max-h-48 overflow-y-auto">
                    {plotUnits.map((row) => (
                      <label
                        key={row.id}
                        className="flex cursor-pointer items-center gap-3 border-b p-2 text-sm last:border-b-0 hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={selectedUnitIds.has(row.id)}
                          disabled={!selectedUnitIds.has(row.id) && atUnitLimit}
                          onCheckedChange={(checked) => onUnitChange(row, checked === true)}
                        />
                        <span>{unitDisplayNumber(row)}</span>
                        <span className="text-muted-foreground" dir="ltr">
                          {t("contractBuilder.field.paci_no")}: {row.paci_no?.trim() || "—"}
                        </span>
                        {row.status ? (
                          <Badge
                            variant={unitStatusTone(row.status)}
                            className="ms-auto"
                            data-testid="unit-occupancy"
                          >
                            {t(`unitStatus.${row.status}`)}
                          </Badge>
                        ) : null}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
        {unitsMissing && (
          <p role="alert" className="text-sm text-destructive">
            {t("contractBuilder.unitsRequired")}
          </p>
        )}
        {atUnitLimit && (
          <p className="text-sm text-amber-700">{t("contractBuilder.unitLimitReached")}</p>
        )}
      </div>

      {lines.length > 0 && (
        <div className="space-y-2">
          {lines.map((line, index) => (
            <div
              key={line.unit_id}
              className="grid items-end gap-2 rounded border p-3 sm:grid-cols-3"
              data-testid="unit-line"
            >
              <p className="text-sm font-medium sm:col-span-3">
                {propertyDisplayName(plotById.get(line.property_id)!, locale)}
              </p>
              <BuilderField
                form={form}
                t={t}
                name={`units.${index}.unit_number`}
                label="unit_number"
              />
              <BuilderField
                form={form}
                t={t}
                name={`units.${index}.unit_number_en`}
                label="unit_number_en"
              />
              <BuilderField
                form={form}
                t={t}
                name={`units.${index}.paci_no`}
                label="paci_no"
                inputMode="numeric"
              />
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}
