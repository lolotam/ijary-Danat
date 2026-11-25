import { Pencil, Play, Trash2 } from "lucide-react";

import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
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
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import { reportScheduleSortValue } from "@/lib/adminTableSortValues";
import { reportFrequencyTone, reportLocaleTone } from "@/lib/statusTone";

/**
 * جدول التقارير المجدولة — رأس كل عمود بيانات قابل للترتيب بالقيمة الخام.
 */
export function ScheduledReportsTable({
  items,
  page,
  onRun,
  onEdit,
  onDelete,
}: {
  items: Tables<"report_schedules">[];
  page: number;
  onRun: (id: string) => void;
  onEdit: (schedule: Tables<"report_schedules">) => void;
  onDelete: (schedule: Tables<"report_schedules">) => void;
}) {
  const { locale, t } = useI18n();
  const {
    sort,
    toggle,
    sorted: sortedSchedules,
  } = useTableSort(items, (schedule, key) => reportScheduleSortValue(schedule, key, locale));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <SortableHead sortKey="code" sort={sort} toggle={toggle}>
            {t("reports.code")}
          </SortableHead>
          <SortableHead sortKey="name" sort={sort} toggle={toggle}>
            {t("common.name")}
          </SortableHead>
          <SortableHead sortKey="frequency" sort={sort} toggle={toggle}>
            {t("reports.frequency")}
          </SortableHead>
          <SortableHead sortKey="recipients" sort={sort} toggle={toggle}>
            {t("reports.recipients")}
          </SortableHead>
          <SortableHead sortKey="locale" sort={sort} toggle={toggle}>
            {t("reports.locale")}
          </SortableHead>
          <SortableHead sortKey="last_run_at" sort={sort} toggle={toggle}>
            {t("reports.lastRun")}
          </SortableHead>
          <SortableHead sortKey="next_run_at" sort={sort} toggle={toggle}>
            {t("reports.nextRun")}
          </SortableHead>
          <SortableHead sortKey="is_active" sort={sort} toggle={toggle}>
            {t("common.status")}
          </SortableHead>
          <TableHead>{t("common.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedSchedules.map((schedule, index) => (
          <TableRow key={schedule.id}>
            <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
            <TableCell className="font-mono">{schedule.code}</TableCell>
            <TableCell>
              <div className="font-semibold text-foreground">
                {locale === "ar" ? schedule.name_ar : schedule.name_en || schedule.name_ar}
              </div>
              {schedule.name_en && (
                <div className="text-xs text-muted-foreground">
                  {locale === "ar" ? schedule.name_en : schedule.name_ar}
                </div>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={reportFrequencyTone(schedule.frequency)}>
                {t(`reportFrequency.${schedule.frequency}`)}
              </Badge>
            </TableCell>
            <TableCell className="max-w-56 whitespace-normal text-xs">
              {Array.isArray(schedule.recipients) ? schedule.recipients.join(", ") : "—"}
            </TableCell>
            <TableCell>
              <Badge variant={reportLocaleTone(schedule.locale)}>
                {t(`localeName.${schedule.locale}`)}
              </Badge>
            </TableCell>
            <TableCell className="text-xs">
              {schedule.last_run_at ? new Date(schedule.last_run_at).toLocaleString("en-GB") : "—"}
            </TableCell>
            <TableCell className="text-xs">
              {schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString("en-GB") : "—"}
            </TableCell>
            <TableCell>
              <Badge variant={schedule.is_active ? "default" : "secondary"}>
                {schedule.is_active ? t("common.yes") : t("common.no")}
              </Badge>
            </TableCell>
            <TableCell>
              <div className="flex">
                <Button
                  size="icon"
                  variant="ghost"
                  title={t("reports.runOne")}
                  onClick={() => onRun(schedule.id)}
                >
                  <Play className="size-4" />
                  <span className="sr-only">{t("reports.runOne")}</span>
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => onEdit(schedule)}
                  title={t("common.edit")}
                  aria-label={t("common.edit")}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                  size="icon"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => onDelete(schedule)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
