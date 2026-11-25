import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/i18n/provider";
import { type RevokeTarget } from "@/components/admin/users/userRoles";

/**
 * حوار تأكيد سحب دور من مستخدم، مع التحذير من روابط المستأجرين التي ستُزال.
 */
export function RevokeRoleDialog({
  target,
  pending,
  close,
  revokeSelectedRole,
}: {
  target: RevokeTarget | null;
  pending: boolean;
  close: () => void;
  revokeSelectedRole: () => Promise<void>;
}) {
  const { t } = useI18n();
  // Only the tenant role carries links, so only it gets the extra warning.
  const showsTenantWarning =
    target?.role === "tenant" && (target.hasPortalLink || target.assignedCount > 0);
  return (
    <AlertDialog open={Boolean(target)} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("users.revokeTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("users.revokeDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        {showsTenantWarning && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            {t("users.revokeTenantWarning").replace("{count}", String(target!.assignedCount))}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={revokeSelectedRole}>
            {pending ? t("common.loading") : t("users.revoke")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
