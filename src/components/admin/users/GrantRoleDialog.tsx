import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type UserWithRoles } from "@/hooks/useUsers";
import { useI18n } from "@/i18n/provider";
import type { AppRole } from "@/integrations/supabase/database.types";
import { isContractEnded } from "@/lib/tenantDisplayName";

/**
 * حوار منح دور لمستخدم، مع اختيار المستأجر عند منح دور المستأجر.
 */
export function GrantRoleDialog({
  user,
  selectedRole,
  availableRoles,
  pending,
  close,
  selectRole,
  grantSelectedRole,
  grantTenantId,
  selectGrantTenant,
  tenantOptions,
}: {
  user: UserWithRoles | null;
  selectedRole: AppRole | "";
  availableRoles: AppRole[];
  pending: boolean;
  close: () => void;
  selectRole: (role: AppRole) => void;
  grantSelectedRole: () => Promise<void>;
  grantTenantId: string;
  selectGrantTenant: (tenantId: string) => void;
  tenantOptions: { id: string; name: string; code: string | null; lifecycle: string }[];
}) {
  const { t } = useI18n();
  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("users.grantRole")}</DialogTitle>
          <DialogDescription>{user?.display_name ?? user?.username}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label>{t("users.roles")}</Label>
            <Select value={selectedRole} onValueChange={(role) => selectRole(role as AppRole)}>
              <SelectTrigger>
                <SelectValue placeholder={t("common.select")} />
              </SelectTrigger>
              <SelectContent>
                {availableRoles.map((role) => (
                  <SelectItem key={role} value={role}>
                    {t(`roles.${role}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Granting portal access needs the tenant whose data the user will see.
              The account keeps its existing credentials — only the link is added. */}
          {selectedRole === "tenant" && (
            <div className="grid gap-1.5">
              <Label>{t("users.tenantToLink")}</Label>
              <Select value={grantTenantId} onValueChange={selectGrantTenant}>
                <SelectTrigger>
                  <SelectValue placeholder={t("users.pickTenant")} />
                </SelectTrigger>
                <SelectContent>
                  {tenantOptions.map((tenant, index) => (
                    <SelectItem key={tenant.id} value={tenant.id}>
                      <TenantOptionLabel index={index} ended={isContractEnded(tenant)}>
                        {tenant.name}
                        {tenant.code ? ` — ${tenant.code}` : ""}
                      </TenantOptionLabel>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("users.tenantToLinkHint")}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!selectedRole || pending || (selectedRole === "tenant" && !grantTenantId)}
            onClick={grantSelectedRole}
          >
            {pending ? t("common.loading") : t("users.grantRole")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
