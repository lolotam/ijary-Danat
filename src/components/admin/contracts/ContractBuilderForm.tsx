import type { Locale } from "@/i18n/dictionary";
import type { PrefillNotice } from "@/lib/contractBuilder/prefill";
import { totalValueFils } from "@/lib/contractBuilder/schema";
import type { SelectableUnitRow } from "@/lib/contractBuilder/units";
import { BuilderField, type BuilderFormProps } from "./ContractBuilderField";
import { PlotUnitPicker, type PickerProperty } from "./PlotUnitPicker";
import { ContactFields, SecondPartyFields } from "./SecondPartyFields";

type Props = BuilderFormProps & {
  notices: PrefillNotice[];
  locale: Locale;
  /** العقارات والوحدات تُجلب في الصفحة، فيبقى النموذج مكوناً نقياً سهل الاختبار. */
  inventory: { properties: PickerProperty[]; units: SelectableUnitRow[]; unitsLoading: boolean };
};

/** يجمع أقسام منشئ العقد: الطرف الثاني والتواصل والقسائم والوحدات والشروط المالية. */
export function ContractBuilderForm({ form, t, notices, locale, inventory }: Props) {
  const values = form.watch();
  const total = totalValueFils(values);
  return (
    <div className="space-y-5">
      {notices.length > 0 && (
        <ul
          data-testid="prefill-notices"
          className="list-disc rounded border border-amber-400 bg-amber-50 p-5 text-amber-900"
        >
          {notices.map((notice) => (
            <li key={notice}>{t(`contractBuilder.notice.${notice}`)}</li>
          ))}
        </ul>
      )}
      <label className="grid gap-1 text-sm">
        {t("contractBuilder.language")}
        <select
          aria-label={t("contractBuilder.language")}
          className="h-9 rounded border bg-background px-3"
          {...form.register("language")}
        >
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
      </label>
      <BuilderField form={form} t={t} name="contract_date" label="contract_date" type="date" />
      <SecondPartyFields form={form} t={t} />
      <ContactFields form={form} t={t} />
      <PlotUnitPicker
        form={form}
        t={t}
        locale={locale}
        properties={inventory.properties}
        units={inventory.units}
        unitsLoading={inventory.unitsLoading}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        {(["governorate", "block", "parcel"] as const).map((key) => (
          <BuilderField key={key} form={form} t={t} name={key} label={key} />
        ))}
      </div>
      {(["activity", "trade_name"] as const).map((key) => (
        <BuilderField key={key} form={form} t={t} name={key} label={key} />
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            "duration_months",
            "notice_months",
            "monthly_value",
            "advance_months",
            "grace_months",
            "late_fee_percent",
            "service_charge_monthly",
          ] as const
        ).map((key) => (
          <BuilderField key={key} form={form} t={t} name={key} label={key} numeric />
        ))}
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={values.increase !== null}
          onChange={(event) =>
            form.setValue(
              "increase",
              event.target.checked ? { every_years: 1, percent: 5 } : null,
              { shouldDirty: true, shouldValidate: true },
            )
          }
        />
        {t("contractBuilder.field.increase")}
      </label>
      {values.increase !== null && (
        <div className="grid gap-3 sm:grid-cols-2">
          <BuilderField form={form} t={t} name="increase.every_years" label="every_years" numeric />
          <BuilderField form={form} t={t} name="increase.percent" label="percent" numeric />
        </div>
      )}
      <p>
        {t("contractBuilder.field.total_value")}:{" "}
        <output>{Number.isFinite(total) ? (total / 1000).toFixed(3) : "—"}</output> KWD
      </p>
    </div>
  );
}
