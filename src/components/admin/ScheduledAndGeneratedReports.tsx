import { GeneratedReportsPanel } from "@/components/admin/reports/GeneratedReportsPanel";
import { ScheduledReportsPanel } from "@/components/admin/reports/ScheduledReportsPanel";
import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * إدارة التقارير المجدولة والمولَّدة تحت الإعدادات ← الإشعارات ← سير العمل.
 *
 * Two independent panels with nothing shared but the read permission, which is
 * checked here once: neither panel mounts — so neither fires its query — for a
 * user who cannot read reports. Each panel owns its own search, paging, dialogs
 * and delete confirmation (audit M27).
 */
export function ScheduledAndGeneratedReports() {
  const permissions = usePermissions();
  if (!permissions.can(PERMISSIONS.REPORTS_READ)) return null;

  return (
    <>
      <ScheduledReportsPanel />
      <GeneratedReportsPanel />
    </>
  );
}
