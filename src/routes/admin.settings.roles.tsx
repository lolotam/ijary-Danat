import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Pencil, Trash2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import {
  useCustomRoles,
  useCreateCustomRole,
  useUpdateCustomRole,
  useDeleteCustomRole,
  type CustomRoleWithPermissions,
} from "@/hooks/useCustomRoles";
import { RoleEditorDialog, type RoleFormValues } from "@/components/admin/roles/RoleEditorDialog";
import { BuiltInMatrixPanel } from "@/components/admin/roles/BuiltInMatrixPanel";

export const Route = createFileRoute("/admin/settings/roles")({
  component: RolesPermissionsPage,
});

/**
 * شاشة الأدوار والصلاحيات: مصفوفة الأدوار الافتراضية دائماً، والأدوار المخصصة
 * فقط عندما تكون جداولها موجودة فعلاً.
 *
 * Custom roles have never existed in production — migration 16 was not applied
 * — so the tab offered an editor backed by nothing: every read 404'd and every
 * save would have failed. It is hidden rather than repaired because hiding is
 * reversible and truthful; the moment the tables exist the tab returns on its
 * own, with no code change.
 *
 * The built-in matrix reads `role_permissions`, which does exist, so it is the
 * default tab and the half of this screen that always works.
 */
function RolesPermissionsPage() {
  const { t } = useI18n();
  // Shares React Query's cache with the panel below, so this costs no extra
  // request.
  //
  // The check is `isSuccess`, not `!isLoading`. Review finding on PR #206: on
  // any error React Query leaves `data` as `undefined` while clearing
  // `isLoading`, and `undefined !== null` would have brought the broken editor
  // back for every failure that was not a missing table. The feature is shown
  // only on a query that actually succeeded and actually found its tables —
  // and while loading, showing a tab and then withdrawing it reads worse than
  // showing it a moment late.
  const customRoles = useCustomRoles();
  const customRolesAvailable = customRoles.isSuccess && customRoles.data !== null;

  return (
    <Tabs defaultValue="matrix" className="space-y-4">
      <TabsList>
        <TabsTrigger value="matrix">{t("rolesSettings.builtInRoleMatrix")}</TabsTrigger>
        {customRolesAvailable ? (
          <TabsTrigger value="custom">{t("rolesSettings.customRoles")}</TabsTrigger>
        ) : null}
      </TabsList>

      <TabsContent value="matrix">
        <BuiltInMatrixPanel />
      </TabsContent>

      {customRolesAvailable ? (
        <TabsContent value="custom">
          <CustomRolesPanel />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

// ----------------------------------------------------------------------------
// Custom Roles
// ----------------------------------------------------------------------------

function CustomRolesPanel() {
  const { locale, t } = useI18n();
  const roles = useCustomRoles();
  const createRole = useCreateCustomRole();
  const updateRole = useUpdateCustomRole();
  const deleteRole = useDeleteCustomRole();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomRoleWithPermissions | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomRoleWithPermissions | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(role: CustomRoleWithPermissions) {
    setEditing(role);
    setDialogOpen(true);
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              {t("rolesSettings.customRoles")}
            </CardTitle>
            <CardDescription>{t("rolesSettings.createNewRolesAndAssign")}</CardDescription>
          </div>
          <Button onClick={openCreate}>
            <Plus className="me-2 h-4 w-4" />
            {t("rolesSettings.newRole")}
          </Button>
        </CardHeader>
        <CardContent>
          {roles.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("rolesSettings.loading")}</p>
          ) : (roles.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("rolesSettings.noCustomRolesYetCreate")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("rolesSettings.code")}</TableHead>
                  <TableHead>{t("rolesSettings.name")}</TableHead>
                  <TableHead>{t("rolesSettings.description")}</TableHead>
                  <TableHead>{t("rolesSettings.permissions")}</TableHead>
                  <TableHead>{t("rolesSettings.status")}</TableHead>
                  <TableHead>{t("rolesSettings.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(roles.data ?? []).map((role) => (
                  <TableRow key={role.id}>
                    <TableCell className="font-mono text-xs">{role.code}</TableCell>
                    <TableCell>{locale === "ar" ? role.name_ar : role.name_en}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                      {role.description ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{role.permissions.length}</Badge>
                    </TableCell>
                    <TableCell>
                      {role.is_active ? (
                        <Badge>{t("rolesSettings.active")}</Badge>
                      ) : (
                        <Badge variant="outline">{t("rolesSettings.disabled")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("common.edit")}
                        aria-label={t("common.edit")}
                        onClick={() => openEdit(role)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                        onClick={() => setDeleteTarget(role)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <RoleEditorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSubmit={async (values) => {
          try {
            if (editing) {
              await updateRole.mutateAsync({
                id: editing.id,
                updates: {
                  name_ar: values.name_ar,
                  name_en: values.name_en,
                  description: values.description,
                  is_active: values.is_active,
                },
                permissions: values.permissions,
              });
              toast.success(t("rolesSettings.updated"));
            } else {
              await createRole.mutateAsync({
                code: values.code,
                name_ar: values.name_ar,
                name_en: values.name_en,
                description: values.description,
                permissions: values.permissions,
              });
              toast.success(t("rolesSettings.created"));
            }
            setDialogOpen(false);
          } catch (err) {
            toast.error(extractErrorMessage(err));
          }
        }}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("rolesSettings.deleteRole")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("rolesSettings.roleWillBeDeleted").replace(
                "{name}",
                String(locale === "ar" ? deleteTarget?.name_ar : deleteTarget?.name_en),
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("rolesSettings.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteTarget) return;
                try {
                  await deleteRole.mutateAsync(deleteTarget.id);
                  toast.success(t("rolesSettings.deleted"));
                  setDeleteTarget(null);
                } catch (err) {
                  toast.error(extractErrorMessage(err));
                }
              }}
            >
              {t("rolesSettings.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
