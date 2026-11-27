import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { companyUsage, type CompanyUsage, type LimitUsage } from "@/fns/companyUsage";
import { useI18n } from "@/i18n/provider";

/** مفاتيح النصوص التي تعرضها البطاقة، مجمّعة للتمرير إلى `t`. */
const KEYS = {
  title: "limitsUi.usage.title",
  description: "limitsUi.usage.description",
  units: "limitsUi.units",
  staff: "limitsUi.staff",
  whatsapp: "limitsUi.whatsapp",
  storage: "limitsUi.storage",
  notice: "limitsUi.usage.notice",
  unlimited: "limitsUi.unlimited",
  loadError: "limitsUi.usage.loadError",
  megabytes: "limitsUi.usage.megabytes",
  gigabytes: "limitsUi.usage.gigabytes",
} as const;

/** مفتاح استعلام الاستهلاك؛ بطاقة واحدة في صفحة الإعدادات. */
const USAGE_QUERY_KEY = ["company-usage"] as const;

/** حدّ التنبيه: 80% من السقف كما في المعيار US7. */
const NOTICE_RATIO = 0.8;

/** صف واحد في البطاقة: عنوانه واستهلاكه وطريقة عرض قيمه. */
interface UsageRow {
  id: string;
  labelKey: string;
  usage: LimitUsage;
  formatValue: (value: number) => string;
}

/**
 * يعرض البايتات بوحدة ميجابايت أو جيجابايت، كما يقرأ المستخدم مساحة التخزين.
 */
function formatStorage(bytes: number, t: (key: string) => string): string {
  const gigabyte = 1_073_741_824;
  const isGigabytes = bytes >= gigabyte;
  const value = bytes / (isGigabytes ? gigabyte : 1_048_576);
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 100 ? 0 : value >= 10 ? 1 : 2,
  }).format(value);
  return `${formatted} ${t(isGigabytes ? KEYS.gigabytes : KEYS.megabytes)}`;
}

/**
 * يقرر إن بلغ أي استخدام 80% من سقفه.
 */
function isNearLimit(usage: LimitUsage): boolean {
  return usage.limit !== null && usage.used >= usage.limit * NOTICE_RATIO;
}

/**
 * بطاقة استهلاك حدود الشركة في صفحة الإعدادات.
 *
 * The server function enforces the same company-settings permission as the
 * page, so the card never has to decide who may read another company's usage.
 */
export function UsageCard() {
  const { t } = useI18n();
  const usageQuery = useQuery({
    queryKey: USAGE_QUERY_KEY,
    queryFn: (): Promise<CompanyUsage> => companyUsage(),
  });

  const usage = usageQuery.data;

  const rows: UsageRow[] = usage
    ? [
        {
          id: "units",
          labelKey: KEYS.units,
          usage: usage.units,
          formatValue: (value) => String(value),
        },
        {
          id: "staff",
          labelKey: KEYS.staff,
          usage: usage.staff,
          formatValue: (value) => String(value),
        },
        {
          id: "whatsapp",
          labelKey: KEYS.whatsapp,
          usage: usage.whatsapp,
          formatValue: (value) => String(value),
        },
        {
          id: "storage",
          labelKey: KEYS.storage,
          usage: usage.storage,
          formatValue: (value) => formatStorage(value, t),
        },
      ]
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(KEYS.title)}</CardTitle>
        <CardDescription>{t(KEYS.description)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {usageQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : null}
        {usageQuery.error ? (
          <p className="text-sm text-destructive" role="alert">
            {t(KEYS.loadError)}
          </p>
        ) : null}
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3 text-sm"
          >
            <span className="font-medium">{t(row.labelKey)}</span>
            <span dir="ltr" className="tabular-nums text-muted-foreground">
              {row.formatValue(row.usage.used)} /{" "}
              {row.usage.limit === null ? t(KEYS.unlimited) : row.formatValue(row.usage.limit)}
            </span>
          </div>
        ))}
        {usage && Object.values(usage).some(isNearLimit) ? (
          <p
            className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
            role="status"
          >
            {t(KEYS.notice)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
