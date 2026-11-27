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

/** ما يعرضه جدول حالة الشركات. */
export interface CompanyHealthTableProps {
  rows: PlatformCompanyHealth[];
  loading: boolean;
  error: string | null;
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
 * يعرض حالة كل شركة: واتساب، وبوابة الدفع، والفشلات خلال آخر 24 ساعة.
 *
 * The failure counts sit beside the flags instead of behind a link: the super
 * admin reads this screen to learn that something is broken, and a count of
 * zero already says the queue is quiet.
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
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
