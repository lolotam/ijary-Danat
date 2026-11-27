import { Fragment, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { guardModuleRoute } from "@/company/requireModule";
import { ChevronDown, ChevronUp } from "lucide-react";

import { AuditFiltersPanel } from "@/components/admin/audit/AuditFiltersPanel";
import { LogRetentionCard } from "@/components/admin/LogRetentionCard";
import { LOG_PAGE_SIZE_OPTIONS, Pager } from "@/components/admin/Phase2Ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuditLogs, type AuditLogFilters } from "@/hooks/useAuditLogs";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import type { AuditResult, Json, Tables } from "@/integrations/supabase/database.types";
import { auditActionLabel, auditEntityLabel, auditRoleLabel } from "@/lib/auditLabels";
import { PERMISSIONS } from "@/lib/permissions";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";

export const Route = createFileRoute("/admin/audit")({
  beforeLoad: () => guardModuleRoute("audit"),
  component: AuditLogPage,
});

/** الحجم الافتراضي لصفحة السجل — أصغر خيارات LOG_PAGE_SIZE_OPTIONS. */
const DEFAULT_PAGE_SIZE = 25;

function jsonText(value: Json | null): string {
  return value === null ? "—" : JSON.stringify(value, null, 2);
}

function AuditDetails({ log }: { log: Tables<"audit_logs"> }) {
  const { t } = useI18n();

  if (log.before === null && log.after === null) {
    return <p className="text-sm text-muted-foreground">{t("audit.noChanges")}</p>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("audit.before")}
        </h3>
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs" dir="ltr">
          {jsonText(log.before)}
        </pre>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("audit.after")}
        </h3>
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs" dir="ltr">
          {jsonText(log.after)}
        </pre>
      </div>
    </div>
  );
}

function AuditResultBadge({ result }: { result: AuditResult }) {
  const { t } = useI18n();
  const className =
    result === "success"
      ? "border-emerald-600/30 bg-emerald-600/10 text-emerald-700"
      : result === "failure"
        ? "border-amber-600/30 bg-amber-600/10 text-amber-700"
        : "border-destructive/30 bg-destructive/10 text-destructive";
  return (
    <Badge className={className} variant="outline">
      {t(`audit.${result}`)}
    </Badge>
  );
}

function AuditRow({
  log,
  rowNumber,
  dateFormatter,
  expanded,
  setExpandedId,
}: {
  log: Tables<"audit_logs">;
  rowNumber: number;
  dateFormatter: Intl.DateTimeFormat;
  expanded: boolean;
  setExpandedId: (id: string | null) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <Fragment>
      <TableRow>
        <TableCell>{rowNumber}</TableCell>
        <TableCell className="whitespace-nowrap">
          {dateFormatter.format(new Date(log.created_at))}
        </TableCell>
        <TableCell>{log.actor_label ?? t("audit.system")}</TableCell>
        <TableCell>{log.role ? auditRoleLabel(log.role, locale) : "—"}</TableCell>
        {/* Translated label, raw code on hover: the code is what support and
            the filter dropdown match on, so it must stay reachable. */}
        <TableCell title={log.action}>{auditActionLabel(log.action, locale)}</TableCell>
        <TableCell title={log.entity_type ?? undefined}>
          {log.entity_type ? auditEntityLabel(log.entity_type, locale) : "—"}
        </TableCell>
        <TableCell className="max-w-40 truncate font-mono text-xs">
          {log.entity_id ?? "—"}
        </TableCell>
        <TableCell>
          <AuditResultBadge result={log.result} />
        </TableCell>
        <TableCell>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={expanded ? t("audit.collapse") : t("audit.expand")}
            aria-label={expanded ? t("audit.collapse") : t("audit.expand")}
            aria-expanded={expanded}
            onClick={() => setExpandedId(expanded ? null : log.id)}
          >
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={9} className="bg-muted/20 p-4">
            <div className="mb-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
              <span>
                {log.method ?? "—"} {log.path ?? ""}
              </span>
              <span>{log.correlation_id ?? "—"}</span>
              <span>{log.error_code ?? "—"}</span>
            </div>
            <AuditDetails log={log} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

function AuditTableView({
  rows,
  page,
  pageSize,
  locale,
  expandedId,
  setExpandedId,
}: {
  rows: Tables<"audit_logs">[];
  page: number;
  pageSize: number;
  locale: "ar" | "en";
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const {
    sort,
    toggle,
    sorted: sortedRows,
  } = useTableSort(rows, (log, key) => (log as unknown as Record<string, unknown>)[key]);
  const dateFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <SortableHead sortKey="created_at" sort={sort} toggle={toggle}>
            {t("audit.createdAt")}
          </SortableHead>
          <SortableHead sortKey="actor_label" sort={sort} toggle={toggle}>
            {t("audit.actor")}
          </SortableHead>
          <SortableHead sortKey="role" sort={sort} toggle={toggle}>
            {t("audit.role")}
          </SortableHead>
          <SortableHead sortKey="action" sort={sort} toggle={toggle}>
            {t("audit.action")}
          </SortableHead>
          <SortableHead sortKey="entity_type" sort={sort} toggle={toggle}>
            {t("audit.entityType")}
          </SortableHead>
          <SortableHead sortKey="entity_id" sort={sort} toggle={toggle}>
            {t("audit.entityId")}
          </SortableHead>
          <SortableHead sortKey="result" sort={sort} toggle={toggle}>
            {t("audit.result")}
          </SortableHead>
          <TableHead>
            <span className="sr-only">{t("common.details")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedRows.map((log, index) => (
          <AuditRow
            key={log.id}
            log={log}
            rowNumber={(page - 1) * pageSize + index + 1}
            dateFormatter={dateFormatter}
            expanded={expandedId === log.id}
            setExpandedId={setExpandedId}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function AuditLogPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const canRead = permissions.can(PERMISSIONS.AUDIT_READ);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditLogFilters>({ result: "all" });
  const auditQuery = useAuditLogs(page, pageSize, filters, !permissions.isLoading && canRead);

  function updateFilter<Key extends keyof AuditLogFilters>(key: Key, value: AuditLogFilters[Key]) {
    setPage(1);
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function resetFilters() {
    setPage(1);
    setFilters({ result: "all" });
  }

  if (permissions.isLoading)
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (permissions.error) return <p className="text-sm text-destructive">{t("common.error")}</p>;
  if (!canRead) return <p className="text-sm text-destructive">{t("common.notAuthorized")}</p>;

  const rows = auditQuery.data?.rows ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("audit.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("audit.subtitle")}</p>
      </div>

      <LogRetentionCard log="audit" canManage={permissions.isAdmin} />

      <AuditFiltersPanel
        filters={filters}
        updateFilter={updateFilter}
        resetFilters={resetFilters}
      />

      <div className="rounded-lg border bg-card">
        {auditQuery.isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : auditQuery.error ? (
          <p className="p-6 text-sm text-destructive">{t("common.error")}</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{t("common.empty")}</p>
        ) : (
          <AuditTableView
            rows={rows}
            page={page}
            pageSize={pageSize}
            locale={locale}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
          />
        )}
        {rows.length > 0 && (
          <Pager
            page={page}
            pageSize={pageSize}
            count={auditQuery.data?.count ?? 0}
            setPage={setPage}
            setPageSize={setPageSize}
            pageSizeOptions={LOG_PAGE_SIZE_OPTIONS}
          />
        )}
      </div>
    </div>
  );
}
