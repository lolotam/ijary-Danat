import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { fetchPlatformLimits, setPlatformLimits } from "@/platform/limitsFns";
import { platformErrorMessage } from "@/platform/platformFns";
import type { PlatformLimits } from "@/platform/limits";

/** مفاتيح النصوص التي تعرضها اللوحة، مجمّعة لأن الترجمة تُحقن عبر `useI18n`. */
const KEYS = {
  title: "limitsUi.title",
  units: "limitsUi.units",
  staff: "limitsUi.staff",
  whatsapp: "limitsUi.whatsapp",
  storage: "limitsUi.storage",
  maxLabel: "limitsUi.maxLabel",
  save: "limitsUi.save",
  saved: "limitsUi.saved",
  invalid: "limitsUi.invalidValue",
  lowerWarning: "limitsUi.lowerWarning",
} as const;

/** حقول النموذج الأربعة كما يكتبها مشرف المنصة. */
type LimitField = "maxUnits" | "maxStaffUsers" | "maxWhatsappPerMonth" | "maxStorageBytes";

/** حقل واحد في النموذج، مع مفتاح عنوانه المترجم. */
const FIELDS: ReadonlyArray<{ field: LimitField; labelKey: string }> = [
  { field: "maxUnits", labelKey: KEYS.units },
  { field: "maxStaffUsers", labelKey: KEYS.staff },
  { field: "maxWhatsappPerMonth", labelKey: KEYS.whatsapp },
  { field: "maxStorageBytes", labelKey: KEYS.storage },
];

/** نموذج فارغ، حتى لا ينتقل حد شركة سابقة إلى شركة أخرى. */
const EMPTY_FORM: Record<LimitField, string> = {
  maxUnits: "",
  maxStaffUsers: "",
  maxWhatsappPerMonth: "",
  maxStorageBytes: "",
};

/**
 * يعرض الحد الحالي كنص؛ الفراغ يعني بلا حد.
 */
function limitToInput(limit: number | null): string {
  return limit === null ? "" : String(limit);
}

/**
 * يقبل المدخل فارغاً أو رقماً صحيحاً غير سالب، كما يسمح قيد الجدول.
 */
function isLimitInputValid(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed === "" || /^\d+$/.test(trimmed);
}

/**
 * يحوّل مدخلاً صالحاً إلى رقم أو `null` للبلا حد.
 */
function optionalLimit(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : Number(trimmed);
}

/**
 * يقرر ما إذا كان الحد الجديد يقيّد الشركة أكثر من المحفوظ.
 */
function isLower(saved: number | null, draft: number | null): boolean {
  if (draft === null) return false;
  return saved === null || draft < saved;
}

/**
 * لوحة حدود شركة واحدة: أربعة حدود قابلة للتعديل عند مشرف المنصة.
 *
 * Lowering a limit is allowed and never deletes data; the warning only says
 * that future additions will be refused. The panel keeps a draft until save,
 * so an accidental edit cannot change a company before confirmation.
 */
export function LimitsPanel({ companyId }: { companyId: string }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<PlatformLimits | null>(null);
  const [draft, setDraft] = useState<Record<LimitField, string>>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetchPlatformLimits({ companyId })
      .then((loaded) => {
        if (!mounted) return;
        setSaved(loaded);
        setDraft({
          maxUnits: limitToInput(loaded.maxUnits),
          maxStaffUsers: limitToInput(loaded.maxStaffUsers),
          maxWhatsappPerMonth: limitToInput(loaded.maxWhatsappPerMonth),
          maxStorageBytes: limitToInput(loaded.maxStorageBytes),
        });
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (mounted) setLoadError(platformErrorMessage(t, cause));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [companyId, t]);

  /** يضع قيمة حقل واحد في المسوّدة. */
  function setField(field: LimitField, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setFormError(null);
    setSavedNotice(false);
  }

  /**
   * يحفظ الحدود بعد التحقق من أنها أرقام صحيحة غير سالبة أو فارغة.
   */
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSavedNotice(false);
    if (FIELDS.some(({ field }) => !isLimitInputValid(draft[field]))) {
      setFormError(t(KEYS.invalid));
      return;
    }

    setBusy(true);
    try {
      const result = await setPlatformLimits({
        companyId,
        maxUnits: optionalLimit(draft.maxUnits),
        maxStaffUsers: optionalLimit(draft.maxStaffUsers),
        maxWhatsappPerMonth: optionalLimit(draft.maxWhatsappPerMonth),
        maxStorageBytes: optionalLimit(draft.maxStorageBytes),
      });
      setSaved(result);
      setSavedNotice(true);
    } catch (cause) {
      setFormError(platformErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  }

  const lowersLimit = Boolean(
    saved && FIELDS.some(({ field }) => isLower(saved[field], optionalLimit(draft[field]))),
  );

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">{t(KEYS.title)}</h2>

      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("common.loading")}
        </p>
      ) : null}
      {loadError ? (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : null}

      {saved && !loading && !loadError ? (
        <form className="grid gap-3" onSubmit={(event) => void handleSubmit(event)}>
          <p className="text-sm text-muted-foreground">{t(KEYS.maxLabel)}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map(({ field, labelKey }) => (
              <div key={field} className="grid gap-1.5">
                <Label htmlFor={`platform-limit-${field}`}>{t(labelKey)}</Label>
                <Input
                  id={`platform-limit-${field}`}
                  type="number"
                  min="0"
                  step="1"
                  dir="ltr"
                  value={draft[field]}
                  onChange={(event) => setField(field, event.target.value)}
                />
              </div>
            ))}
          </div>

          {lowersLimit ? (
            <p
              className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
              role="status"
            >
              {t(KEYS.lowerWarning)}
            </p>
          ) : null}
          {formError ? (
            <p className="text-sm text-destructive" role="alert">
              {formError}
            </p>
          ) : null}
          {savedNotice ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t(KEYS.saved)}
            </p>
          ) : null}

          <div>
            <Button type="submit" disabled={busy}>
              {t(KEYS.save)}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
