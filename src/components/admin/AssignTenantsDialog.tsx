import { useEffect, useState } from "react";
import { toast } from "sonner";

import { TenantMultiSelect } from "@/components/admin/TenantMultiSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSetUserTenants } from "@/hooks/useUserTenants";
import { useI18n } from "@/i18n/provider";
import { shouldSendTenantIds } from "@/lib/tenantAssignments";

export interface AssignTenantsTarget {
  id: string;
  label: string;
  /**
   * Current `user_tenants` links for this user, or `undefined` when
   * `useUserTenants` has not resolved yet — loading, or errored. `undefined`
   * must never be laundered into `[]` at the call site: this dialog sends
   * `tenantIds` to the server as an instruction to replace the user's links
   * wholesale, so treating "we don't know yet" as "there are none" would
   * delete real links on save. See EditUserDialog's identical
   * `assignedTenantIds` prop for the established shape.
   */
  tenantIds: string[] | undefined;
}

/**
 * Links a managerial account to any number of tenants.
 *
 * The link is a portal convenience switcher, not a data-scoping rule: it lets
 * the user open those tenants' portals with their own password, while what
 * they may read stays governed by has_permission.
 */
export function AssignTenantsDialog({
  target,
  close,
}: {
  target: AssignTenantsTarget | null;
  close: () => void;
}) {
  const { t } = useI18n();
  const setUserTenants = useSetUserTenants();
  const [selected, setSelected] = useState<string[]>([]);

  const assignmentsLoaded = target?.tenantIds !== undefined;

  useEffect(() => setSelected(target?.tenantIds ?? []), [target]);

  async function submit() {
    if (!target || target.tenantIds === undefined) return;
    // Only send tenantIds when the selection is both known and actually
    // different from what loaded — an unchanged selection must not churn
    // user_tenants rows (new ids, created_by reassigned) on every save.
    if (!shouldSendTenantIds(selected, target.tenantIds)) {
      close();
      return;
    }
    try {
      await setUserTenants.mutateAsync({ userId: target.id, tenantIds: selected });
      toast.success(t("users.assignTenantsSaved"));
      close();
    } catch (error) {
      toast.error(t("users.actionError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>{t("users.assignTenants")}</DialogTitle>
          <DialogDescription>{target?.label}</DialogDescription>
        </DialogHeader>

        {assignmentsLoaded ? (
          <>
            <p className="text-xs text-muted-foreground">{t("users.assignTenantsHint")}</p>
            <TenantMultiSelect
              selected={selected}
              onChange={setSelected}
              enabled={Boolean(target)}
            />
          </>
        ) : (
          <p className="text-xs text-destructive">{t("users.assignmentsUnknown")}</p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={setUserTenants.isPending || !assignmentsLoaded}
            onClick={submit}
          >
            {setUserTenants.isPending ? t("common.loading") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
