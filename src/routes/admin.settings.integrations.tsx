import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Link2, Link2Off, Mail, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { ModuleHeader } from "@/components/admin/Phase2Ui";
import { EvolutionConnectionCard } from "@/components/admin/whatsapp/EvolutionConnectionCard";
import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import {
  useConnectGmail,
  useDisconnectGmail,
  useGmailConnection,
  useRunGmailSync,
} from "@/hooks/useGmailConnection";
import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";
import { useI18n } from "@/i18n/provider";

/**
 * `?gmail=<status>` is set by the OAuth callback, which cannot render anything
 * itself — it is a redirect target for Google, so the only channel it has back
 * to the admin is the URL.
 */
export const Route = createFileRoute("/admin/settings/integrations")({
  validateSearch: (search: Record<string, unknown>): { gmail?: string } =>
    typeof search.gmail === "string" ? { gmail: search.gmail } : {},
  component: IntegrationsPage,
});

function IntegrationsPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const canManage = permissions.can(PERMISSIONS.SETTINGS_INTEGRATIONS);
  // "Sync now" dispatches the gmail-sync workflow, whose run permission is
  // notifications.read (workflowCatalog), not the integrations grant.
  const canSyncGmail = permissions.can(PERMISSIONS.NOTIFICATIONS_READ);
  const { gmail: callbackStatus } = Route.useSearch();
  const navigate = Route.useNavigate();

  const connection = useGmailConnection(!permissions.isLoading && canManage);
  const connect = useConnectGmail();
  const disconnect = useDisconnectGmail();
  const runGmailSync = useRunGmailSync();

  useEffect(() => {
    if (!callbackStatus) return;
    if (callbackStatus === "connected") toast.success(t("settings.integrations.connected"));
    else toast.error(`${t("settings.integrations.connectFailed")} (${callbackStatus})`);
    // Clear the flag so a refresh does not re-toast.
    navigate({ search: {}, replace: true });
  }, [callbackStatus, navigate, t]);

  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!canManage) {
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  }

  const dateFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const status = connection.data;

  async function onConnect() {
    try {
      await connect.mutateAsync();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  async function onDisconnect() {
    try {
      await disconnect.mutateAsync();
      toast.success(t("settings.integrations.disconnected"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  async function onSyncNow() {
    try {
      const result = await runGmailSync.mutateAsync();
      if (result.skipped) toast.message(t("inbox.gmailSyncSkipped"));
      else toast.success(t("inbox.gmailSyncDone"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader
        title={t("settings.integrations")}
        subtitle={t("settings.integrations.subtitle")}
      />

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="size-4" />
              {t("settings.integrations.gmail")}
            </CardTitle>
            <CardDescription>{t("settings.integrations.gmailDescription")}</CardDescription>
          </div>
          {status ? (
            <Badge variant="secondary">{t("settings.integrations.statusConnected")}</Badge>
          ) : (
            <Badge variant="outline">{t("settings.integrations.statusDisconnected")}</Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {connection.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : status ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("settings.integrations.mailbox")}</dt>
                <LtrText as="dd" className="font-medium">
                  {status.email_address}
                </LtrText>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("settings.integrations.connectedAt")}</dt>
                <dd>{dateFormatter.format(new Date(status.connected_at))}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("settings.integrations.lastSync")}</dt>
                <dd>
                  {status.last_synced_at
                    ? dateFormatter.format(new Date(status.last_synced_at))
                    : t("settings.integrations.never")}
                </dd>
              </div>
              {status.last_sync_error ? (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">
                    {t("settings.integrations.lastSyncError")}
                  </dt>
                  <dd className="text-destructive">{status.last_sync_error}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("settings.integrations.notConnectedHelp")}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {status ? (
              <>
                {canSyncGmail && (
                  <Button variant="outline" disabled={runGmailSync.isPending} onClick={onSyncNow}>
                    <RefreshCw
                      className={`size-4 ${runGmailSync.isPending ? "animate-spin" : ""}`}
                    />
                    {t("inbox.gmailSync")}
                  </Button>
                )}
                <Button variant="outline" disabled={disconnect.isPending} onClick={onDisconnect}>
                  <Link2Off className="size-4" />
                  {t("settings.integrations.disconnect")}
                </Button>
              </>
            ) : (
              <Button disabled={connect.isPending} onClick={onConnect}>
                <Link2 className="size-4" />
                {t("settings.integrations.connect")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <EvolutionConnectionCard
        enabled={!permissions.isLoading && canManage}
        dateFormatter={dateFormatter}
      />
    </div>
  );
}
