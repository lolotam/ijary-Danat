import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { GatewayProvider } from "@/gateways/types";
import { useI18n } from "@/i18n/provider";
import type { GatewayLaunchStatus } from "@/platform/gateways";
import { fetchPlatformGatewayLaunch, setPlatformGatewayLiveAllowed } from "@/platform/gatewaysFns";

/** يعيد عدد الشركات العاملة في الوضع الفعلي لمزوّد ما، أو صفراً إن لم يُعرف. */
function liveCountOf(
  rows: readonly GatewayLaunchStatus[],
  provider: GatewayProvider | undefined,
): number {
  return rows.find((row) => row.provider === provider)?.live_connections ?? 0;
}

interface PendingToggle {
  provider: GatewayProvider;
  nextAllowed: boolean;
}

/**
 * لوحة مفاتيح السماح بالوضع الفعلي لبوابات الدفع على مستوى المنصة (SC-012).
 *
 * Each provider switch requires confirmation naming SC-012 (all sandbox cases
 * verified first) before calling the platform server function.
 */
export function GatewayLaunchPanel() {
  const { t } = useI18n();
  const [rows, setRows] = useState<GatewayLaunchStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingToggle | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchPlatformGatewayLaunch()
      .then((loaded) => {
        if (!mounted) return;
        setRows(loaded);
        setLoadError(null);
      })
      .catch(() => {
        if (mounted) setLoadError(t("platformGateways.loadError"));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [t]);

  /** يفتح حوار التأكيد المرجعي لمعيار SC-012 عند نقر مفتاح المزوّد. */
  function requestToggle(provider: GatewayProvider, nextAllowed: boolean) {
    setSaveError(null);
    setSaved(false);
    setPending({ provider, nextAllowed });
  }

  /** ينفّذ تغيير حالة الإطلاق بعد تأكيد المشرف العام. */
  async function handleConfirm() {
    if (!pending) return;
    setBusy(true);
    setSaveError(null);
    try {
      const updated = await setPlatformGatewayLiveAllowed({
        provider: pending.provider,
        allowed: pending.nextAllowed,
      });
      setRows((current) =>
        current.map((row) =>
          row.provider === updated.provider
            ? { ...updated, live_connections: row.live_connections }
            : row,
        ),
      );
      setSaved(true);
      setPending(null);
    } catch {
      setSaveError(t("platformGateways.saveError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("platformGateways.panelTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("platformGateways.panelDescription")}</p>
      </div>

      {loadError ? (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : null}

      {loading ? <p className="text-sm text-muted-foreground">{t("common.loading")}</p> : null}

      {!loading && !loadError ? (
        <div className="space-y-3">
          {rows.map((row) => (
            <div
              key={row.provider}
              className="flex items-center justify-between gap-4 rounded-lg border p-3"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Label htmlFor={`platform-gateway-${row.provider}`}>
                    {t(`platformGateways.provider.${row.provider}`)}
                  </Label>
                  <Badge variant={row.live_allowed ? "default" : "secondary"}>
                    {row.live_allowed
                      ? t("platformGateways.status.allowed")
                      : t("platformGateways.status.blocked")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("platformGateways.liveConnections").replace(
                    "{count}",
                    String(row.live_connections),
                  )}
                </p>
                {row.checklist_note ? (
                  <p className="text-xs text-muted-foreground">{row.checklist_note}</p>
                ) : null}
              </div>
              <Switch
                id={`platform-gateway-${row.provider}`}
                aria-label={`${t("platformGateways.switchAria")} ${t(`platformGateways.provider.${row.provider}`)}`}
                checked={row.live_allowed}
                disabled={busy}
                onCheckedChange={(checked) => requestToggle(row.provider, checked)}
              />
            </div>
          ))}
        </div>
      ) : null}

      {saveError ? (
        <p className="text-sm text-destructive" role="alert">
          {saveError}
        </p>
      ) : null}

      {saved ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("platformGateways.saved")}
        </p>
      ) : null}

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.nextAllowed
                ? t("platformGateways.confirmTitleEnable")
                : t("platformGateways.confirmTitleDisable")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.nextAllowed
                ? t("platformGateways.confirmBodyEnable")
                : t("platformGateways.confirmBodyDisable").replace(
                    "{count}",
                    String(liveCountOf(rows, pending?.provider)),
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" disabled={busy}>
                {t("common.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button type="button" onClick={() => void handleConfirm()} disabled={busy}>
              {busy ? t("common.loading") : t("platformGateways.confirmAction")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
