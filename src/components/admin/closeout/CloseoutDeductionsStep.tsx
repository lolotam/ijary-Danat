import type { UseFieldArrayReturn, UseFormReturn } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";
import type { CloseoutInput } from "@/lib/closeoutSchemas";
import { formatKwd } from "@/lib/money";
import { DEDUCTION_KINDS } from "@/components/admin/closeout/closeoutShared";

/**
 * الخطوة 3: الخصومات من التأمين المحتجز.
 */
export function CloseoutDeductionsStep({
  depositHeld,
  deductions,
  form,
}: {
  depositHeld: number | undefined;
  deductions: UseFieldArrayReturn<CloseoutInput, "deductions">;
  form: UseFormReturn<CloseoutInput>;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("closeout.step.3")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("closeout.depositHeld")}:{" "}
        <LtrText className="font-medium text-foreground">
          {formatKwd(depositHeld ?? 0, locale)}
        </LtrText>
        <span className="ms-2 text-xs">({t("closeout.depositHeldHint")})</span>
      </p>
      <div className="space-y-3">
        {deductions.fields.map((field, index) => (
          <div
            key={field.id}
            className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5"
          >
            <FormField
              control={form.control}
              name={`deductions.${index}.kind`}
              render={({ field: kindField }) => (
                <FormItem>
                  <FormLabel required>{t("closeout.deductionKind")}</FormLabel>
                  <Select value={kindField.value} onValueChange={kindField.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DEDUCTION_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`closeout.deductionKind.${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name={`deductions.${index}.amount`}
              render={({ field: amountField }) => (
                <FormItem>
                  <FormLabel required>{t("common.amount")}</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      value={
                        amountField.value == null || amountField.value === ("" as never)
                          ? ""
                          : String(amountField.value)
                      }
                      onChange={(event) => {
                        // Keep display string-like; coerce to number for schema.
                        const raw = event.target.value;
                        if (raw === "" || raw === ".") {
                          amountField.onChange(0);
                          return;
                        }
                        const parsed = Number(raw);
                        amountField.onChange(Number.isFinite(parsed) ? parsed : 0);
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name={`deductions.${index}.description_ar`}
              render={({ field: descField }) => (
                <FormItem>
                  <FormLabel>{t("common.descriptionAr")}</FormLabel>
                  <FormControl>
                    <Input
                      value={descField.value ?? ""}
                      onChange={(event) => descField.onChange(event.target.value || null)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name={`deductions.${index}.description_en`}
              render={({ field: descField }) => (
                <FormItem>
                  <FormLabel>{t("common.descriptionEn")}</FormLabel>
                  <FormControl>
                    <Input
                      value={descField.value ?? ""}
                      onChange={(event) => descField.onChange(event.target.value || null)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => deductions.remove(index)}
              >
                {t("common.delete")}
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          deductions.append({
            kind: "other",
            description_ar: null,
            description_en: null,
            amount: 0.001,
          })
        }
      >
        {t("closeout.addDeduction")}
      </Button>
    </div>
  );
}
