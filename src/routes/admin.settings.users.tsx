import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Plus, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import {
  AssignTenantsDialog,
  type AssignTenantsTarget,
} from "@/components/admin/AssignTenantsDialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/usePermissions";
import { useTenants } from "@/hooks/useTenants";
import {
  useAllTenantUsers,
  useGrantRole,
  useRevokeRole,
  useSetUserActive,
  useSetUserTenant,
  useUsersWithRoles,
  type UserWithRoles,
  tenantHasOtherAccount,
} from "@/hooks/useUsers";
import { CONTRACTED_TENANTS_KEY } from "@/hooks/useContractedTenants";
import { useDebounce } from "@/hooks/useDebounce";
import { Pager } from "@/components/admin/Phase2Ui";
import { useUserTenants } from "@/hooks/useUserTenants";
import { useI18n } from "@/i18n/provider";
import type { AppRole } from "@/integrations/supabase/database.types";
import { createAppUser } from "@/fns/createAppUser";
import { deleteAppUser } from "@/fns/deleteAppUser";
import { updateAppUser } from "@/fns/updateAppUser";
import { PERMISSIONS } from "@/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { APP_ROLES, type RevokeTarget } from "@/components/admin/users/userRoles";
import { CreateUserDialog } from "@/components/admin/users/CreateUserDialog";
import { EditUserDialog } from "@/components/admin/users/EditUserDialog";
import { GrantRoleDialog } from "@/components/admin/users/GrantRoleDialog";
import { RevokeRoleDialog } from "@/components/admin/users/RevokeRoleDialog";
import { UsersTable } from "@/components/admin/users/UsersTable";

export const Route = createFileRoute("/admin/settings/users")({ component: UsersPage });

/**
 * شاشة إدارة المستخدمين: تبويبا الحسابات الإدارية وحسابات المستأجرين، وحوارات
 * المنح والسحب والإنشاء والتعديل والحذف.
 *
 * The table and the four dialogs live in `components/admin/users/` (audit M13);
 * this route keeps the page state and the handlers that call the server.
 */
function UsersPage() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const canRead = permissions.can(PERMISSIONS.USERS_READ);
  const canGrant = permissions.canAny([PERMISSIONS.USERS_CREATE, PERMISSIONS.USERS_UPDATE]);
  const canRevoke = permissions.can(PERMISSIONS.USERS_DELETE);
  const canToggleActive = permissions.can(PERMISSIONS.USERS_UPDATE);
  // Creating, editing and deleting an account is admin-only, matching the
  // server: createAppUser, updateAppUser and deleteAppUser all require
  // has_role('admin'). Gating these on users.create/update/delete offered a
  // permission holder three buttons the server always refused (audit H5,
  // decided admin-only). The Active toggle and the role badges keep their
  // permission gates — setUserActive and revokeUserRole check permissions.
  const canManageAccounts = permissions.isAdmin;
  const canAssignTenants = permissions.can(PERMISSIONS.USERS_ASSIGN_TENANTS);
  const [tab, setTab] = useState<"managerial" | "tenants">("managerial");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  // The staff tab's query key and the pager follow the *debounced* value, so
  // typing fires one server search after the pause instead of one per
  // keystroke. The tenants tab filters client-side and reads `search` directly.
  const debouncedSearch = useDebounce(search);
  const pageSize = 20;
  const queryClient = useQueryClient();
  // Staff tab only: server search + pager. The tenants tab loads every
  // tenant-scope user once (below) and filters locally — see useAllTenantUsers.
  const usersQuery = useUsersWithRoles(
    { page, pageSize, search: debouncedSearch, scope: "managerial" },
    !permissions.isLoading && canRead && tab === "managerial",
  );
  // Only on its own tab: it pages through every tenant account.
  const tenantUsersQuery = useAllTenantUsers(
    !permissions.isLoading && canRead && tab === "tenants",
  );
  const grantRole = useGrantRole();
  const revokeRole = useRevokeRole();
  const setUserActive = useSetUserActive();
  const setUserTenant = useSetUserTenant();
  // Every tenant, not just those with an active contract: this list resolves
  // names for users already linked, including tenants whose contract has ended.
  const allTenantsQuery = useTenants({ pageSize: 1000 }, canRead);
  const userTenantsQuery = useUserTenants(!permissions.isLoading && canRead);
  const tenantNames = useMemo(
    () =>
      new Map(
        (allTenantsQuery.data?.items ?? []).map((tenant) => [
          tenant.id,
          // name_en rides along for the tenants-tab search, which matches the
          // English name as well as the Arabic one and the code.
          { name: tenant.name, nameEn: tenant.name_en, code: tenant.code },
        ]),
      ),
    [allTenantsQuery.data?.items],
  );
  const createUser = useServerFn(createAppUser);
  const updateUser = useServerFn(updateAppUser);
  const deleteUser = useServerFn(deleteAppUser);
  const [grantUser, setGrantUser] = useState<UserWithRoles | null>(null);
  const [selectedRole, setSelectedRole] = useState<AppRole | "">("");
  const [grantTenantId, setGrantTenantId] = useState<string>("");
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  // Both managerial and tenant portal accounts are created here. Tenant
  // accounts are linked to a tenant and emailed their credentials.
  //
  // The kind is held separately from the open flag, and deliberately outlives
  // it: deriving it from a nullable "which dialog" value means it reverts on
  // close, flipping a tenant form to the managerial layout mid-fade-out.
  const [createKind, setCreateKind] = useState<"managerial" | "tenant">("managerial");
  const [createOpen, setCreateOpen] = useState(false);
  // Counts opens, to key the create form — see the comment on the element.
  const [createSeq, setCreateSeq] = useState(0);
  const [assignTarget, setAssignTarget] = useState<AssignTenantsTarget | null>(null);
  const [editTarget, setEditTarget] = useState<UserWithRoles | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserWithRoles | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  // Any role may be granted to any account. A user holding both kinds of
  // roles appears in both tabs (managerial + tenants) simultaneously.
  const availableRoles = useMemo(() => {
    if (!grantUser) return [];
    return APP_ROLES.filter((role) => !grantUser.roles.includes(role));
  }, [grantUser]);

  // Scope is applied server-side via `useUsersWithRoles({ scope })`.
  const pageUsers = usersQuery.data?.items ?? [];

  /**
   * يرشّح حسابات المستأجرين محليًا: بيانات الحساب، واسم المستأجر وكوده الإنجليزي.
   *
   * The whole tenant-scope list is already loaded (no pager, no server search
   * on this tab), so the filter runs over it immediately on every keystroke —
   * debouncing here would only delay what costs no network. The tenant's
   * name, name_en and DANA code join the profile columns because "search by
   * tenant code" is the thing the server search could never do.
   */
  const filteredTenantUsers = useMemo(() => {
    const all = tenantUsersQuery.data ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return all;
    return all.filter((profile) => {
      const tenant = profile.tenant_id ? tenantNames.get(profile.tenant_id) : undefined;
      return [
        profile.display_name,
        profile.username,
        profile.email,
        profile.phone,
        tenant?.name,
        tenant?.nameEn,
        tenant?.code,
      ].some((value) => value && value.toLowerCase().includes(term));
    });
  }, [tenantUsersQuery.data, search, tenantNames]);

  /**
   * يبطل قوائم المستأجرين وتفاصيلهم بعد حفظ حساب مستأجر.
   *
   * The save mirrors email/WhatsApp onto the tenant row server-side, so any
   * tenant list or detail fetched in the stale window would show the old ones.
   */
  function invalidateTenantContactViews() {
    queryClient.invalidateQueries({ queryKey: ["tenants"] });
    queryClient.invalidateQueries({ queryKey: ["tenant"] });
  }

  /** يحدّث استعلامي التبويبين بعد أي إنشاء أو تعديل أو حذف. */
  async function refetchUsers() {
    // Invalidation, not refetch(): it skips the query of the tab not shown,
    // so a staff-tab save does not page through every tenant account.
    await queryClient.invalidateQueries({ queryKey: ["users-with-roles"] });
    // A created or deleted tenant account changes who the create picker offers.
    await queryClient.invalidateQueries({ queryKey: CONTRACTED_TENANTS_KEY });
  }

  function closeGrantDialog() {
    setGrantUser(null);
    setSelectedRole("");
    setGrantTenantId("");
  }
  async function grantSelectedRole() {
    if (!grantUser || !selectedRole) return;
    // The tenant role is meaningless without a linked tenant — the portal reads
    // profiles.tenant_id to decide whose data to show.
    if (selectedRole === "tenant" && !grantTenantId) {
      toast.error(t("users.pickTenant"));
      return;
    }
    try {
      if (selectedRole === "tenant" && (await tenantHasOtherAccount(grantTenantId, grantUser.id))) {
        toast.error(t("users.tenantAlreadyHasAccount"));
        return;
      }
      await grantRole.mutateAsync({ userId: grantUser.id, role: selectedRole });
      if (selectedRole === "tenant") {
        await setUserTenant.mutateAsync({ userId: grantUser.id, tenantId: grantTenantId });
      }
      toast.success(t("users.roleGranted"));
      closeGrantDialog();
    } catch (error) {
      toast.error(t("users.actionError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }
  async function revokeSelectedRole() {
    if (!revokeTarget) return;
    try {
      const result = await revokeRole.mutateAsync({
        userId: revokeTarget.userId,
        role: revokeTarget.role,
      });
      // `clearedTenantLink` alone would understate the case where tenant_id
      // was already null but user_tenants still held rows (revokeUserRole no
      // longer claims a link was cleared when it wasn't — see finding 5 —
      // so this must independently check whether rows actually got deleted).
      toast.success(
        result.clearedTenantLink || result.removedAssignments > 0
          ? t("users.roleRevokedWithLinks").replace("{count}", String(result.removedAssignments))
          : t("users.roleRevoked"),
      );
      setRevokeTarget(null);
    } catch (error) {
      toast.error(t("users.actionError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }
  async function updateActiveStatus(userId: string, isActive: boolean) {
    try {
      await setUserActive.mutateAsync({ userId, isActive });
      toast.success(t("users.statusUpdated"));
    } catch (error) {
      toast.error(t("users.actionError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }
  /** يحذف الحساب المؤكَّد، ولا يعلن النجاح إلا بتأكيد الخادم. */
  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeletePending(true);
    try {
      // Asserted rather than assumed: a server function that throws a Response
      // resolves here with that Response instead of rejecting, so "it did not
      // throw" is not evidence the account is gone.
      const result = (await deleteUser({ data: { userId: deleteTarget.id } })) as
        | { deleted?: boolean }
        | undefined;
      if (!result?.deleted) throw new Error(t("users.deleteNotConfirmed"));
      toast.success(t("users.deleted"));
      setDeleteTarget(null);
      await refetchUsers();
    } catch (error) {
      toast.error(t("users.actionError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setDeletePending(false);
    }
  }

  if (permissions.isLoading)
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (permissions.error) return <p className="text-sm text-destructive">{t("common.error")}</p>;
  if (!canRead) return <p className="text-sm text-destructive">{t("common.notAuthorized")}</p>;

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("users.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("users.subtitle")}</p>
        </div>
        {/*
          One button, following the tab. Both kinds used to be offered side by
          side, which asked the admin to answer a question the tab had already
          answered — and made it easy to open the tenant form from the
          managerial tab and back.

          Note the tab value is "tenants" (a list of users) while the dialog
          kind is "tenant" (one account's link), so this maps rather than
          passing `tab` through.
        */}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!canManageAccounts}
            onClick={() => {
              setCreateKind(tab === "tenants" ? "tenant" : "managerial");
              setCreateOpen(true);
              setCreateSeq((seq) => seq + 1);
            }}
          >
            <Plus className="size-4" />
            {tab === "tenants" ? t("users.addTenantUser") : t("users.addManagerialUser")}
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as "managerial" | "tenants");
          setPage(1);
        }}
      >
        <TabsList>
          <TabsTrigger value="managerial">{t("users.tab.managerial")}</TabsTrigger>
          <TabsTrigger value="tenants">{t("users.tab.tenants")}</TabsTrigger>
        </TabsList>
        <div className="mt-4">
          <Input
            className="mb-3 max-w-sm"
            value={search}
            onChange={(event) => {
              // Reset on the keystroke: the staff query still holds the
              // settled term, so page 1 of it is the only request that fires.
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder={t("common.search")}
          />
        </div>
        <TabsContent value="managerial" className="mt-4">
          <UsersTable
            users={pageUsers}
            loading={usersQuery.isLoading}
            error={Boolean(usersQuery.error)}
            canGrant={canGrant}
            canRevoke={canRevoke}
            canToggleActive={canToggleActive}
            canManageAccounts={canManageAccounts}
            statusPending={setUserActive.isPending}
            requestGrant={setGrantUser}
            requestRevoke={setRevokeTarget}
            requestEdit={setEditTarget}
            requestDelete={setDeleteTarget}
            updateActiveStatus={updateActiveStatus}
            showTenantColumn={false}
            tenantNames={tenantNames}
            canAssignTenants={canAssignTenants}
            assignedTenants={userTenantsQuery.data}
            requestAssignTenants={setAssignTarget}
          />
          <Pager
            page={page}
            pageSize={pageSize}
            count={usersQuery.data?.count ?? 0}
            setPage={setPage}
          />
        </TabsContent>
        <TabsContent value="tenants" className="mt-4">
          <div className="mb-3 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden="true" />
            <p>{t("users.tenantHint")}</p>
          </div>
          {/*
            No Pager here, by design: this tab renders every tenant-scope user
            in one list (useAllTenantUsers) and narrows it client-side, because
            the old paged query both capped what the tab could show and could
            not search by tenant name or code at all. Row numbers therefore run
            1..N over the filtered list, not over a page window.
          */}
          <UsersTable
            users={filteredTenantUsers}
            loading={tenantUsersQuery.isLoading}
            error={Boolean(tenantUsersQuery.error)}
            canGrant={canGrant}
            canRevoke={canRevoke}
            canToggleActive={canToggleActive}
            canManageAccounts={canManageAccounts}
            statusPending={setUserActive.isPending}
            requestGrant={setGrantUser}
            requestRevoke={setRevokeTarget}
            requestEdit={setEditTarget}
            requestDelete={setDeleteTarget}
            updateActiveStatus={updateActiveStatus}
            showTenantColumn={true}
            tenantNames={tenantNames}
            canAssignTenants={false}
            assignedTenants={userTenantsQuery.data}
            requestAssignTenants={setAssignTarget}
          />
        </TabsContent>
      </Tabs>

      <GrantRoleDialog
        user={grantUser}
        selectedRole={selectedRole}
        availableRoles={availableRoles}
        pending={grantRole.isPending || setUserTenant.isPending}
        close={closeGrantDialog}
        selectRole={setSelectedRole}
        grantSelectedRole={grantSelectedRole}
        grantTenantId={grantTenantId}
        selectGrantTenant={setGrantTenantId}
        tenantOptions={allTenantsQuery.data?.items ?? []}
      />
      <RevokeRoleDialog
        target={revokeTarget}
        pending={revokeRole.isPending}
        close={() => setRevokeTarget(null)}
        revokeSelectedRole={revokeSelectedRole}
      />
      {/*
        Keyed so each open gets a fresh form. `reset()` only runs after a
        successful submit and the dialog stays mounted between opens, so
        without this a tenant account abandoned half-way leaves its prefilled
        name/email/mobile — and its picked tenant — sitting in the managerial
        form the next time it opens.

        The key counts opens rather than tracking the open flag, which also
        changes on close: remounting at that moment would cut the exit
        animation instead of letting the dialog fade out.
      */}
      <CreateUserDialog
        key={createSeq}
        kind={createKind}
        open={createOpen}
        close={() => setCreateOpen(false)}
        createUser={createUser}
        // `profiles` is also read by the tenants list, which uses it to tell a
        // portal flag with an account behind it from one without. Creating an
        // account changes that answer, and without this the badge stays stale
        // for the router's 30-second staleTime — long enough for an admin to
        // create the account, open the tenant list, and see "No account".
        refresh={() => {
          refetchUsers();
          queryClient.invalidateQueries({ queryKey: ["profiles"] });
          invalidateTenantContactViews();
        }}
      />
      <AssignTenantsDialog target={assignTarget} close={() => setAssignTarget(null)} />
      <EditUserDialog
        user={editTarget}
        // `undefined` here means "not loaded yet / query errored"; `[]` means
        // "loaded, and this user genuinely has no links" — and the two must
        // stay distinguishable (see EditUserDialog's assignedTenantIds prop).
        // The distinction has to be drawn on whether `userTenantsQuery.data`
        // itself resolved, not on whether `.get(id)` found a key: useUserTenants
        // only calls byUser.set(...) for users who have at least one row, so a
        // user with zero assignments is never a key in the Map at all — a
        // missing key is not evidence of anything until the Map exists. Once
        // the Map exists, `?? []` here is correct (unlike hoisting it out to
        // "no Map yet", which would silently mean "clear everything" for any
        // brand-new or just-cleared managerial user).
        assignedTenantIds={
          editTarget && userTenantsQuery.data
            ? (userTenantsQuery.data.get(editTarget.id) ?? [])
            : undefined
        }
        canAssignTenants={canAssignTenants}
        close={() => setEditTarget(null)}
        updateUser={updateUser}
        refresh={() => {
          refetchUsers();
          userTenantsQuery.refetch();
          invalidateTenantContactViews();
        }}
      />
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("users.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("users.deleteDescription")} —{" "}
              {deleteTarget?.display_name ?? deleteTarget?.username}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletePending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {deletePending ? t("common.loading") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
