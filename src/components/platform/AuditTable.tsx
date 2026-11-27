import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import type { PlatformAuditLogRow } from "@/integrations/supabase/database.types";

/** عرض جدول سجل تدقيق المنصة لصفحة واحدة. */
export interface AuditTableProps {
  rows: PlatformAuditLogRow[];
  loading: boolean;
  error: string | null;
}

/**
 * يعرض سجل تدقيق المنصة كما كُتب، بدون إعادة بناء حمولات `before` و`after`.
 *
 * The writer strips secrets before insert; showing the stored strings verbatim
 * is what makes the screen an audit of what actually reached the database.
 */
export function AuditTable({ rows, loading, error }: AuditTableProps) {
  const { t } = useI18n();

  if (loading) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        {t("platform.loading")}
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
        {t("platform.audit.empty")}
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("platform.audit.time")}</TableHead>
          <TableHead>{t("platform.audit.actor")}</TableHead>
          <TableHead>{t("platform.audit.action")}</TableHead>
          <TableHead>{t("platform.audit.entity")}</TableHead>
          <TableHead>{t("platform.audit.company")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell dir="ltr" className="whitespace-nowrap text-xs tabular-nums">
              <time dateTime={row.created_at}>{row.created_at}</time>
            </TableCell>
            <TableCell dir="ltr" className="font-mono text-xs">
              {row.actor_id ?? t("platform.audit.unknownActor")}
            </TableCell>
            <TableCell dir="ltr" className="font-mono text-xs">
              {row.action}
            </TableCell>
            <TableCell dir="ltr" className="font-mono text-xs">
              {row.entity}
            </TableCell>
            <TableCell dir="ltr" className="font-mono text-xs">
              {row.company_id ?? t("platform.audit.noCompany")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
