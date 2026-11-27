import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import type { PlatformCompanyHealth } from "@/platform/overview";

import { CompanyHealthUsageCell } from "./CompanyHealthUsageCell";

/** منسّق الأرقام لاستهلاك التخزين. */
function formatStorageNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 100 ? 0 : value >= 10 ? 1 : 2,
  }).format(value);
}

/**
 * يحوّل عدد البايتات إلى وحدة مقروءة (بايت، كيلوبايت، ميجابايت، جيجابايت).
 */
function formatStorageBytes(bytes: number, t: (key: string) => string): string {
  const kilobyte = 1_024;
  const megabyte = 1_048_576;
  const gigabyte = 1_073_741_824;

  if (bytes >= gigabyte) {
    return `${formatStorageNumber(bytes / gigabyte)} ${t("platformOverview.health.unitGigabytes")}`;
  }
  if (bytes >= megabyte) {
    return `${formatStorageNumber(bytes / megabyte)} ${t("platformOverview.health.unitMegabytes")}`;
  }
  if (bytes >= kilobyte) {
    return `${formatStorageNumber(bytes / kilobyte)} ${t("platformOverview.health.unitKilobytes")}`;
  }
  return `${formatStorageNumber(bytes)} ${t("platformOverview.health.unitBytes")}`;
}

/** ما يعرضه جدول حالة الشركات. */
export interface CompanyHealthTableProps {
  rows: PlatformCompanyHealth[];
  loading: boolean;
  error: string | null;
}

/** منسّق المبلغ بثلاثة منازل عشرية، كما يُخزَّن بالفلسات. */
const KWD_FORMATTER = new Intl.NumberFormat("en-KW", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

/** لون شارة كل حالة اشتراك. */
const SUBSCRIPTION_VARIANTS: Record<
  NonNullable<PlatformCompanyHealth["subscription_status"]>,
  "info" | "success" | "warning" | "secondary"
> = {
  trial: "info",
  active: "success",
  overdue: "warning",
  cancelled: "secondary",
};

/**
 * يعرض المبلغ المحصّل بالدينار الكويتي بثلاثة منازل عشرية.
 */
function formatCollectedKwd(amount: number): string {
  return `${KWD_FORMATTER.format(amount)} KWD`;
}

/**
 * شارة حالة اتصال واحد: سليم أو معطوب أو غير مُعد.
 *
 * Three states, not two: a company that never set up WhatsApp is not broken,
 * and telling the super admin otherwise would send them after a problem that
 * does not exist.
 */
function HealthBadge({ value }: { value: boolean | null }) {
  const { t } = useI18n();

  if (value === null) {
    return <Badge variant="secondary">{t("platformOverview.state.notSetUp")}</Badge>;
  }

  return (
    <Badge variant={value ? "success" : "destructive"}>
      {value ? t("platformOverview.state.ok") : t("platformOverview.state.broken")}
    </Badge>
  );
}

/**
 * شارة حالة اشتراك الشركة أو علامة غياب الاشتراك.
 */
function SubscriptionBadge({ status }: { status: PlatformCompanyHealth["subscription_status"] }) {
  const { t } = useI18n();

  if (status === null) {
    return (
      <span className="text-muted-foreground">{t("platformOverview.health.noSubscription")}</span>
    );
  }

  return (
    <Badge variant={SUBSCRIPTION_VARIANTS[status]}>
      {t(`platformBilling.subscription.status.${status}`)}
    </Badge>
  );
}

/**
 * يعرض حالة كل شركة: الاتصالات والفشلات والتحصيل الشهري والحدود والاشتراك.
 *
 * The failure counts and usage ratios sit beside the flags instead of behind
 * a link: the super admin reads this screen to spot broken integrations or
 * companies approaching plan ceilings at a glance.
 */
export function CompanyHealthTable({ rows, loading, error }: CompanyHealthTableProps) {
  const { t } = useI18n();

  if (loading) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        {t("platformOverview.loading")}
      </p>
    );
  }

  if (error) {
    return (
      <p className="p-6 text-sm text-destructive" role="alert">
        {error}
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        {t("platformOverview.health.empty")}
      </p>
    );
  }

  const formatBytes = (value: number) => formatStorageBytes(value, t);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("platformOverview.health.company")}</TableHead>
          <TableHead>{t("platformOverview.health.status")}</TableHead>
          <TableHead>{t("platformOverview.health.whatsapp")}</TableHead>
          <TableHead>{t("platformOverview.health.gateway")}</TableHead>
          <TableHead>{t("platformOverview.health.jobsFailed")}</TableHead>
          <TableHead>{t("platformOverview.health.notificationsFailed")}</TableHead>
          <TableHead>{t("platformOverview.health.collected")}</TableHead>
          <TableHead>{t("platformOverview.health.units")}</TableHead>
          <TableHead>{t("platformOverview.health.staff")}</TableHead>
          <TableHead>{t("platformOverview.health.whatsappUsage")}</TableHead>
          <TableHead>{t("platformOverview.health.storage")}</TableHead>
          <TableHead>{t("platformOverview.health.subscription")}</TableHead>
          <TableHead>{t("platformOverview.health.renewalDate")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.company_id}>
            <TableCell>
              <span className="block font-medium">{row.name_ar}</span>
              <span dir="ltr" className="block text-xs text-muted-foreground">
                {row.name_en}
              </span>
            </TableCell>
            <TableCell>
              <Badge variant={row.status === "active" ? "success" : "warning"}>
                {row.status === "active"
                  ? t("platformOverview.status.active")
                  : t("platformOverview.status.suspended")}
              </Badge>
            </TableCell>
            <TableCell>
              <HealthBadge value={row.whatsapp_ok} />
            </TableCell>
            <TableCell>
              <HealthBadge value={row.gateway_ok} />
            </TableCell>
            <TableCell className="tabular-nums">{row.jobs_failed_24h}</TableCell>
            <TableCell className="tabular-nums">{row.notifications_failed_24h}</TableCell>
            <TableCell dir="ltr" className="tabular-nums">
              {formatCollectedKwd(row.collected_this_month)}
            </TableCell>
            <TableCell>
              <CompanyHealthUsageCell used={row.units_used} max={row.units_max} />
            </TableCell>
            <TableCell>
              <CompanyHealthUsageCell used={row.staff_used} max={row.staff_max} />
            </TableCell>
            <TableCell>
              <CompanyHealthUsageCell used={row.whatsapp_used} max={row.whatsapp_max} />
            </TableCell>
            <TableCell>
              <CompanyHealthUsageCell
                used={row.storage_bytes}
                max={row.storage_max}
                formatValue={formatBytes}
              />
            </TableCell>
            <TableCell>
              <SubscriptionBadge status={row.subscription_status} />
            </TableCell>
            <TableCell dir="ltr" className="tabular-nums">
              {row.subscription_renewal_date ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
