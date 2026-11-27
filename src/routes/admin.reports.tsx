import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { guardModuleRoute } from "@/company/requireModule";
import { Download, Printer, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { BudgetDashboard } from "@/components/admin/BudgetDashboard";
import { ModuleHeader, Pager, TableState } from "@/components/admin/Phase2Ui";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/usePermissions";
import { fetchReportExport, useReportPreview, type ReportType } from "@/hooks/useReportPreview";
import { useRunScheduledReports } from "@/hooks/useRunScheduledReports";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type { TenantCategory, TenantLifecycle } from "@/integrations/supabase/database.types";
import { reportPreviewSortValue } from "@/lib/adminTableSortValues";
import { exportRecordsToCsv } from "@/lib/csv";
import { tenantCategoryTone, tenantLifecycleTone } from "@/lib/statusTone";
import { PERMISSIONS } from "@/lib/permissions";
import { auditPrint } from "@/lib/exportAudit";

export const Route = createFileRoute("/admin/reports")({
  beforeLoad: () => guardModuleRoute("reports"),
  component: ReportsPage,
});

const reportTypes: ReportType[] = [
  "tenant_report",
  "payment_report",
  "expenses",
  "deposits",
  "overdue_aging",
  "property_status",
  "tenant_status",
];

/**
 * The preview table renders whatever columns the selected report emits, so a
 * badge can only be keyed on the column name together with the value. The
 * expenses report also has a `category` column, but it holds free-text
 * category names ("Maintenance"), not a `TenantCategory` — badging those by
 * column name alone would mistone them and ask for a translation key that
 * does not exist.
 */
const TENANT_LIFECYCLES = new Set<string>([
  "active",
  "inactive",
  "contract_ended",
  "blocked",
] satisfies TenantLifecycle[]);
const TENANT_CATEGORIES = new Set<string>([
  "vip",
  "uncommitted",
  "chronically_distressed",
  "standard",
  "custom",
] satisfies TenantCategory[]);

function ReportsPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const today = new Date().toISOString().slice(0, 10);
  const [type, setType] = useState<ReportType>("tenant_report");
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [previewPage, setPreviewPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const preview = useReportPreview(
    { type, from, to, search: debouncedSearch, locale },
    permissions.can(PERMISSIONS.REPORTS_READ),
  );
  const runAll = useRunScheduledReports();
  const previewRowsAll = preview.data?.rows ?? [];
  const columns = Object.keys(previewRowsAll[0] ?? {});
  const {
    sort,
    toggle,
    sorted: sortedPreview,
  } = useTableSort(previewRowsAll, reportPreviewSortValue);
  // Client-side paging of the already-capped server preview (≤ REPORT_PREVIEW_LIMIT).
  const previewRows = sortedPreview.slice((previewPage - 1) * 20, previewPage * 20);

  /** Badge the tenant enums; anything else keeps rendering as plain text. */
  const renderPreviewCell = (column: string, value: number | string) => {
    const text = String(value);
    if (column === "lifecycle" && TENANT_LIFECYCLES.has(text)) {
      return (
        <Badge variant={tenantLifecycleTone(text as TenantLifecycle)}>
          {t(`tenantLifecycle.${text}`)}
        </Badge>
      );
    }
    if (column === "category" && TENANT_CATEGORIES.has(text)) {
      return (
        <Badge variant={tenantCategoryTone(text as TenantCategory)}>
          {t(`tenantCategory.${text}`)}
        </Badge>
      );
    }
    return value;
  };

  if (!permissions.can(PERMISSIONS.REPORTS_READ)) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  return (
    <div className="space-y-6">
      <ModuleHeader
        title={t("reports.title")}
        subtitle={t("reports.subtitle")}
        actions={
          <Button
            variant="outline"
            disabled={runAll.isPending}
            onClick={async () => {
              try {
                await runAll.mutateAsync();
                toast.success(t("reports.scheduleDone"));
              } catch (error) {
                toast.error(error instanceof Error ? error.message : t("common.error"));
              }
            }}
          >
            <RefreshCw className="size-4" />
            {t("reports.runAll")}
          </Button>
        }
      />

      <p className="text-sm text-muted-foreground">
        {t("reports.schedulesMovedPrefix")}{" "}
        <Link
          to="/admin/settings/notifications"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("reports.schedulesMovedLink")}
        </Link>
        {t("reports.schedulesMovedSuffix")}
      </p>

      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview">{t("reports.preview")}</TabsTrigger>
          <TabsTrigger value="budget">{t("budget.title")}</TabsTrigger>
        </TabsList>

        <TabsContent value="budget">
          <BudgetDashboard />
        </TabsContent>

        <TabsContent value="preview">
          <Card>
            <CardHeader className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="space-y-2">
                <Label>{t("reports.reportType")}</Label>
                <Select
                  value={type}
                  onValueChange={(value) => {
                    setType(value as ReportType);
                    setPreviewPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {reportTypes.map((item) => (
                      <SelectItem key={item} value={item}>
                        {t(`reportType.${item}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("common.from")}</Label>
                <DateInput
                  value={from}
                  onChange={(value) => {
                    setFrom(value);
                    setPreviewPage(1);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("common.to")}</Label>
                <DateInput
                  value={to}
                  onChange={(value) => {
                    setTo(value);
                    setPreviewPage(1);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("common.search")}</Label>
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPreviewPage(1);
                  }}
                  placeholder={t("common.search")}
                />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  variant="outline"
                  disabled={
                    exporting ||
                    !(preview.data?.total ?? 0) ||
                    !permissions.can(PERMISSIONS.REPORTS_EXPORT)
                  }
                  onClick={async () => {
                    // Full export path — never ships only the preview page.
                    setExporting(true);
                    try {
                      // Same locale as the preview: an export that disagrees
                      // with the screen it was taken from is worse than either.
                      const rows = await fetchReportExport({
                        type,
                        from,
                        to,
                        search: debouncedSearch,
                        locale,
                      });
                      exportRecordsToCsv(rows, `${type}.csv`);
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : t("common.error"));
                    } finally {
                      setExporting(false);
                    }
                  }}
                >
                  <Download className="size-4" />
                  {t("reports.export")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!previewRowsAll.length}
                  onClick={() => {
                    auditPrint("report", null);
                    window.print();
                  }}
                >
                  <Printer className="size-4" />
                  {t("reports.print")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {preview.data?.truncated ? (
                <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                  {t("reports.previewPartial")
                    .replace("{shown}", String(previewRowsAll.length))
                    .replace("{total}", String(preview.data.total))}
                </p>
              ) : null}
              <TableState
                loading={preview.isLoading}
                error={preview.isError}
                empty={!previewRows.length}
              >
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        {columns.map((column) => (
                          <SortableHead key={column} sortKey={column} sort={sort} toggle={toggle}>
                            {column.replace(/_/g, " ")}
                          </SortableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row, index) => (
                        <TableRow key={`${previewPage}-${index}`}>
                          <TableCell>{(previewPage - 1) * 20 + index + 1}</TableCell>
                          {columns.map((column) => (
                            <TableCell key={column}>
                              {renderPreviewCell(column, row[column])}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TableState>
              <Pager
                page={previewPage}
                pageSize={20}
                count={previewRowsAll.length}
                setPage={setPreviewPage}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
