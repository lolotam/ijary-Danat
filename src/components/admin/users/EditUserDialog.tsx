import { useEffect, useMemo, useState } from "react";

import { KeyRound, Pencil } from "lucide-react";
import type { useServerFn } from "@tanstack/react-start";
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
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type UserWithRoles } from "@/hooks/useUsers";
import { useUserTenants } from "@/hooks/useUserTenants";
import { useI18n } from "@/i18n/provider";
import type { AppRole } from "@/integrations/supabase/database.types";
import { updateAppUser } from "@/fns/updateAppUser";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { describeUserError } from "@/lib/userConflicts";
import { shouldSendTenantIds } from "@/lib/tenantAssignments";
import { MANAGERIAL_ROLES } from "@/components/admin/users/userRoles";

/**
 * حوار تعديل حساب قائم: البيانات، الدور الإداري، وربط المستأجرين.
 *
 * Edits an existing account.
 *
 * Deliberately the same fields, in the same order, as CreateUserDialog — an
 * edit form that can set less than the create form leaves fields that can only
 * ever be set once, which is how accounts ended up with no mobile number.
 *
 * The one field that is not a straight copy is the role. The create form grants
 * exactly one role; a real account can hold several, and `accountant` + `tenant`
 * together is a shape this database already contains. A plain single select
 * would drop the second role on every save, so this one edits the *managerial*
 * role and leaves `tenant` to the role badges and the grant dialog.
 *
 * For the same reason the tenant selector edits one list, not both: a tenant
 * account's single portal link, or a managerial account's assignments. An
 * account holding both keeps its `user_tenants` rows untouched here; they are
 * edited from the Assign tenants dialog.
 */
export function EditUserDialog({
  user,
  assignedTenantIds,
  canAssignTenants,
  close,
  updateUser,
  refresh,
}: {
  user: UserWithRoles | null;
  /**
   * Current `user_tenants` links for this user, or `undefined` while
   * `userTenantsQuery` has not resolved (loading, or errored). `undefined`
   * must never be laundered into `[]` at the call site: this component sends
   * `tenantIds` to the server as an instruction to replace the user's links
   * wholesale, so treating "we don't know yet" as "there are none" would
   * delete real links on the next save.
   */
  assignedTenantIds: string[] | undefined;
  canAssignTenants: boolean;
  close: () => void;
  updateUser: ReturnType<typeof useServerFn<typeof updateAppUser>>;
  refresh: () => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Exclude<AppRole, "tenant">>("readonly");
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  // A tenant account is one that holds the role or carries the portal link —
  // the two are not always in step, which is what the revoke fix addresses.
  const isTenant = Boolean(user && (user.roles.includes("tenant") || user.tenant_id != null));

  // A user can hold more than one managerial role (admin + accountant is
  // reachable via GrantRoleDialog, which offers any role not already held).
  // The select below can only ever show one, so once there are two or more
  // it is switched to read-only and `role` is dropped from the submit
  // payload entirely — updateAppUser's swap treats the single select as the
  // whole managerial truth and would otherwise delete every role the form
  // never displayed.
  const managerialRoles = useMemo(
    () => (user ? user.roles.filter((r) => r !== "tenant") : []),
    [user],
  );
  const hasMultipleManagerialRoles = managerialRoles.length > 1;

  // A stable primitive standing in for "assignedTenantIds has arrived", so the
  // sync effect below can react to the load *finishing* without reacting to
  // every new array/Map instance a background refetch produces. See the effect
  // comment for why the array itself is deliberately not in the dep list.
  const assignmentsLoaded = assignedTenantIds !== undefined;

  useEffect(() => {
    if (!user) return;
    setUsername(user.username ?? "");
    setDisplayName(user.display_name ?? "");
    setEmail(user.email?.endsWith("@users.local") ? "" : (user.email ?? ""));
    setPhone(user.phone ?? "");
    setPassword("");
    const managerial = user.roles.find((r) => r !== "tenant") as
      | Exclude<AppRole, "tenant">
      | undefined;
    setRole(managerial ?? "readonly");
    // A tenant account edits its single portal link; a managerial account edits
    // its user_tenants assignments. An account carrying both — `accountant` +
    // `tenant`, which exists in this database — is treated as a tenant account
    // here and its user_tenants rows are left untouched, because the two lists
    // mean different things and one selector cannot honestly edit both.
    setTenantIds(isTenant ? (user.tenant_id ? [user.tenant_id] : []) : (assignedTenantIds ?? []));
    // Keyed on the target's id, not on `user`/`assignedTenantIds` themselves:
    // both `usersQuery` and `userTenantsQuery` refetch in the background
    // (the shared client's 30s staleTime only spaces those out, remounts and
    // post-mutation invalidations still refetch, and useUserTenants rebuilds a
    // fresh Map/array on every fetch), so depending
    // on their object identity would re-run this sync, and wipe whatever the
    // admin had already typed, on an ordinary tab-away-and-back. Syncing once
    // when the dialog opens for a (possibly different) user is the correct
    // lifetime for a form that edits a snapshot, not a live view.
    //
    // `assignmentsLoaded` IS in the dep list, deliberately, alongside `id`: it
    // is a boolean, so it flips at most once per edit session (loading/error
    // -> loaded), and that one flip re-seeds `tenantIds` from real data if the
    // dialog happened to open before `userTenantsQuery` had resolved. Without
    // it, opening Edit during that race would permanently strand the selector
    // on the `[]` fallback for the rest of the session — and, worse, that `[]`
    // would then be sent to the server as "clear every link" (see submit()).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, assignmentsLoaded]);

  /** يحفظ تعديلات الحساب ودوره وروابط مستأجريه. */
  async function submit() {
    if (!user) return;
    if (!username || !displayName) {
      toast.error(t("users.fillRequired"));
      return;
    }
    if (password && password.length < 8) {
      toast.error(t("users.passwordRequirements"));
      return;
    }
    if (isTenant && tenantIds.length !== 1) {
      toast.error(t("users.pickTenant"));
      return;
    }
    // See shouldSendTenantIds: only send `tenantIds` when the selection is
    // both known and actually different from what loaded — sending it on
    // every save by an editor who holds users.assign_tenants, even one that
    // only fixed a typo in the phone field, would churn those rows for no
    // reason (or, worse, silently drop a change if "unknown" were ever
    // mistaken for "no links").
    const tenantIdsChanged = shouldSendTenantIds(tenantIds, assignedTenantIds);
    setPending(true);
    try {
      const result = await updateUser({
        data: {
          userId: user.id,
          username,
          displayName,
          email: email || undefined,
          // "" clears the column; undefined would leave it untouched, and the
          // admin who emptied the box means the first.
          phone,
          password: password || undefined,
          // A tenant account's role is not editable here; changing it belongs
          // to the role badges, which know about the tenant links. Neither is
          // an account holding several managerial roles at once — the select
          // can only ever show one of them, so sending it would silently
          // drop whichever role the form never displayed.
          ...(isTenant || hasMultipleManagerialRoles ? {} : { role }),
          ...(isTenant
            ? { tenantId: tenantIds[0] }
            : canAssignTenants && tenantIdsChanged
              ? { tenantIds }
              : {}),
        },
      });
      if (!result?.updated) throw new Error(t("users.updateNotConfirmed"));
      toast.success(t("users.updated"));
      // The save itself landed; the tenant record's contact mirror failing is
      // a warning beside the success, not a replacement for it (D10).
      if (result.tenantContactSynced === false) {
        toast.warning(t("users.tenantContactSyncFailed"));
      }
      refresh();
      close();
    } catch (err) {
      // A duplicate username/email/mobile arrives tagged; it is shown in the
      // admin's language with the field to change, not as raw server text.
      toast.error(describeUserError(extractErrorMessage(err), t));
    } finally {
      setPending(false);
    }
  }

  /** يولّد كلمة مرور عشوائية جديدة للحساب. */
  function genPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const randomValues = new Uint32Array(16);
    crypto.getRandomValues(randomValues);
    let out = "";
    for (let i = 0; i < randomValues.length; i += 1) out += chars[randomValues[i] % chars.length];
    setPassword(out);
  }

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90vh] max-w-lg flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-4" />
            {t("users.editUser")}
          </DialogTitle>
          <DialogDescription>{user?.display_name ?? user?.username}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label required>{t("users.username")}</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label required>{t("users.displayName")}</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("users.email")}</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("users.mobile")}</Label>
            <Input
              type="tel"
              inputMode="tel"
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+965 5123 4567"
            />
            <p className="text-xs text-muted-foreground">{t("users.mobileHint")}</p>
          </div>
          <div className="grid gap-1.5">
            <Label className="flex items-center justify-between">
              <span>{t("users.newPassword")}</span>
              <Button size="sm" variant="ghost" type="button" onClick={genPassword}>
                <KeyRound className="me-1 size-3" />
                {t("users.generate")}
              </Button>
            </Label>
            {/* Visible by default — see the create dialog above. */}
            <PasswordInput
              defaultVisible
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("users.passwordKeepHint")}
            />
          </div>

          {!isTenant && (
            <div className="grid gap-1.5">
              <Label>{t("users.role")}</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as any)}
                disabled={hasMultipleManagerialRoles}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANAGERIAL_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`roles.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {hasMultipleManagerialRoles
                  ? t("users.multipleManagerialRoles").replace(
                      "{roles}",
                      managerialRoles.map((r) => t(`roles.${r}`)).join(", "),
                    )
                  : t("users.roleEditHint")}
              </p>
            </div>
          )}

          {(canAssignTenants || isTenant) && (
            <div className="grid gap-1.5 rounded-lg border bg-muted/30 p-3">
              <Label>{isTenant ? t("users.linkedTenant") : t("users.assignTenants")}</Label>
              {!isTenant && !assignmentsLoaded ? (
                // The multi-select is hidden rather than shown-but-editable:
                // shouldSendTenantIds already refuses to send an unknown
                // selection, so an editable-but-inert selector would let an
                // admin build a selection, hit Save, and see "User updated"
                // while tenantIds was silently never sent.
                <p className="text-xs text-destructive">{t("users.assignmentsUnknown")}</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {isTenant ? t("users.linkedTenantHint") : t("users.assignTenantsHint")}
                  </p>
                  <TenantMultiSelect
                    selected={tenantIds}
                    onChange={(ids) => setTenantIds(isTenant ? ids.slice(-1) : ids)}
                    enabled={Boolean(user)}
                    includeInactive
                  />
                </>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={pending} onClick={submit}>
            {pending ? t("common.loading") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
