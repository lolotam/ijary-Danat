import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import {
  fetchPlatformSubscriptions,
  platformErrorMessage,
  recordPlatformSubscription,
} from "@/platform/platformFns";
import type { CompanySubscriptionRow, CompanySubscriptionStatus } from "@/platform/subscriptions";

/** الحالات المسموحة في النموذج، مطابقة لقيد الجدول في الهجرة 322. */
const STATUSES = [
  "trial",
  "active",
  "overdue",
  "cancelled",
] as const satisfies readonly CompanySubscriptionStatus[];

/** لون شارة كل حالة اشتراك. */
const STATUS_VARIANTS: Record<
  CompanySubscriptionStatus,
  "info" | "success" | "warning" | "secondary"
> = {
  trial: "info",
  active: "success",
  overdue: "warning",
  cancelled: "secondary",
};

/** حقول نموذج تسجيل اشتراك جديد؛ كلها نصوص إلى أن تُحوَّل عند الإرسال. */
interface SubscriptionForm {
  planName: string;
  price: string;
  periodStart: string;
  renewalDate: string;
  status: CompanySubscriptionStatus;
  note: string;
}

/** نموذج فارغ، حتى لا ينتقل سطر سابق إلى شركة أخرى. */
const EMPTY_FORM: SubscriptionForm = {
  planName: "",
  price: "",
  periodStart: "",
  renewalDate: "",
  status: "active",
  note: "",
};

/** منسّق المبلغ بثلاثة منازل عشرية، كما يُخزَّن بالفلسات. */
const KWD_FORMATTER = new Intl.NumberFormat("en-KW", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

/**
 * يعرض السعر بثلاثة منازل، لأن الدينار الكويتي يحتفظ بالفلسات في قاعدة البيانات.
 */
function formatPrice(price: number): string {
  return `${KWD_FORMATTER.format(price)} KWD`;
}

/**
 * لوحة اشتراك شركة واحدة: الحالة الحالية والسجل التراكمي ونموذج إضافة سطر.
 *
 * The rows are append-only by database rule, so the panel offers no edit or
 * delete action: a renewal is a new row, never a change to an older one.
 */
export function SubscriptionPanel({ companyId }: { companyId: string }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<CompanySubscriptionRow[]>([]);
  const [form, setForm] = useState<SubscriptionForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetchPlatformSubscriptions({ companyId })
      .then((loaded) => {
        if (mounted) {
          setRows(loaded);
          setLoadError(null);
        }
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

  /** يضع قيمة حقل واحد من نموذج الاشتراك. */
  function setField(field: keyof SubscriptionForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
    setSaved(false);
  }

  /**
   * يسجّل سطر اشتراك جديداً بعد التحقق من ترتيب تاريخيه.
   */
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSaved(false);

    const planName = form.planName.trim();
    const price = Number(form.price);
    if (!planName) {
      setFormError(t("platformBilling.subscription.invalidPlan"));
      return;
    }
    if (!form.price.trim() || !Number.isFinite(price) || price < 0) {
      setFormError(t("platformBilling.subscription.invalidPrice"));
      return;
    }
    if (!form.periodStart || !form.renewalDate || form.renewalDate < form.periodStart) {
      setFormError(t("platformBilling.subscription.renewalBeforeStart"));
      return;
    }

    setBusy(true);
    try {
      const row = await recordPlatformSubscription({
        companyId,
        planName,
        price,
        periodStart: form.periodStart,
        renewalDate: form.renewalDate,
        status: form.status,
        note: form.note.trim() || null,
      });
      setRows((current) => [row, ...current]);
      setForm(EMPTY_FORM);
      setSaved(true);
    } catch (cause) {
      setFormError(platformErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  }

  const current = rows[0];

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">{t("platformBilling.subscription.title")}</h2>

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

      {!loading && !loadError ? (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("platformBilling.subscription.current")}</h3>
            {current ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("platformBilling.subscription.plan")}
                  </dt>
                  <dd className="font-medium">{current.plan_name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("platformBilling.subscription.price")}
                  </dt>
                  <dd dir="ltr" className="font-medium tabular-nums">
                    {formatPrice(current.price)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("platformBilling.subscription.period")}
                  </dt>
                  <dd dir="ltr" className="tabular-nums">
                    {current.period_start} — {current.renewal_date}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("platformBilling.subscription.status")}
                  </dt>
                  <dd>
                    <Badge variant={STATUS_VARIANTS[current.status]}>
                      {t(`platformBilling.subscription.status.${current.status}`)}
                    </Badge>
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("platformBilling.subscription.none")}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("platformBilling.subscription.history")}</h3>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("platformBilling.subscription.emptyHistory")}
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {rows.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="font-medium">{row.plan_name}</span>
                    <span dir="ltr" className="tabular-nums text-muted-foreground">
                      {formatPrice(row.price)}
                    </span>
                    <span dir="ltr" className="text-xs text-muted-foreground">
                      {row.period_start} — {row.renewal_date}
                    </span>
                    <Badge variant={STATUS_VARIANTS[row.status]}>
                      {t(`platformBilling.subscription.status.${row.status}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}

      <form className="grid gap-3 border-t pt-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="platform-subscription-plan" required>
              {t("platformBilling.subscription.planLabel")}
            </Label>
            <Input
              id="platform-subscription-plan"
              value={form.planName}
              onChange={(event) => setField("planName", event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="platform-subscription-price" required>
              {t("platformBilling.subscription.priceLabel")}
            </Label>
            <Input
              id="platform-subscription-price"
              type="number"
              step="0.001"
              min="0"
              dir="ltr"
              value={form.price}
              onChange={(event) => setField("price", event.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="platform-subscription-start" required>
              {t("platformBilling.subscription.startLabel")}
            </Label>
            <Input
              id="platform-subscription-start"
              type="date"
              dir="ltr"
              value={form.periodStart}
              onChange={(event) => setField("periodStart", event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="platform-subscription-renewal" required>
              {t("platformBilling.subscription.renewalLabel")}
            </Label>
            <Input
              id="platform-subscription-renewal"
              type="date"
              dir="ltr"
              value={form.renewalDate}
              onChange={(event) => setField("renewalDate", event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="platform-subscription-status" required>
              {t("platformBilling.subscription.statusLabel")}
            </Label>
            <select
              id="platform-subscription-status"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={form.status}
              onChange={(event) =>
                setField("status", event.target.value as CompanySubscriptionStatus)
              }
            >
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`platformBilling.subscription.status.${status}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="platform-subscription-note">
            {t("platformBilling.subscription.noteLabel")}
          </Label>
          <Textarea
            id="platform-subscription-note"
            value={form.note}
            maxLength={1000}
            onChange={(event) => setField("note", event.target.value)}
          />
        </div>

        {formError ? (
          <p className="text-sm text-destructive" role="alert">
            {formError}
          </p>
        ) : null}
        {saved ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("platformBilling.subscription.saved")}
          </p>
        ) : null}

        <div>
          <Button type="submit" disabled={busy}>
            {t("platformBilling.subscription.record")}
          </Button>
        </div>
      </form>
    </section>
  );
}
