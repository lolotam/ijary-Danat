import { useState } from "react";
import { History, ImageDown, Link2, Link2Off, MessageCircle } from "lucide-react";
import { toast } from "sonner";

import { EvolutionQrDialog } from "@/components/admin/whatsapp/EvolutionQrDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LtrText } from "@/components/ui/ltr-text";
import {
  useBeginEvolutionSession,
  useDisconnectEvolutionSession,
  useEvolutionConnection,
  useRunEvolutionHistorySync,
  useSyncEvolutionAvatars,
} from "@/hooks/useEvolutionConnection";
import { useI18n } from "@/i18n/provider";

interface EvolutionConnectionCardProps {
  enabled: boolean;
  dateFormatter: Intl.DateTimeFormat;
}

/**
 * بطاقة اقتران واتساب عبر Evolution API في صفحة التكاملات.
 *
 * Mirrors the Gmail card anatomy on the same page. "Connected" is the session
 * state being open — a row can exist while logged out, which must read as
 * disconnected, and `disconnect_failed` gets its own badge because the remote
 * side may still be paired (evolutionSession.ts explains why we never lie
 * about that).
 */
export function EvolutionConnectionCard({ enabled, dateFormatter }: EvolutionConnectionCardProps) {
  const { t } = useI18n();
  const connection = useEvolutionConnection(enabled);
  const begin = useBeginEvolutionSession();
  const disconnect = useDisconnectEvolutionSession();
  const historySync = useRunEvolutionHistorySync();
  const avatarSync = useSyncEvolutionAvatars();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [initialQr, setInitialQr] = useState<string | null>(null);

  const status = connection.data;
  const isConnected = status?.last_connection_state === "open";
  const disconnectFailed = status?.last_connection_state === "disconnect_failed";

  async function onConnect() {
    try {
      const result = await begin.mutateAsync();
      setInitialQr(result.qr);
      setDialogOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  async function onDisconnect() {
    try {
      const result = await disconnect.mutateAsync();
      if (result.disconnected) toast.success(t("settings.integrations.evolutionDisconnected"));
      else toast.error(t("settings.integrations.evolutionDisconnectFailed"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  async function onHistorySync() {
    try {
      await historySync.mutateAsync();
      toast.success(t("settings.integrations.evolutionSyncQueued"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  /**
   * يحجز مزامنة الصور في العامل ويؤكد ذلك للمستخدم.
   *
   * The sweep runs in the background now (`whatsapp.avatars.sync`): the click
   * queues the job and the worker walks the whole directory, so there is no
   * per-click cursor to carry any more.
   */
  async function onAvatarSync() {
    try {
      await avatarSync.mutateAsync();
      toast.success(t("settings.integrations.evolutionSyncQueued"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  function onDialogChange(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setInitialQr(null);
      void connection.refetch();
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="size-4" />
            {t("settings.integrations.evolution")}
          </CardTitle>
          <CardDescription>{t("settings.integrations.evolutionDescription")}</CardDescription>
        </div>
        {isConnected ? (
          <Badge variant="secondary">{t("settings.integrations.statusConnected")}</Badge>
        ) : disconnectFailed ? (
          <Badge variant="destructive">
            {t("settings.integrations.evolutionDisconnectFailed")}
          </Badge>
        ) : (
          <Badge variant="outline">{t("settings.integrations.statusDisconnected")}</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {connection.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : isConnected && status ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">
                {t("settings.integrations.evolutionNumber")}
              </dt>
              <LtrText as="dd" className="font-medium">
                {status.connected_number ? `+${status.connected_number}` : "—"}
              </LtrText>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("settings.integrations.connectedAt")}</dt>
              <dd>
                {status.connected_at
                  ? dateFormatter.format(new Date(status.connected_at))
                  : t("settings.integrations.never")}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("settings.integrations.evolutionNotConnectedHelp")}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {isConnected ? (
            <>
              <Button variant="outline" disabled={historySync.isPending} onClick={onHistorySync}>
                <History className={`size-4 ${historySync.isPending ? "animate-pulse" : ""}`} />
                {t("settings.integrations.evolutionSyncHistory")}
              </Button>
              <Button variant="outline" disabled={avatarSync.isPending} onClick={onAvatarSync}>
                <ImageDown className={`size-4 ${avatarSync.isPending ? "animate-pulse" : ""}`} />
                {t("settings.integrations.evolutionSyncAvatars")}
              </Button>
              <Button variant="outline" disabled={disconnect.isPending} onClick={onDisconnect}>
                <Link2Off className="size-4" />
                {t("settings.integrations.disconnect")}
              </Button>
            </>
          ) : (
            <Button disabled={begin.isPending} onClick={onConnect}>
              <Link2 className="size-4" />
              {t("settings.integrations.evolutionConnect")}
            </Button>
          )}
        </div>
      </CardContent>

      <EvolutionQrDialog open={dialogOpen} onOpenChange={onDialogChange} initialQr={initialQr} />
    </Card>
  );
}
