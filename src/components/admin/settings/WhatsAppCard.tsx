import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Link2Off, MessageCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { WhatsAppSyncButtons } from "@/components/admin/settings/WhatsAppSyncButtons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LtrText } from "@/components/ui/ltr-text";
import {
  whatsappActivate,
  whatsappDisconnect,
  whatsappStartQr,
  whatsappStatus,
  type WhatsappConnectionSummary,
} from "@/fns/whatsappSettings";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import type {
  WhatsappConnectionMethod,
  WhatsappConnectionStatus,
} from "@/integrations/supabase/database.types";
import { describeError } from "@/lib/toastError";

/*
 * بطاقة إعدادات ربط واتساب للشركة: تعرض الحالة النشطة، رمز QR أثناء الاقتران
 * مع استطلاع دوري، وتبديل الطريقة النشطة أو فصل الاتصال.
 *
 * QR images carry `ph-no-capture` so PostHog session replay never records a
 * live pairing credential (enforced by `replayBlocksQrCodes.structure.test.ts`).
 */

const WHATSAPP_STATUS_QUERY_KEY = ["whatsapp-settings-status"] as const;
const PAIRING_POLL_INTERVAL_MS = 2_000;

interface WhatsAppCardProps {
  enabled: boolean;
  dateFormatter: Intl.DateTimeFormat;
}

/**
 * يقرأ ترويسة التفويض من جلسة Supabase الحالية لتمريرها إلى دوال الخادم.
 */
async function sessionHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Authentication required.");
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * يعيد لون الشارة المناسب لحالة اتصال واتساب.
 */
function statusBadgeVariant(
  status: WhatsappConnectionStatus | undefined,
): "secondary" | "destructive" | "outline" {
  if (status === "connected") return "secondary";
  if (status === "error") return "destructive";
  return "outline";
}

/**
 * بطاقة إدارة اتصال واتساب للشركة في صفحة التكاملات.
 */
export function WhatsAppCard({ enabled, dateFormatter }: WhatsAppCardProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: WHATSAPP_STATUS_QUERY_KEY,
    enabled,
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data?.active?.status === "pairing" ? PAIRING_POLL_INTERVAL_MS : false,
    queryFn: async () => {
      const headers = await sessionHeaders();
      return whatsappStatus({ headers });
    },
  });

  const startQr = useMutation({
    mutationFn: async () => {
      const headers = await sessionHeaders();
      return whatsappStartQr({ headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WHATSAPP_STATUS_QUERY_KEY });
    },
  });

  const disconnect = useMutation({
    mutationFn: async (method?: WhatsappConnectionMethod) => {
      const headers = await sessionHeaders();
      return whatsappDisconnect({ data: { method }, headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WHATSAPP_STATUS_QUERY_KEY });
    },
  });

  const activate = useMutation({
    mutationFn: async (method: WhatsappConnectionMethod) => {
      const headers = await sessionHeaders();
      return whatsappActivate({ data: { method }, headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WHATSAPP_STATUS_QUERY_KEY });
    },
  });

  const active: WhatsappConnectionSummary | null = statusQuery.data?.active ?? null;
  const connections = statusQuery.data?.connections ?? [];
  const isPairing = active?.status === "pairing";
  const isConnected = active?.status === "connected";
  const busy = startQr.isPending || disconnect.isPending || activate.isPending;

  /**
   * يبدأ جلسة اقتران QR جديدة أو يحدّث الرمز المعروض.
   */
  async function onStartQr() {
    try {
      await startQr.mutateAsync();
    } catch (error) {
      toast.error(describeError(error) ?? t("common.error"));
    }
  }

  /**
   * يفصل اتصال واتساب النشط مع تنبيه صريح إن تعذّر تسجيل الخروج عن بُعد.
   */
  async function onDisconnect() {
    try {
      const result = await disconnect.mutateAsync(active?.method);
      if (result.disconnected) {
        toast.success(t("whatsappSettings.disconnectedToast"));
      } else {
        toast.error(t("whatsappSettings.disconnectFailedToast"));
      }
    } catch (error) {
      toast.error(describeError(error) ?? t("common.error"));
    }
  }

  /**
   * يبدّل الطريقة النشطة لواتساب إلى إحدى الطرق المهيّأة.
   */
  async function onActivate(method: WhatsappConnectionMethod) {
    try {
      await activate.mutateAsync(method);
      toast.success(t("whatsappSettings.activatedToast"));
    } catch (error) {
      toast.error(describeError(error) ?? t("common.error"));
    }
  }

  const badgeStatus = active?.status ?? "disconnected";

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="size-4" />
            {t("whatsappSettings.title")}
          </CardTitle>
          <CardDescription>{t("whatsappSettings.description")}</CardDescription>
        </div>
        <Badge variant={statusBadgeVariant(active?.status)}>
          {t(`whatsappSettings.status.${badgeStatus}`)}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4">
        {statusQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : isPairing && active?.lastQr ? (
          <div className="flex flex-col items-center gap-3 rounded-md border p-4">
            <p className="text-sm text-muted-foreground">{t("whatsappSettings.scanHint")}</p>
            <img
              src={
                active.lastQr.startsWith("data:image/")
                  ? active.lastQr
                  : `data:image/png;base64,${active.lastQr}`
              }
              alt={t("whatsappSettings.title")}
              className="ph-no-capture size-56 rounded-md border bg-white p-2"
            />
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void onStartQr()}>
              <RefreshCw className={`size-4 ${startQr.isPending ? "animate-spin" : ""}`} />
              {t("whatsappSettings.refreshQr")}
            </Button>
          </div>
        ) : isConnected && active ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("whatsappSettings.connectedNumber")}</dt>
              <LtrText as="dd" className="font-medium">
                {active.connectedNumber ? `+${active.connectedNumber}` : "—"}
              </LtrText>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("whatsappSettings.lastSeenAt")}</dt>
              <dd>
                {active.lastSeenAt
                  ? dateFormatter.format(new Date(active.lastSeenAt))
                  : t("whatsappSettings.never")}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t("whatsappSettings.notConnectedHelp")}</p>
        )}

        {active?.lastError ? <p className="text-sm text-destructive">{active.lastError}</p> : null}

        <div className="flex flex-wrap gap-2">
          {isConnected && active?.method === "evolution_qr" ? <WhatsAppSyncButtons /> : null}
          {isConnected || isPairing ? (
            <Button variant="outline" disabled={busy} onClick={() => void onDisconnect()}>
              <Link2Off className="size-4" />
              {t("whatsappSettings.disconnect")}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void onStartQr()}>
              <Link2 className="size-4" />
              {t("whatsappSettings.startQr")}
            </Button>
          )}
        </div>

        {connections.length > 1 ? (
          <div className="space-y-2 border-t pt-4">
            <p className="text-xs font-medium text-muted-foreground">
              {t("whatsappSettings.configuredMethods")}
            </p>
            <div className="flex flex-wrap gap-2">
              {connections.map((conn) => (
                <Button
                  key={conn.id}
                  type="button"
                  size="sm"
                  variant={conn.isActive ? "secondary" : "outline"}
                  disabled={busy || conn.isActive}
                  onClick={() => void onActivate(conn.method)}
                >
                  {t(`whatsappSettings.method.${conn.method}`)}
                  {conn.isActive ? ` (${t("whatsappSettings.activeMethod")})` : ""}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
