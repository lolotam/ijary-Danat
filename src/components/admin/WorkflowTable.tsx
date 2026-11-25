import { useState } from "react";
import { Play, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { CardField, MobileCardList } from "@/components/admin/MobileCardList";
import { DeleteConfirmation } from "@/components/admin/Phase2Ui";
import { RecipientTargetsPicker } from "@/components/admin/RecipientTargetsPicker";
import { WorkflowTemplateChips } from "@/components/admin/WorkflowTemplateChips";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LtrText } from "@/components/ui/ltr-text";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useDeleteWorkflow,
  useSetWorkflowRecipients,
  useTestRunWorkflow,
  type CronJob,
} from "@/hooks/useCronJobs";
import { useIsMobile } from "@/hooks/use-mobile";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import {
  WORKFLOW_CATALOG,
  isBuiltInWorkflow,
  type WorkflowRecipientTarget,
} from "@/lib/workflowCatalog";

/**
 * يعرض سجل سير العمل في جدول واحد على الشاشات الواسعة وبطاقات على الجوال.
 *
 * One unified renderer for the Workflows registry.
 *
 * Per-row wording derives from `job.kind`. That distinction is deliberate:
 * "Never run" reads as a fault for a nightly job and is perfectly normal for
 * an event workflow — no deposit has been confirmed yet is not a
 * misconfiguration. Likewise duration means enqueue time for an event
 * workflow: delivery happens later, in the notification-drain job, so calling
 * it a send time would mislead.
 *
 * `last_error` on a skipped row carries the *reason* the sender had nothing to
 * do ("Already notified.", "No confirmed payments.") rather than a fault, so it
 * is rendered muted. Only a genuine error is rendered destructive.
 *
 * A row whose key is absent from WORKFLOW_CATALOG is registry-only: "Not
 * wired" badge, Run-now disabled, Delete enabled. Built-in keys cannot be
 * deleted from the UI.
 */
export function WorkflowTable({
  rows,
  disabled,
  onToggle,
  templatesByCode,
  onEditTemplate,
}: {
  rows: CronJob[];
  disabled: boolean;
  onToggle: (job: CronJob, isActive: boolean) => void;
  templatesByCode: ReadonlyMap<string, Tables<"notification_templates">>;
  onEditTemplate?: (template: Tables<"notification_templates">) => void;
}) {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const setRecipients = useSetWorkflowRecipients();
  const deleteWorkflow = useDeleteWorkflow();
  const testRun = useTestRunWorkflow();
  const [deleteTarget, setDeleteTarget] = useState<CronJob | null>(null);

  const dateFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const name = (job: CronJob) => (locale === "ar" ? job.name_ar : job.name_en);
  const description = (job: CronJob) =>
    (locale === "ar" ? job.description_ar : job.description_en) ?? "";

  const emptyRunLabel = (job: CronJob) =>
    job.kind === "event" ? t("workflows.neverTriggered") : t("cron.neverRun");
  const lastRunLabel = (job: CronJob) =>
    job.kind === "event" ? t("workflows.lastTriggered") : t("cron.lastRun");
  const durationLabel = (job: CronJob) =>
    job.kind === "event" ? t("workflows.queueTime") : t("cron.duration");

  function statusBadge(job: CronJob) {
    if (!job.last_run_at) return <Badge variant="outline">{emptyRunLabel(job)}</Badge>;
    if (job.last_status === "error") return <Badge variant="destructive">{t("cron.error")}</Badge>;
    if (job.last_status === "skipped") return <Badge variant="outline">{t("cron.skipped")}</Badge>;
    return <Badge variant="secondary">{t("cron.success")}</Badge>;
  }

  function triggerCell(job: CronJob) {
    const catalog = WORKFLOW_CATALOG[job.key];
    if (!catalog) return <span className="text-muted-foreground">—</span>;
    if (catalog.kind === "scheduled" && catalog.schedule) {
      return <LtrText className="font-mono text-xs">{catalog.schedule}</LtrText>;
    }
    // Event built-in: show the event key as the trigger identifier.
    return <LtrText className="font-mono text-xs">{job.key}</LtrText>;
  }

  function supportedTargets(job: CronJob): WorkflowRecipientTarget[] {
    return WORKFLOW_CATALOG[job.key]?.supportedTargets ?? ["admin", "company", "tenant"];
  }

  function canRunNow(job: CronJob): boolean {
    if (!isBuiltInWorkflow(job.key)) return false;
    const catalog = WORKFLOW_CATALOG[job.key];
    return catalog?.kind === "scheduled" && Boolean(catalog.runPermission);
  }

  function canDelete(job: CronJob): boolean {
    return !isBuiltInWorkflow(job.key);
  }

  /**
   * Why Run-now is unavailable, which is never obvious from a greyed button:
   * an event workflow has no payload to replay, and a custom row has no
   * dispatcher at all.
   */
  function runNowTitle(job: CronJob): string {
    if (canRunNow(job)) return t("workflows.runNow");
    return isBuiltInWorkflow(job.key)
      ? t("workflows.runNowEventDisabled")
      : t("workflows.notWired");
  }

  function handleRecipients(job: CronJob, next: WorkflowRecipientTarget[]) {
    setRecipients.mutate(
      { id: job.id, recipient_targets: next },
      {
        onError: (error) => toast.error(error instanceof Error ? error.message : t("common.error")),
      },
    );
  }

  function handleRunNow(job: CronJob) {
    testRun.mutate(
      { key: job.key },
      {
        onSuccess: (result) => {
          if (result.skipped) toast.success(t("workflows.runSkipped"));
          else toast.success(t("workflows.runSuccess"));
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : t("common.error")),
      },
    );
  }

  const { sort, toggle, sorted } = useTableSort(rows, (job, key) => {
    switch (key) {
      case "is_active":
        return job.is_active;
      case "name":
        return name(job);
      case "kind":
        return job.kind;
      case "trigger": {
        const catalog = WORKFLOW_CATALOG[job.key];
        if (!catalog) return "";
        if (catalog.kind === "scheduled") return catalog.schedule ?? "";
        return job.key;
      }
      case "last_run_at":
        return job.last_run_at;
      default:
        return null;
    }
  });

  const busy = disabled || setRecipients.isPending || deleteWorkflow.isPending || testRun.isPending;

  if (isMobile) {
    return (
      <>
        <MobileCardList
          items={sorted}
          keyFor={(job) => job.id}
          renderCard={(job) => {
            const wired = isBuiltInWorkflow(job.key);
            return (
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{name(job)}</p>
                    <p className="text-xs text-muted-foreground">{description(job)}</p>
                    <p className="font-mono text-xs text-muted-foreground">{job.key}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {statusBadge(job)}
                    {!wired ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        {t("workflows.notWired")}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <CardField label={t("workflows.template")}>
                  <WorkflowTemplateChips
                    workflowKey={job.key}
                    templatesByCode={templatesByCode}
                    onEdit={onEditTemplate}
                  />
                </CardField>
                <CardField label={t("workflows.kind")}>
                  <Badge variant={job.kind === "event" ? "secondary" : "outline"}>
                    {job.kind === "event" ? t("workflows.kindEvent") : t("workflows.kindScheduled")}
                  </Badge>
                </CardField>
                <CardField label={t("workflows.triggerSchedule")}>{triggerCell(job)}</CardField>
                <CardField label={t("workflows.recipients")}>
                  <RecipientTargetsPicker
                    value={job.recipient_targets ?? ["admin", "company"]}
                    supported={supportedTargets(job)}
                    disabled={busy}
                    onChange={(next) => handleRecipients(job, next)}
                  />
                </CardField>
                <CardField label={lastRunLabel(job)}>
                  {job.last_run_at ? (
                    <LtrText>{dateFormatter.format(new Date(job.last_run_at))}</LtrText>
                  ) : (
                    emptyRunLabel(job)
                  )}
                </CardField>
                <CardField label={durationLabel(job)}>
                  {job.last_duration_ms != null ? (
                    <LtrText>{`${job.last_duration_ms} ms`}</LtrText>
                  ) : (
                    "—"
                  )}
                </CardField>
                {job.last_error ? (
                  <CardField label={t("cron.lastError")}>
                    <span
                      className={
                        job.last_status === "skipped" ? "text-muted-foreground" : "text-destructive"
                      }
                    >
                      {job.last_error}
                    </span>
                  </CardField>
                ) : null}
                <div className="flex items-center gap-2">
                  <Switch
                    checked={job.is_active}
                    disabled={busy}
                    onCheckedChange={(checked) => onToggle(job, checked)}
                  />
                  <span className="text-sm">{t("cron.enabled")}</span>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || !canRunNow(job)}
                    onClick={() => handleRunNow(job)}
                    title={runNowTitle(job)}
                  >
                    <Play className="size-3.5" />
                    {t("workflows.runNow")}
                  </Button>
                  {canDelete(job) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setDeleteTarget(job)}
                    >
                      <Trash2 className="size-3.5" />
                      {t("common.delete")}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          }}
        />
        <DeleteConfirmation
          open={Boolean(deleteTarget)}
          pending={deleteWorkflow.isPending}
          title={t("workflows.deleteTitle")}
          description={t("workflows.deleteConfirm")}
          close={() => setDeleteTarget(null)}
          confirm={async () => {
            if (!deleteTarget) return;
            try {
              await deleteWorkflow.mutateAsync({ key: deleteTarget.key });
              setDeleteTarget(null);
              toast.success(t("workflows.deleted"));
            } catch (error) {
              toast.error(error instanceof Error ? error.message : t("common.error"));
            }
          }}
        />
      </>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead sortKey="is_active" sort={sort} toggle={toggle}>
              {t("cron.enabled")}
            </SortableHead>
            <SortableHead sortKey="name" sort={sort} toggle={toggle}>
              {t("workflows.workflow")}
            </SortableHead>
            <TableHead>{t("workflows.template")}</TableHead>
            <SortableHead sortKey="kind" sort={sort} toggle={toggle}>
              {t("workflows.kind")}
            </SortableHead>
            <SortableHead sortKey="trigger" sort={sort} toggle={toggle}>
              {t("workflows.triggerSchedule")}
            </SortableHead>
            <TableHead>{t("workflows.recipients")}</TableHead>
            <SortableHead sortKey="last_run_at" sort={sort} toggle={toggle}>
              {t("cron.lastRun")}
            </SortableHead>
            <TableHead>{t("workflows.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((job) => {
            const wired = isBuiltInWorkflow(job.key);
            return (
              <TableRow key={job.id}>
                <TableCell>
                  <Switch
                    checked={job.is_active}
                    disabled={busy}
                    onCheckedChange={(checked) => onToggle(job, checked)}
                  />
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{name(job)}</p>
                      {!wired ? (
                        <Badge variant="outline" className="text-muted-foreground">
                          {t("workflows.notWired")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{description(job)}</p>
                    <p className="font-mono text-xs text-muted-foreground">{job.key}</p>
                  </div>
                </TableCell>
                <TableCell>
                  <WorkflowTemplateChips
                    workflowKey={job.key}
                    templatesByCode={templatesByCode}
                    onEdit={onEditTemplate}
                  />
                </TableCell>
                <TableCell>
                  <Badge variant={job.kind === "event" ? "secondary" : "outline"}>
                    {job.kind === "event" ? t("workflows.kindEvent") : t("workflows.kindScheduled")}
                  </Badge>
                </TableCell>
                <TableCell>{triggerCell(job)}</TableCell>
                <TableCell>
                  <RecipientTargetsPicker
                    value={job.recipient_targets ?? ["admin", "company"]}
                    supported={supportedTargets(job)}
                    disabled={busy}
                    onChange={(next) => handleRecipients(job, next)}
                  />
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    {job.last_run_at ? (
                      <LtrText className="text-sm">
                        {dateFormatter.format(new Date(job.last_run_at))}
                      </LtrText>
                    ) : (
                      <span className="text-sm text-muted-foreground">{emptyRunLabel(job)}</span>
                    )}
                    <div className="flex flex-wrap items-center gap-1">
                      {statusBadge(job)}
                      {job.last_duration_ms != null ? (
                        <LtrText className="text-xs text-muted-foreground">
                          {`${job.last_duration_ms} ms`}
                        </LtrText>
                      ) : null}
                    </div>
                    {job.last_error ? (
                      <p
                        className={`max-w-64 truncate text-xs ${
                          job.last_status === "skipped"
                            ? "text-muted-foreground"
                            : "text-destructive"
                        }`}
                        title={job.last_error}
                      >
                        {job.last_error}
                      </p>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || !canRunNow(job)}
                      onClick={() => handleRunNow(job)}
                      title={runNowTitle(job)}
                    >
                      <Play className="size-3.5" />
                      <span className="sr-only sm:not-sr-only">{t("workflows.runNow")}</span>
                    </Button>
                    {canDelete(job) ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => setDeleteTarget(job)}
                        title={t("common.delete")}
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">{t("common.delete")}</span>
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={deleteWorkflow.isPending}
        title={t("workflows.deleteTitle")}
        description={t("workflows.deleteConfirm")}
        close={() => setDeleteTarget(null)}
        confirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteWorkflow.mutateAsync({ key: deleteTarget.key });
            setDeleteTarget(null);
            toast.success(t("workflows.deleted"));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
    </>
  );
}
