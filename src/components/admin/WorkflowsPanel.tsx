import { useMemo, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { toast } from "sonner";

import { AddWorkflowDialog } from "@/components/admin/AddWorkflowDialog";
import { ModuleHeader, TableState } from "@/components/admin/Phase2Ui";
import { WorkflowTable } from "@/components/admin/WorkflowTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toaster } from "@/components/ui/sonner";
import { useCronJobs, useSetCronJobActive, type CronJob } from "@/hooks/useCronJobs";
import { useNotificationTemplates } from "@/hooks/useNotificationTemplates";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import { PERMISSIONS } from "@/lib/permissions";

type WorkflowFilter = "all" | "scheduled" | "event" | "active" | "inactive";

/**
 * شاشة سير العمل: جدول موحّد لصفوف السجل، مع شرائح القوالب المرتبطة بكل سير.
 *
 * The Workflows screen: one unified table of registry rows.
 *
 * Scheduled jobs are dispatched by the cron endpoint on a timetable. Action
 * trigger workflows fire when something happens — a deposit is confirmed, an
 * account is created. Both live in the same registry table and are switched
 * the same way, so they share one query and one renderer. Filters above the
 * table replace the old two-tab split.
 *
 * A component rather than a route body because it renders in two places: the
 * standalone /admin/settings/cron route and the Workflows tab of the
 * Automations screen. It keeps its own admin check so neither host has to
 * guard it.
 */
export function WorkflowsPanel({
  templatesByCode,
  onEditTemplate,
}: {
  templatesByCode?: ReadonlyMap<string, Tables<"notification_templates">>;
  onEditTemplate?: (template: Tables<"notification_templates">) => void;
} = {}) {
  const { t } = useI18n();
  const permissions = usePermissions();
  const canManage = permissions.can(PERMISSIONS.WORKFLOWS_MANAGE);
  // `/admin/settings/cron` mounts this panel as the route component and cannot
  // pass a template map. Load here only in that case; the notifications route
  // already queries the same rows and hands them in.
  const ownTemplates = useNotificationTemplates(templatesByCode == null && canManage);
  const resolvedTemplates = useMemo(() => {
    if (templatesByCode) return templatesByCode;
    return new Map((ownTemplates.data ?? []).map((row) => [row.code, row]));
  }, [ownTemplates.data, templatesByCode]);
  const jobs = useCronJobs(!permissions.isLoading && canManage);
  const setActive = useSetCronJobActive();
  const [filter, setFilter] = useState<WorkflowFilter>("all");
  const [addOpen, setAddOpen] = useState(false);

  const rows = useMemo(() => jobs.data ?? [], [jobs.data]);

  const counts = useMemo(() => {
    let scheduled = 0;
    let event = 0;
    let active = 0;
    let inactive = 0;
    for (const job of rows) {
      if (job.kind === "event") event += 1;
      else scheduled += 1;
      if (job.is_active) active += 1;
      else inactive += 1;
    }
    return { all: rows.length, scheduled, event, active, inactive };
  }, [rows]);

  const filtered = useMemo(() => {
    switch (filter) {
      case "scheduled":
        return rows.filter((job) => job.kind !== "event");
      case "event":
        return rows.filter((job) => job.kind === "event");
      case "active":
        return rows.filter((job) => job.is_active);
      case "inactive":
        return rows.filter((job) => !job.is_active);
      default:
        return rows;
    }
  }, [rows, filter]);

  // Scoped to the scheduled rows on purpose. "Nothing has ever run" is a real
  // warning for cron and actively wrong for events — a fleet of
  // never-triggered event rows would otherwise either raise a false alarm or,
  // once one fires, suppress a genuine one.
  const nothingHasEverRun = useMemo(() => {
    const scheduled = rows.filter((job) => job.kind !== "event");
    return scheduled.length > 0 && scheduled.every((job) => !job.last_run_at);
  }, [rows]);

  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!canManage) {
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  }

  function toggle(job: CronJob, isActive: boolean) {
    setActive.mutate(
      { id: job.id, isActive },
      {
        onSuccess: () => toast.success(isActive ? t("cron.resumed") : t("cron.paused")),
        onError: (error) => toast.error(error instanceof Error ? error.message : t("common.error")),
      },
    );
  }

  const filters: { value: WorkflowFilter; label: string; count: number }[] = [
    { value: "all", label: t("workflows.filterAll"), count: counts.all },
    { value: "scheduled", label: t("workflows.filterScheduled"), count: counts.scheduled },
    { value: "event", label: t("workflows.filterEvent"), count: counts.event },
    { value: "active", label: t("workflows.filterActive"), count: counts.active },
    { value: "inactive", label: t("workflows.filterInactive"), count: counts.inactive },
  ];

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader title={t("workflows.title")} subtitle={t("workflows.subtitle")} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(value) => {
            if (value) setFilter(value as WorkflowFilter);
          }}
          variant="outline"
          size="sm"
          className="flex flex-wrap justify-start gap-1"
        >
          {filters.map((item) => (
            <ToggleGroupItem
              key={item.value}
              value={item.value}
              className="gap-1.5 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              {item.label}
              <Badge
                variant="secondary"
                className="ms-0.5 h-5 min-w-5 justify-center px-1.5 text-[10px]"
              >
                {item.count}
              </Badge>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {canManage ? (
          <Button type="button" size="sm" onClick={() => setAddOpen(true)} className="shrink-0">
            <Plus className="size-4" />
            {t("workflows.addWorkflow")}
          </Button>
        ) : null}
      </div>

      {nothingHasEverRun && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-medium">{t("cron.nothingScheduled")}</p>
            <p className="mt-1">{t("cron.nothingScheduledHint")}</p>
          </div>
        </div>
      )}

      <TableState loading={jobs.isLoading} error={jobs.isError} empty={!filtered.length}>
        <WorkflowTable
          rows={filtered}
          disabled={setActive.isPending}
          onToggle={toggle}
          templatesByCode={resolvedTemplates}
          onEditTemplate={onEditTemplate}
        />
      </TableState>

      <AddWorkflowDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
