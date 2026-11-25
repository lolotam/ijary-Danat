import { Link } from "@tanstack/react-router";
import { Pencil, Trash2, Users } from "lucide-react";

import type { AssignTenantsTarget } from "@/components/admin/AssignTenantsDialog";
import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type UserWithRoles } from "@/hooks/useUsers";
import { useI18n } from "@/i18n/provider";
import { APP_ROLES, type RevokeTarget } from "@/components/admin/users/userRoles";

/**
 * جدول المستخدمين: الأدوار، الحالة، ومنح الأدوار وسحبها والتعديل والحذف لكل صف.
 */
export function UsersTable({
  users,
  loading,
  error,
  canGrant,
  canRevoke,
  canToggleActive,
  canManageAccounts,
  statusPending,
  requestGrant,
  requestRevoke,
  requestEdit,
  requestDelete,
  updateActiveStatus,
  showTenantColumn,
  tenantNames,
  canAssignTenants,
  assignedTenants,
  requestAssignTenants,
}: {
  users: UserWithRoles[];
  loading: boolean;
  error: boolean;
  canGrant: boolean;
  canRevoke: boolean;
  canToggleActive: boolean;
  /** إنشاء الحسابات وتعديلها وحذفها للمدير فقط، كما يفرض الخادم. */
  canManageAccounts: boolean;
  statusPending: boolean;
  requestGrant: (profile: UserWithRoles) => void;
  requestRevoke: (target: RevokeTarget) => void;
  requestEdit: (profile: UserWithRoles) => void;
  requestDelete: (profile: UserWithRoles) => void;
  updateActiveStatus: (userId: string, isActive: boolean) => Promise<void>;
  showTenantColumn: boolean;
  /**
   * tenant id → display names/code, so the tenant column reads as a name not
   * a uuid. `nameEn` rides along for the client-side search on the tenants
   * tab, which matches the English name too.
   */
  tenantNames: Map<string, { name: string; nameEn: string | null; code: string | null }>;
  canAssignTenants: boolean;
  /** user id → linked tenant ids; undefined while the query is still loading. */
  assignedTenants: Map<string, string[]> | undefined;
  requestAssignTenants: (target: AssignTenantsTarget) => void;
}) {
  const { t } = useI18n();
  if (loading) return <p className="p-6 text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (error) return <p className="p-6 text-sm text-destructive">{t("common.error")}</p>;
  if (!users.length)
    return <p className="p-6 text-sm text-muted-foreground">{t("common.empty")}</p>;
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>{t("users.username")}</TableHead>
            <TableHead>{t("users.displayName")}</TableHead>
            <TableHead>{t("users.email")}</TableHead>
            <TableHead>{t("users.mobile")}</TableHead>
            {showTenantColumn && <TableHead>{t("tenants.title")}</TableHead>}
            {canAssignTenants && <TableHead>{t("users.assignedTenants")}</TableHead>}
            <TableHead>{t("users.roles")}</TableHead>
            <TableHead>{t("users.active")}</TableHead>
            <TableHead>{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((profile, index) => (
            <TableRow key={profile.id}>
              <TableCell>{index + 1}</TableCell>
              <TableCell className="font-medium">{profile.username ?? "—"}</TableCell>
              <TableCell>{profile.display_name ?? "—"}</TableCell>
              <TableCell>
                <LtrText>{profile.email ?? "—"}</LtrText>
              </TableCell>
              <TableCell>
                <LtrText>{profile.phone?.trim() ? profile.phone : "—"}</LtrText>
              </TableCell>
              {showTenantColumn && (
                <TableCell>
                  {profile.tenant_id ? (
                    <div className="min-w-0">
                      {/*
                        The name is a link to the tenant page: the admin
                        reading a portal user's row almost always wants the
                        tenant behind it, and the uuid underneath was never
                        clickable anywhere.
                      */}
                      <Link
                        to="/admin/tenants/$id"
                        params={{ id: profile.tenant_id }}
                        className="block truncate font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {tenantNames.get(profile.tenant_id)?.name ?? t("common.unknown")}
                      </Link>
                      {tenantNames.get(profile.tenant_id)?.code ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {tenantNames.get(profile.tenant_id)!.code}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    "—"
                  )}
                </TableCell>
              )}
              {canAssignTenants && (
                <TableCell>
                  <Badge variant={assignedTenants?.get(profile.id)?.length ? "default" : "outline"}>
                    {assignedTenants?.get(profile.id)?.length ?? 0}
                  </Badge>
                </TableCell>
              )}
              <TableCell>
                <div className="flex min-w-48 flex-wrap gap-1.5">
                  {profile.roles.length === 0 && (
                    <span className="text-xs text-muted-foreground">{t("users.noRoles")}</span>
                  )}
                  {profile.roles.map((role) => (
                    <Badge key={role} variant="secondary" className="gap-1">
                      {t(`roles.${role}`)}
                      {canRevoke && (
                        <button
                          type="button"
                          className="rounded px-1 hover:bg-destructive/15 hover:text-destructive"
                          title={`${t("users.revoke")} ${t(`roles.${role}`)}`}
                          aria-label={`${t("users.revoke")} ${t(`roles.${role}`)}`}
                          onClick={() =>
                            requestRevoke({
                              userId: profile.id,
                              role,
                              assignedCount: assignedTenants?.get(profile.id)?.length ?? 0,
                              hasPortalLink: profile.tenant_id != null,
                            })
                          }
                        >
                          ×
                        </button>
                      )}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={profile.is_active}
                    disabled={!canToggleActive || statusPending}
                    onCheckedChange={(checked) => updateActiveStatus(profile.id, checked)}
                  />
                  <span className="text-xs text-muted-foreground">
                    {profile.is_active ? t("users.active") : t("users.inactive")}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canGrant || profile.roles.length === APP_ROLES.length}
                    onClick={() => requestGrant(profile)}
                  >
                    {t("users.grantRole")}
                  </Button>
                  {canAssignTenants && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t("users.assignTenants")}
                      title={t("users.assignTenants")}
                      onClick={() =>
                        requestAssignTenants({
                          id: profile.id,
                          label: profile.display_name ?? profile.username ?? profile.id,
                          // `undefined` (not `[]`) when the Map itself hasn't
                          // resolved yet — see the dedicated comment on
                          // EditUserDialog's assignedTenantIds prop below for
                          // why the line is drawn at the Map, not at `.get(id)`.
                          tenantIds: assignedTenants
                            ? (assignedTenants.get(profile.id) ?? [])
                            : undefined,
                        })
                      }
                    >
                      <Users className="size-4" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={!canManageAccounts}
                    title={t("common.edit")}
                    aria-label={t("common.edit")}
                    onClick={() => requestEdit(profile)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="text-destructive"
                    disabled={!canManageAccounts}
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                    onClick={() => requestDelete(profile)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
