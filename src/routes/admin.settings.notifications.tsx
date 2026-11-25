import { useCompany, useUpdateCompany } from "@/hooks/useCompany";
import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { ScheduledAndGeneratedReports } from "@/components/admin/ScheduledAndGeneratedReports";
import { WorkflowsPanel } from "@/components/admin/WorkflowsPanel";
import { NotificationLogTable } from "@/components/admin/notifications/NotificationLogTable";
import { NotificationPoolFilters } from "@/components/admin/notifications/NotificationPoolFilters";
import { NotificationProvidersTab } from "@/components/admin/notifications/NotificationProvidersTab";
import { NotificationTemplatesTable } from "@/components/admin/notifications/NotificationTemplatesTable";
import { useNotificationPoolFilters } from "@/components/admin/notifications/useNotificationPoolFilters";
import { SendBulkMessageDialog } from "@/components/admin/SendBulkMessageDialog";
import { SendManualMessageDialog } from "@/components/admin/SendManualMessageDialog";
import { TemplateEditorDialog } from "@/components/admin/TemplateEditorDialog";
import { BulkDeleteBar } from "@/components/admin/BulkDeleteBar";
import { LogRetentionCard } from "@/components/admin/LogRetentionCard";
import {
  DeleteConfirmation,
  LOG_PAGE_SIZE_OPTIONS,
  ModuleHeader,
  Pager,
  TableState,
} from "@/components/admin/Phase2Ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCronJobs } from "@/hooks/useCronJobs";
import {
  useDeleteNotificationTemplate,
  useNotificationTemplates,
  useUpdateNotificationTemplate,
} from "@/hooks/useNotificationTemplates";
import {
  useCancelNotification,
  useDeleteNotification,
  useNotifications,
  useRetryNotification,
} from "@/hooks/useNotifications";
import { usePermissions } from "@/hooks/usePermissions";
import { useProviderConfigs, useUpdateProviderConfig } from "@/hooks/useProviderConfigs";
import { useRunContractExpiry } from "@/hooks/useRunContractExpiry";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type { NotificationState, Tables } from "@/integrations/supabase/database.types";
import { resolveNotificationsPageAccess } from "@/lib/notificationsPageAccess";
import { PERMISSIONS } from "@/lib/permissions";

export const Route = createFileRoute("/admin/settings/notifications")({
  component: NotificationsPage,
});

/** الحجم الافتراضي لصفحة سجل الإشعارات — أصغر خيارات LOG_PAGE_SIZE_OPTIONS. */
const DEFAULT_PAGE_SIZE = 25;

/**
 * يختار نمط شارة الحالة. `needs_review` تُعامل معاملة الفشل بصرياً لأنها تتطلب
 * تدخلاً بشرياً، لا لأن الإرسال فشل — قد تكون الرسالة وصلت بالفعل.
 *
 * `needs_review` maps to the same destructive variant as a failure because both
 * demand attention, not because the send failed; `stateBadgeClass` then paints
 * it purple to keep the two visually distinct.
 */
function stateVariant(state: NotificationState) {
  if (state === "sent") return "default" as const;
  if (state === "failed" || state === "skipped" || state === "needs_review")
    return "destructive" as const;
  return "secondary" as const;
}

/**
 * يحدد ألوان شارة الحالة. البنفسجي لـ `needs_review` يميّزها عن الأحمر (فشل)
 * والبرتقالي (تخطٍّ) رغم أن الثلاثة تشترك في نفس النمط.
 */
function stateBadgeClass(state: NotificationState) {
  if (state === "queued") return "animate-pulse border-amber-200 bg-amber-50 text-amber-900";
  if (state === "sent") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (state === "failed") return "border-red-200 bg-red-50 text-red-900";
  if (state === "skipped") return "border-orange-200 bg-orange-50 text-orange-900";
  if (state === "needs_review") return "border-purple-200 bg-purple-50 text-purple-900";
  return "";
}

/**
 * صفحة إعدادات الإشعارات: السجل والقوالب والمزوّدين ومهام سير العمل.
 *
 * سجل الإشعارات عُرض كبطاقات على الجوال من واصف أعمدة واحد حتى لا تُفقد
 * حقول مثل `failure_reason` على الهاتف.
 */
function NotificationsPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const canReadNotifications = permissions.can(PERMISSIONS.NOTIFICATIONS_READ);
  const canReadReports = permissions.can(PERMISSIONS.REPORTS_READ);
  const canManageIntegrations = permissions.can(PERMISSIONS.SETTINGS_INTEGRATIONS);
  const canManageWorkflows = permissions.can(PERMISSIONS.WORKFLOWS_MANAGE);
  const pageAccess = resolveNotificationsPageAccess({
    canReadNotifications,
    canReadReports,
    canManageIntegrations,
    canManageWorkflows,
  });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const filters = useNotificationPoolFilters();
  const { search, type, channel, state, from, to, audience, recipient, sender } = filters;
  const debouncedSearch = useDebounce(search);
  const [manualOpen, setManualOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Tables<"notifications"> | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateTarget, setTemplateTarget] = useState<Tables<"notification_templates"> | null>(
    null,
  );
  const [templateDelete, setTemplateDelete] = useState<Tables<"notification_templates"> | null>(
    null,
  );
  const [templateSearch, setTemplateSearch] = useState("");
  const [providerDrafts, setProviderDrafts] = useState<Record<string, Record<string, string>>>({});
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // Memoised so the next-page prefetch in useNotifications sees a stable object
  // and does not re-run on every render of this large page.
  const notificationFilters = useMemo(
    () => ({
      page,
      pageSize,
      search: debouncedSearch,
      type: type === "all" ? undefined : type,
      channel: channel === "all" ? undefined : channel,
      state: state === "all" ? undefined : state,
      audience: audience === "all" ? undefined : audience,
      recipient: recipient || undefined,
      sender: sender || undefined,
      from: from || undefined,
      to: to || undefined,
    }),
    [page, pageSize, debouncedSearch, type, channel, state, audience, recipient, sender, from, to],
  );
  const notifications = useNotifications(notificationFilters, canReadNotifications);
  const templates = useNotificationTemplates(canReadNotifications || canManageWorkflows);
  const workflowJobs = useCronJobs(canReadNotifications || canManageWorkflows);
  const templatesByCode = useMemo(
    () => new Map((templates.data ?? []).map((row) => [row.code, row])),
    [templates.data],
  );
  const workflowNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const job of workflowJobs.data ?? []) {
      names.set(job.key, (locale === "ar" ? job.name_ar : job.name_en) || job.key);
    }
    return names;
  }, [locale, workflowJobs.data]);
  const providers = useProviderConfigs(canManageIntegrations);
  const retry = useRetryNotification();
  const cancel = useCancelNotification();
  const deleteNotification = useDeleteNotification();
  const canDelete = permissions.can(PERMISSIONS.NOTIFICATIONS_DELETE);
  const notificationItems = notifications.data?.items ?? [];
  // Selection is per page: clear it whenever the page or any filter changes so
  // a bulk delete can never act on rows the user can no longer see.
  useEffect(() => {
    setSelected([]);
  }, [notificationFilters]);
  const runExpiry = useRunContractExpiry();
  const updateTemplate = useUpdateNotificationTemplate();
  const deleteTemplate = useDeleteNotificationTemplate();
  const updateProvider = useUpdateProviderConfig();
  // The Resend card edits `companies.email_logo_url` alongside the provider row.
  const company = useCompany(canManageIntegrations);
  const updateCompany = useUpdateCompany();
  const filteredTemplates = useMemo(
    () =>
      (templates.data ?? []).filter((template) =>
        `${template.code} ${template.type}`.toLowerCase().includes(templateSearch.toLowerCase()),
      ),
    [templateSearch, templates.data],
  );

  // Page entry: notifications.read OR reports.read so relocating scheduled/
  // generated reports here does not lock out roles that only have reports.read.
  if (pageAccess.forbidden) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  const openTemplate = (template?: Tables<"notification_templates">) => {
    setTemplateTarget(template ?? null);
    setTemplateOpen(true);
  };

  return (
    <div className="space-y-6">
      <ModuleHeader
        title={t("notifications.logTitle")}
        subtitle={t("notifications.subtitle")}
        actions={
          canReadNotifications ? (
            <>
              <Button
                variant="outline"
                disabled={!permissions.can(PERMISSIONS.NOTIFICATIONS_CREATE) || runExpiry.isPending}
                onClick={async () => {
                  try {
                    await runExpiry.mutateAsync();
                    toast.success(t("notifications.runExpiryDone"));
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : t("common.error"));
                  }
                }}
              >
                <RefreshCw className="size-4" />
                {t("notifications.runExpiry")}
              </Button>
              <Button
                disabled={!permissions.can(PERMISSIONS.NOTIFICATIONS_SEND)}
                onClick={() => setManualOpen(true)}
              >
                <Plus className="size-4" />
                {t("notifications.sendManual")}
              </Button>
              <Button
                variant="outline"
                disabled={!permissions.can(PERMISSIONS.NOTIFICATIONS_SEND)}
                onClick={() => setBulkOpen(true)}
              >
                {t("notifications.sendBulk")}
              </Button>
            </>
          ) : undefined
        }
      />

      <Tabs defaultValue={pageAccess.defaultTab}>
        <TabsList>
          {canReadNotifications && (
            <TabsTrigger value="pool">
              {t("notifications.title")}
              <Badge variant="secondary" className="ms-2">
                {notifications.data?.count ?? 0}
              </Badge>
            </TabsTrigger>
          )}
          {canReadNotifications && (
            <TabsTrigger value="templates">
              {t("templates.title")}
              <Badge variant="secondary" className="ms-2">
                {filteredTemplates.length}
              </Badge>
            </TabsTrigger>
          )}
          {canManageIntegrations && (
            <TabsTrigger value="providers">{t("providers.title")}</TabsTrigger>
          )}
          {/* workflows.manage for WorkflowsPanel; REPORTS_READ so schedule/generated
              access is not narrowed when those sections moved here from /admin/reports. */}
          {(canManageWorkflows || canReadReports) && (
            <TabsTrigger value="jobs">{t("workflows.title")}</TabsTrigger>
          )}
        </TabsList>
        {canReadNotifications && (
          <TabsContent value="pool" className="space-y-4">
            <LogRetentionCard log="notifications" canManage={canDelete} />
            <Card className="overflow-hidden">
              <CardHeader className="space-y-0 border-b p-3">
                <NotificationPoolFilters
                  filters={filters}
                  setPage={setPage}
                  notifications={notifications}
                  canExport={permissions.can(PERMISSIONS.NOTIFICATIONS_EXPORT)}
                />
              </CardHeader>
              <CardContent className="p-0">
                {canDelete && selected.length > 0 && (
                  <div className="px-4 pb-2">
                    <BulkDeleteBar
                      selected={selected}
                      clear={() => setSelected([])}
                      deleteOne={(id) => {
                        const item = notificationItems.find((n) => n.id === id);
                        return item
                          ? deleteNotification.mutateAsync(item).then(() => undefined)
                          : Promise.resolve();
                      }}
                      entityLabel={t("notifications.title")}
                    />
                  </div>
                )}
                <TableState
                  loading={notifications.isLoading}
                  error={notifications.isError}
                  empty={!notifications.data?.items.length}
                >
                  <NotificationLogTable
                    canDelete={canDelete}
                    selected={selected}
                    setSelected={setSelected}
                    page={page}
                    pageSize={pageSize}
                    items={notifications.data?.items ?? []}
                    retryPending={retry.isPending}
                    onRetry={(item, handlers) => retry.mutate(item, handlers)}
                    onCancel={setCancelTarget}
                    stateVariant={stateVariant}
                    stateBadgeClass={stateBadgeClass}
                  />
                </TableState>
                <Pager
                  page={page}
                  pageSize={pageSize}
                  count={notifications.data?.count ?? 0}
                  setPage={setPage}
                  setPageSize={setPageSize}
                  pageSizeOptions={LOG_PAGE_SIZE_OPTIONS}
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {canReadNotifications && (
          <TabsContent value="templates">
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-3">
                <Input
                  className="max-w-sm"
                  value={templateSearch}
                  onChange={(event) => {
                    setTemplateSearch(event.target.value);
                  }}
                  placeholder={t("common.search")}
                />
                <Button
                  disabled={!permissions.can(PERMISSIONS.NOTIFICATIONS_CREATE)}
                  onClick={() => openTemplate()}
                >
                  <Plus className="size-4" />
                  {t("templates.editor")}
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <TableState
                  loading={templates.isLoading}
                  error={templates.isError}
                  empty={!filteredTemplates.length}
                >
                  <NotificationTemplatesTable
                    templates={filteredTemplates}
                    onEdit={openTemplate}
                    onDelete={setTemplateDelete}
                    workflowNames={workflowNames}
                  />
                </TableState>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {canManageIntegrations && (
          <TabsContent value="providers">
            {/* Grouped by the channel each provider actually delivers on, because
              that is the choice an admin is making: email goes out through
              exactly one of Resend or SMTP, WhatsApp through exactly one of the
              three below it. A single flat list of five cards hid that the
              enable switches are exclusive within a channel. */}
            <NotificationProvidersTab
              providers={providers}
              company={company}
              updateProvider={updateProvider}
              updateCompany={updateCompany}
              providerDrafts={providerDrafts}
              setProviderDrafts={setProviderDrafts}
            />
          </TabsContent>
        )}

        {/* The Workflows screen, reused rather than reimplemented. It keeps its
            own workflows.manage check, so it is safe even though the trigger above is
            already gated. The `value` stays "jobs": renaming it would silently
            reset any user whose browser remembers the old tab.

            Scheduled + generated reports also live here (relocated from
            /admin/reports). They gate on REPORTS_READ independently of admin. */}
        <TabsContent value="jobs" className="space-y-6">
          {canManageWorkflows ? (
            <WorkflowsPanel
              templatesByCode={templatesByCode}
              onEditTemplate={
                permissions.can(PERMISSIONS.NOTIFICATIONS_UPDATE) ? openTemplate : undefined
              }
            />
          ) : null}
          <ScheduledAndGeneratedReports />
        </TabsContent>
      </Tabs>

      <SendManualMessageDialog open={manualOpen} onOpenChange={setManualOpen} />
      <SendBulkMessageDialog open={bulkOpen} onOpenChange={setBulkOpen} />

      <TemplateEditorDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        template={templateTarget}
      />

      <DeleteConfirmation
        open={Boolean(cancelTarget)}
        pending={cancel.isPending}
        title={t("notifications.cancel")}
        description={t("notifications.cancelConfirm")}
        close={() => setCancelTarget(null)}
        confirm={async () => {
          if (!cancelTarget) return;
          try {
            await cancel.mutateAsync(cancelTarget);
            setCancelTarget(null);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
      <DeleteConfirmation
        open={Boolean(templateDelete)}
        pending={deleteTemplate.isPending}
        title={t("common.delete")}
        description={t("templates.deleteConfirm")}
        close={() => setTemplateDelete(null)}
        confirm={async () => {
          if (!templateDelete) return;
          try {
            await deleteTemplate.mutateAsync(templateDelete.id);
            setTemplateDelete(null);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
    </div>
  );
}
