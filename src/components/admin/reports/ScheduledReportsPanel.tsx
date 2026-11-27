import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { DeleteConfirmation, Pager, TableState } from "@/components/admin/Phase2Ui";
import { ScheduleDialog } from "@/components/admin/reports/ScheduleDialog";
import { ScheduledReportsTable } from "@/components/admin/ScheduledReportsTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { usePermissions } from "@/hooks/usePermissions";
import {
  useDeleteReportSchedule,
  useReportSchedules,
  useRunReportSchedule,
} from "@/hooks/useReportSchedules";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * لوحة جداول التقارير: البحث، الجدول، التشغيل الفوري، الإضافة والتعديل والحذف.
 *
 * `dialogKey` changes on every open so `ScheduleDialog` remounts and seeds its
 * draft from the row being edited — or from nothing, for an add.
 */
export function ScheduledReportsPanel() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [target, setTarget] = useState<Tables<"report_schedules"> | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Tables<"report_schedules"> | null>(null);

  const schedules = useReportSchedules({ page, pageSize: 10, search: debouncedSearch }, true);
  const deleteSchedule = useDeleteReportSchedule();
  const runSchedule = useRunReportSchedule();

  const openDialog = (schedule?: Tables<"report_schedules">) => {
    setTarget(schedule ?? null);
    setDialogKey((key) => key + 1);
    setDialogOpen(true);
  };

  const runOne = async (scheduleId: string) => {
    try {
      await runSchedule.mutateAsync(scheduleId);
      // The report is queued, not built: `runReportSchedule` files a
      // `report.run` job and the worker renders and sends it. "Scheduled
      // reports were run" would claim work this request never did.
      toast.success(t("deferred.reportQueued"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">{t("reports.schedules")}</CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              className="max-w-sm"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder={t("common.search")}
            />
            <Button
              disabled={!permissions.can(PERMISSIONS.REPORTS_CREATE)}
              onClick={() => openDialog()}
            >
              <Plus className="size-4" />
              {t("reports.addSchedule")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <TableState
            loading={schedules.isLoading}
            error={schedules.isError}
            empty={!schedules.data?.items.length}
          >
            <ScheduledReportsTable
              items={schedules.data?.items ?? []}
              page={page}
              onRun={runOne}
              onEdit={openDialog}
              onDelete={setPendingDelete}
            />
          </TableState>
          <Pager page={page} pageSize={10} count={schedules.data?.count ?? 0} setPage={setPage} />
        </CardContent>
      </Card>

      <ScheduleDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={target}
      />

      <DeleteConfirmation
        open={Boolean(pendingDelete)}
        pending={deleteSchedule.isPending}
        title={t("common.delete")}
        description={t("reports.deleteConfirm")}
        close={() => setPendingDelete(null)}
        confirm={async () => {
          if (!pendingDelete) return;
          try {
            await deleteSchedule.mutateAsync(pendingDelete.id);
            setPendingDelete(null);
            toast.success(t("common.saved"));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
    </>
  );
}
