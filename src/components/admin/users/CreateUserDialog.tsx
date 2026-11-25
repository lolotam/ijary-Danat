import { useState } from "react";

import { KeyRound, UserPlus } from "lucide-react";
import type { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { TenantMultiSelect } from "@/components/admin/TenantMultiSelect";
import { TenantPicker } from "@/components/admin/TenantPicker";
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
import { Label, RequiredMark } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePermissions } from "@/hooks/usePermissions";
import type { ContractedTenant } from "@/hooks/useContractedTenants";
import { useSetUserTenants } from "@/hooks/useUserTenants";
import { useI18n } from "@/i18n/provider";
import type { AppRole } from "@/integrations/supabase/database.types";
import { createAppUser, type CredentialDelivery } from "@/fns/createAppUser";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { describeUserError } from "@/lib/userConflicts";
import { PERMISSIONS } from "@/lib/permissions";
import { MANAGERIAL_ROLES } from "@/components/admin/users/userRoles";

/**
 * حوار إنشاء حساب إداري أو حساب بوابة مستأجر، بحسب التبويب الذي فُتح منه.
 *
 * Creates an account of one `kind`, which the tab the admin opened it from
 * decides. The two kinds share every credential field and differ in what the
 * tenant selection means:
 *
 * - `tenant` — one tenant, picked first, from the tenants that hold a contract
 *   and have no portal account yet.
 *   It becomes `profiles.tenant_id`, the link the portal reads to decide whose
 *   data to show, and it prefills the account's name, email and mobile.
 * - `managerial` — any number of tenants, picked last and only by an editor
 *   holding `users.assign_tenants`. They become `user_tenants` rows, which
 *   scope what the account can see; the account is not a tenant.
 *
 * Restricting the tenant list to contract holders means a portal login cannot
 * be created before the tenant's contract exists. That is the intended order —
 * see `useContractedTenants`.
 */
export function CreateUserDialog({
  kind,
  open,
  close,
  createUser,
  refresh,
}: {
  kind: "managerial" | "tenant";
  open: boolean;
  close: () => void;
  createUser: ReturnType<typeof useServerFn<typeof createAppUser>>;
  refresh: () => void;
}) {
  const { t } = useI18n();
  const permissions = usePermissions();
  const canAssignTenants = permissions.can(PERMISSIONS.USERS_ASSIGN_TENANTS);
  const setUserTenants = useSetUserTenants();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Exclude<AppRole, "tenant">>("readonly");
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const isTenant = kind === "tenant";

  /** يفرّغ حقول نموذج الإنشاء. */
  function reset() {
    setUsername("");
    setDisplayName("");
    setEmail("");
    setPhone("");
    setPassword("");
    setRole("readonly");
    setTenantIds([]);
  }

  /**
   * يعبّئ الاسم والبريد والرقم من المستأجر المختار، والواتساب أولاً.
   *
   * Adopts the picked tenant's details as the account's.
   *
   * Overwrites rather than fills-if-empty: the picker sits above these fields,
   * so anything already in them came from an earlier pick, and leaving a
   * previous tenant's email on the account being created is the one outcome
   * worth ruling out. `?? ""` matters — a tenant with no email on file must
   * clear the box, not inherit the last tenant's.
   *
   * `name`, not `tenantDisplayName(...)`: the display name is stored, and
   * storing it through the locale would make the account read differently
   * depending on which language the admin happened to have selected.
   *
   * The mobile copied here is the number `find_phone_conflicts` would
   * otherwise flag. createAppUser passes this same tenant as `_exclude_tenant`,
   * so the tenant's own number is not treated as a conflict with itself.
   */
  function applyTenant(tenant: ContractedTenant) {
    setTenantIds([tenant.id]);
    setDisplayName(tenant.name);
    setEmail(tenant.email ?? "");
    // WhatsApp first: credential sends and chat threads key off this number,
    // so the form suggests the same number those will actually use.
    setPhone(tenant.whatsapp ?? tenant.mobile ?? "");
  }

  /**
   * يبلّغ عن إنشاء الحساب وعن مصير بيانات الدخول في آنٍ واحد.
   *
   * Creation succeeding while the credentials went nowhere used to read as an
   * unqualified success, so the admin assumed the customer had been told. The
   * two halves genuinely have separate outcomes, so they are reported apart.
   *
   * `tenant-paused` names its own cause: the tenant's notifications are off,
   * so nothing was ever going to reach them — the admin must unpause the
   * tenant or resend afterwards, not hunt for a broken template.
   */
  function reportCreation(delivery?: CredentialDelivery): void {
    if (!delivery || delivery.status === "sent") {
      toast.success(t("users.created"));
      return;
    }

    const detail =
      delivery.status === "paused"
        ? t("users.credentialsPaused")
        : delivery.status === "tenant-paused"
          ? t("users.credentialsTenantPaused")
          : delivery.status === "no-recipients"
            ? t("users.credentialsNoRecipients")
            : // The provider's own words — "SMTP refused the message" tells an
              // admin what to do next in a way a generic sentence cannot.
              (delivery.reason ?? t("users.credentialsSendFailed"));

    toast.warning(t("users.credentialsNotSent"), { description: detail });
  }

  /** ينشئ الحساب من بيانات النموذج. */
  async function submit() {
    if (!username || !displayName || !email || !password) {
      toast.error(t("users.fillRequired"));
      return;
    }
    if (password.length < 8) {
      toast.error(t("users.passwordRequirements"));
      return;
    }
    if (isTenant && tenantIds.length !== 1) {
      toast.error(t("users.pickTenant"));
      return;
    }
    setPending(true);
    try {
      if (isTenant) {
        // Tenant accounts: create with kind=tenant + the single linked tenant.
        // The backend (createAppUser) emails credentials automatically and
        // marks the tenant's portal access enabled.
        const created = await createUser({
          data: {
            kind: "tenant",
            username,
            password,
            displayName,
            email,
            phone,
            tenantId: tenantIds[0],
          },
        });
        reportCreation(created?.credentialDelivery);
        // The account exists by now; a tenant-record sync failure is a
        // warning, never a failed creation (D10) — the admin must still know
        // the tenant's email/WhatsApp were not mirrored.
        if (created?.tenantContactSynced === false) {
          toast.warning(t("users.tenantContactSyncFailed"));
        }
        if (created?.tenantPortalEnabled === false) {
          toast.warning(t("users.tenantPortalEnableFailed"));
        }
      } else {
        const created = await createUser({
          data: { kind: "managerial", username, password, displayName, email, phone, role },
        });
        reportCreation(created?.credentialDelivery);

        // Best-effort: the account already exists, so a failed link must surface
        // as its own error rather than reading as a failed creation.
        if (canAssignTenants && tenantIds.length && created?.userId) {
          try {
            await setUserTenants.mutateAsync({ userId: created.userId, tenantIds });
          } catch (err) {
            toast.error(t("users.actionError"), {
              description: err instanceof Error ? err.message : undefined,
            });
          }
        }
      }

      refresh();
      reset();
      close();
    } catch (err) {
      // A duplicate username/email/mobile arrives tagged; it is shown in the
      // admin's language with the field to change, not as raw server text.
      toast.error(describeUserError(extractErrorMessage(err), t));
    } finally {
      setPending(false);
    }
  }

  /** يولّد كلمة مرور عشوائية للحساب. */
  function genPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const randomValues = new Uint32Array(16);
    crypto.getRandomValues(randomValues);
    let out = "";
    for (let i = 0; i < randomValues.length; i += 1) out += chars[randomValues[i] % chars.length];
    setPassword(out);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="flex max-h-[90vh] max-w-lg flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="size-4" />
            {isTenant ? t("users.addTenantUser") : t("users.addManagerialUser")}
          </DialogTitle>
          <DialogDescription>{t("users.createHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {/*
            First field, and the one that fills the three below it. A tenant
            login exists to represent a tenant, so "which tenant" is the
            question to answer before any account detail — and answering it
            first is what makes prefilling safe: nothing typed can be
            overwritten by a later pick.
          */}
          {isTenant && (
            <div className="grid gap-1.5 rounded-lg border bg-muted/30 p-3">
              <Label required>{t("users.linkedTenant")}</Label>
              <TenantPicker value={tenantIds[0] ?? ""} onSelect={applyTenant} enabled={open} />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label required>{t("users.username")}</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label required>{t("users.displayName")}</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label required>{t("users.email")}</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
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
            {/* The asterisk is inline rather than via Label's `required`: this
                label is a justify-between row, so a trailing sibling would land
                past the Generate button instead of beside the text. */}
            <Label className="flex items-center justify-between">
              <span>
                {t("users.password")}
                <RequiredMark />
              </span>
              <Button size="sm" variant="ghost" type="button" onClick={genPassword}>
                <KeyRound className="me-1 size-3" />
                {t("users.generate")}
              </Button>
            </Label>
            {/* Visible by default: the admin generates this and reads it back to
                send to the user. Masking it would break that, not secure it. */}
            <PasswordInput
              defaultVisible
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {!isTenant && (
            <div className="grid gap-1.5">
              <Label>{t("users.role")}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as any)}>
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
            </div>
          )}

          {/*
            Managerial only. A tenant account's single link is picked at the top
            of this form instead — the two lists mean different things, and this
            one is the optional many-to-many assignment governed by
            users.assign_tenants.
          */}
          {!isTenant && canAssignTenants && (
            <div className="grid gap-1.5 rounded-lg border bg-muted/30 p-3">
              <Label>{t("users.assignTenants")}</Label>
              <p className="text-xs text-muted-foreground">{t("users.assignTenantsHint")}</p>
              <TenantMultiSelect
                selected={tenantIds}
                onChange={setTenantIds}
                enabled={open}
                // A managerial assignment is a reporting/scope link, not a
                // login, so it is offered for every tenant. Lifecycle is derived
                // from *active* contracts (migration 54), so filtering on it
                // here would hide every tenant between two contracts.
                includeInactive
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={pending} onClick={submit}>
            {pending ? t("common.loading") : t("users.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
