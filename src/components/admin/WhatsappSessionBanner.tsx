import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePermissions } from "@/hooks/usePermissions";
import { useWhatsappSessionHealth } from "@/hooks/useWhatsappSessionHealth";
import { useI18n } from "@/i18n/provider";
import { PERMISSIONS } from "@/lib/permissions";
import { whatsappSessionBannerState } from "@/lib/whatsappSessionBanner";

/**
 * شريط تحذير دائم في غلاف الإدارة عند تعذّر إرسال واتساب عبر جلسة QR.
 *
 * Non-dismissible and visible to every staff role (even roles without
 * `settings.integrations` that cannot read the `whatsapp_connections` row),
 * directing integrators to reconnect and collectors/accountants to notify admin.
 */
export function WhatsappSessionBanner() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const health = useWhatsappSessionHealth();

  const snapshot = health.isError ? null : health.data;
  const bannerState = whatsappSessionBannerState(snapshot);
  if (bannerState === "hidden" || !snapshot) return null;

  const canReconnect = permissions.can(PERMISSIONS.SETTINGS_INTEGRATIONS);
  const canViewParked = permissions.can(PERMISSIONS.NOTIFICATIONS_READ);
  const parkedCount = snapshot.parked_count;

  const headline =
    bannerState === "never_paired"
      ? t("admin.whatsappBanner.neverPaired")
      : t("admin.whatsappBanner.disconnected");

  return (
    <Alert
      role="status"
      className="rounded-none border-x-0 border-t-0 border-b border-amber-500/40 bg-amber-50/90 px-4 py-2.5 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/35 dark:text-amber-100 sm:px-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
            aria-hidden="true"
          />
          <AlertDescription className="min-w-0 space-y-0.5 text-xs leading-relaxed sm:text-sm">
            <p className="font-medium">{headline}</p>
            {parkedCount > 0 ? (
              <p className="text-amber-900/90 dark:text-amber-200/90">
                {t("admin.whatsappBanner.parked").replace("{count}", String(parkedCount))}
              </p>
            ) : null}
          </AlertDescription>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canReconnect ? (
            <Link
              to="/admin/settings/integrations"
              className="inline-flex min-h-8 items-center justify-center rounded-md border border-amber-700/30 bg-amber-100 px-3 py-1 text-xs font-medium text-amber-950 transition-colors hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-400/30 dark:bg-amber-900/60 dark:text-amber-100 dark:hover:bg-amber-900"
            >
              {t("admin.whatsappBanner.reconnect")}
            </Link>
          ) : (
            <span className="text-xs font-medium text-amber-900 dark:text-amber-200">
              {t("admin.whatsappBanner.askAdmin")}
            </span>
          )}

          {parkedCount > 0 && canViewParked ? (
            <Link
              to="/admin/settings/notifications"
              className="inline-flex min-h-8 items-center justify-center rounded-md border border-amber-700/25 bg-background/80 px-3 py-1 text-xs font-medium text-amber-950 transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-400/25 dark:bg-amber-950/50 dark:text-amber-100 dark:hover:bg-amber-950"
            >
              {t("admin.whatsappBanner.viewParked")}
            </Link>
          ) : null}
        </div>
      </div>
    </Alert>
  );
}
