import { Link } from "@tanstack/react-router";

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
import type { PlatformCompanySummary } from "@/platform/companies";

/** ما يعرضه جدول الشركات. */
export interface CompaniesTableProps {
  rows: PlatformCompanySummary[];
  loading: boolean;
  error: string | null;
}

/**
 * يعرض شركات المنصة في صفحة واحدة، مع حالتها وعدد حسابات كل منها.
 *
 * The account count comes with the row: the super admin reads the size of a
 * company from this table, and a count per row would turn one page into
 * dozens of round trips.
 */
export function CompaniesTable({ rows, loading, error }: CompaniesTableProps) {
  const { t } = useI18n();

  if (loading) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        {t("common.loading")}
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
        {t("platformCompaniesUi.empty")}
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("platformCompaniesUi.column.name")}</TableHead>
          <TableHead>{t("platformCompaniesUi.column.slug")}</TableHead>
          <TableHead>{t("platformCompaniesUi.column.status")}</TableHead>
          <TableHead>{t("platformCompaniesUi.column.users")}</TableHead>
          <TableHead>{t("platformCompaniesUi.column.created")}</TableHead>
          <TableHead>{t("platformCompaniesUi.open")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <span className="block font-medium">{row.nameAr}</span>
              <span dir="ltr" className="block text-xs text-muted-foreground">
                {row.nameEn}
              </span>
            </TableCell>
            <TableCell dir="ltr" className="font-mono text-xs">
              {row.slug}
            </TableCell>
            <TableCell>
              <Badge variant={row.status === "active" ? "success" : "warning"}>
                {row.status === "active"
                  ? t("platformCompaniesUi.status.active")
                  : t("platformCompaniesUi.status.suspended")}
              </Badge>
            </TableCell>
            <TableCell className="tabular-nums">{row.userCount}</TableCell>
            <TableCell className="whitespace-nowrap text-xs tabular-nums">
              <time dateTime={row.createdAt}>{row.createdAt.slice(0, 10)}</time>
            </TableCell>
            <TableCell>
              <Link
                to="/platform/companies/$id"
                params={{ id: row.id }}
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("platformCompaniesUi.open")}
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
