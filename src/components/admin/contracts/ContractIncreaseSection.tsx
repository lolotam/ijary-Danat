import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Locale } from "@/i18n/dictionary";
import { contractIncreaseEffectivePeriod, type ContractIncreaseType } from "@/lib/contractIncrease";

/** قيمة زيادة الإيجار في النموذج: الثلاثية كاملة أو null. */
export interface ContractIncreaseValue {
  after_years: number;
  type: ContractIncreaseType;
  value: number;
}

export interface ContractIncreaseSectionLabels {
  title: string;
  enable: string;
  afterYears: string;
  type: string;
  percent: string;
  fixed: string;
  value: string;
  locked: string;
  effectiveFrom: string;
}

export interface ContractIncreaseSectionProps {
  value: ContractIncreaseValue | null;
  onChange: (value: ContractIncreaseValue | null) => void;
  /** مقفلة: سُدِّدت فاتورة في أو بعد فترة السريان فلا تتغيّر الزيادة. */
  locked: boolean;
  startDate: string;
  labels: ContractIncreaseSectionLabels;
  locale: Locale;
  /** رسالة تحقّق حقل القيمة (مفتاح contracts.increase.percentCap مترجماً). */
  valueError?: string;
}

/** ما يُبثّ عند تشغيل المفتاح أول مرة: أقرب زيادة معقولة قابلة للتعديل. */
const DEFAULT_INCREASE: ContractIncreaseValue = { after_years: 1, type: "percent", value: 0 };

/**
 * قسم زيادة الإيجار في نموذج العقد: مفتاح ثم الحقول الثلاثة.
 *
 * Its own component rather than markup in `ContractFormDialog`: that file
 * already sits past this repository's 500-600 line ceiling, and the plan
 * allows it nothing here but a mount point and the lock query. When `locked`
 * is true the inputs render disabled with the lock note — `save_contract_with
 * units` (migration 200) refuses the change, and an editable form that cannot
 * save is a support ticket, not a feature.
 */
export function ContractIncreaseSection({
  value,
  onChange,
  locked,
  startDate,
  labels,
  locale,
  valueError,
}: ContractIncreaseSectionProps) {
  /**
   * يعدّل واحدة من حقول الثلاثية ويترك الباقي كما هو.
   */
  function setField(patch: Partial<ContractIncreaseValue>) {
    if (!value) return;
    onChange({ ...value, ...patch });
  }

  const effective =
    value && startDate ? contractIncreaseEffectivePeriod(startDate, value.after_years) : null;

  return (
    <div className="space-y-3 sm:col-span-2 lg:col-span-3">
      <div className="space-y-1">
        <Label>{labels.title}</Label>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
        <div className="flex items-center gap-2 pb-1">
          <Switch
            id="contract-increase-enabled"
            checked={Boolean(value)}
            disabled={locked}
            onCheckedChange={(checked) => onChange(checked ? { ...DEFAULT_INCREASE } : null)}
          />
          <Label htmlFor="contract-increase-enabled" className="cursor-pointer text-sm">
            {labels.enable}
          </Label>
        </div>

        {value ? (
          <>
            <div className="min-w-32 flex-1 space-y-1">
              <Label htmlFor="contract-increase-after-years">{labels.afterYears}</Label>
              <Input
                id="contract-increase-after-years"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                aria-label={labels.afterYears}
                disabled={locked}
                value={String(value.after_years)}
                onChange={(event) => setField({ after_years: Number(event.target.value) || 0 })}
              />
            </div>

            <div className="min-w-40 flex-1 space-y-1">
              <Label htmlFor="contract-increase-type">{labels.type}</Label>
              <Select
                value={value.type}
                disabled={locked}
                onValueChange={(next) => setField({ type: next as ContractIncreaseType })}
              >
                <SelectTrigger id="contract-increase-type" disabled={locked}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">{labels.percent}</SelectItem>
                  <SelectItem value="fixed">{labels.fixed}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-40 flex-1 space-y-1">
              <Label htmlFor="contract-increase-value">{labels.value}</Label>
              <Input
                id="contract-increase-value"
                type="number"
                inputMode="decimal"
                min="0.001"
                step="0.001"
                aria-label={labels.value}
                disabled={locked}
                value={String(value.value)}
                onChange={(event) => setField({ value: Number(event.target.value) || 0 })}
              />
              {valueError ? <p className="text-sm text-destructive">{valueError}</p> : null}
            </div>
          </>
        ) : null}
      </div>

      {locked ? <p className="text-xs text-muted-foreground">{labels.locked}</p> : null}

      {value && effective ? (
        <p className="text-xs text-muted-foreground">
          {labels.effectiveFrom}{" "}
          {/* Bidi isolation only where the UI is RTL: a bare "2027-02" inside
              Arabic text renders with the year and month swapped otherwise. */}
          {locale === "ar" ? <LtrText>{effective}</LtrText> : effective}
        </p>
      ) : null}
    </div>
  );
}
