import type { UseFormReturn } from "react-hook-form";

import { FormTextField } from "@/components/admin/Phase2FormFields";
import { DateInput } from "@/components/ui/date-input";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/provider";
import { calculatedEndDate, type ContractFormValues } from "@/lib/contractForm";

type ContractEndDateFieldsProps = {
  form: UseFormReturn<ContractFormValues>;
  overrideEnd: boolean;
  onOverrideEndChange: (override: boolean) => void;
  startDate: ContractFormValues["start_date"];
  durationMonths: ContractFormValues["duration_months"];
};

/**
 * يعرض تاريخ نهاية العقد المحسوب مع مفتاح التجاوز وسبب التجاوز عند تفعيله.
 *
 * Renders as a fragment so both pieces stay direct children of the dialog's
 * grid — the reason field spans the full row, the date cell does not.
 */
export function ContractEndDateFields({
  form,
  overrideEnd,
  onOverrideEndChange,
  startDate,
  durationMonths,
}: ContractEndDateFieldsProps) {
  const { t } = useI18n();
  return (
    <>
      <div className="space-y-2">
        <FormField
          control={form.control}
          name="end_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>{t("contracts.end")}</FormLabel>
              <FormControl>
                <DateInput
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={String(field.value ?? "")}
                  readOnly={!overrideEnd}
                  onChange={(next) => {
                    field.onChange(next);
                    const calculated = calculatedEndDate(startDate, durationMonths);
                    if (next && calculated && next !== calculated) {
                      onOverrideEndChange(true);
                    }
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <Switch
            id="contract-end-override"
            checked={overrideEnd}
            onCheckedChange={(checked) => {
              onOverrideEndChange(checked);
              if (!checked) {
                form.setValue("end_date", calculatedEndDate(startDate, durationMonths));
                form.setValue("end_date_override_reason", "");
                form.clearErrors("end_date_override_reason");
              }
            }}
          />
          <Label htmlFor="contract-end-override" className="cursor-pointer text-sm">
            {t("contracts.override")}
          </Label>
        </div>
      </div>
      {overrideEnd && (
        <div className="sm:col-span-2 lg:col-span-3">
          <FormTextField
            control={form.control}
            name="end_date_override_reason"
            label={t("contracts.overrideReason")}
            multiline
          />
        </div>
      )}
    </>
  );
}
