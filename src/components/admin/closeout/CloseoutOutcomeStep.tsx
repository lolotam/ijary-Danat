import type { UseFormReturn } from "react-hook-form";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import type { CloseoutInput } from "@/lib/closeoutSchemas";
import { closeoutOutcomeTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

/**
 * الخطوة 6: مصير العقد والمستأجر بعد الإغلاق، وحالة العقد النهائية، وملاحظة.
 */
export function CloseoutOutcomeStep({
  form,
  watchedOutcome,
}: {
  form: UseFormReturn<CloseoutInput>;
  watchedOutcome: CloseoutInput["outcome"];
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("closeout.step.6")}</h2>
      <FormField
        control={form.control}
        name="outcome"
        render={({ field }) => (
          <FormItem>
            <FormLabel required>{t("closeout.outcome")}</FormLabel>
            <FormControl>
              <RadioGroup
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value);
                  if (value !== "archive") {
                    form.setValue("archiveTenant", false);
                  }
                }}
                className="grid gap-3"
              >
                {(["keep_terminated", "freeze", "archive"] as const).map((outcome) => (
                  <label
                    key={outcome}
                    className={cn(
                      "flex cursor-pointer flex-col gap-1 rounded-lg border p-4 transition-colors",
                      field.value === outcome && "border-primary bg-primary/5",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value={outcome} id={`outcome-${outcome}`} />
                      <Badge variant={closeoutOutcomeTone(outcome)}>
                        {t(`closeout.outcome.${outcome}`)}
                      </Badge>
                    </div>
                    <p className="ps-6 text-sm text-muted-foreground">
                      {t(`closeout.outcomeHelp.${outcome}`)}
                    </p>
                  </label>
                ))}
              </RadioGroup>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="finalContractState"
        render={({ field }) => (
          <FormItem className="max-w-xs">
            <FormLabel required>{t("closeout.finalContractState")}</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="terminated">{t("contractState.terminated")}</SelectItem>
                <SelectItem value="expired">{t("contractState.expired")}</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {watchedOutcome === "archive" ? (
        <FormField
          control={form.control}
          name="archiveTenant"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-3 space-y-0 rounded-lg border p-4">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(Boolean(checked))}
                />
              </FormControl>
              <div>
                <FormLabel className="cursor-pointer">{t("closeout.archiveTenant")}</FormLabel>
                <p className="text-xs text-muted-foreground">{t("closeout.archiveTenantHelp")}</p>
              </div>
            </FormItem>
          )}
        />
      ) : null}

      <FormField
        control={form.control}
        name="note"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("common.notes")}</FormLabel>
            <FormControl>
              <Textarea
                value={field.value ?? ""}
                onChange={(event) => field.onChange(event.target.value || null)}
                rows={3}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
