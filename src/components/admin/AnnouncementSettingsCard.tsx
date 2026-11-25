import { useFormContext } from "react-hook-form";

import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";

/** Fields this card owns inside the company settings form. */
export type AnnouncementFormSlice = {
  announcement_enabled: boolean;
  announcement_ar: string;
  announcement_en: string;
};

/**
 * بطاقة إعدادات شريط الإعلان في بوابة المستأجر (تفعيل + نص عربي/إنجليزي).
 *
 * Lives as a form-context consumer so it shares the same mutation and save
 * button as the rest of company settings — a second form here would drift.
 */
export function AnnouncementSettingsCard() {
  const { t } = useI18n();
  const { control } = useFormContext<AnnouncementFormSlice>();

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 md:col-span-2">
      <div>
        <h3 className="text-base font-semibold leading-none tracking-tight">
          {t("settings.announcement.title")}
        </h3>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("settings.announcement.description")}
        </p>
      </div>

      <FormField
        control={control}
        name="announcement_enabled"
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between gap-3 rounded-lg border p-3">
            <FormLabel className="cursor-pointer">{t("settings.announcement.enabled")}</FormLabel>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="announcement_ar"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("settings.announcement.textAr")}</FormLabel>
            <FormControl>
              <Textarea {...field} value={field.value ?? ""} rows={3} dir="rtl" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="announcement_en"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("settings.announcement.textEn")}</FormLabel>
            <FormControl>
              <Textarea {...field} value={field.value ?? ""} rows={3} dir="ltr" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
