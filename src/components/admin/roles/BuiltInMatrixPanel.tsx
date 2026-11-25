import { useMemo } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { PERMISSION_CODES, PERMISSION_MODULES } from "@/lib/permissions";
import { permissionLabel } from "@/lib/permissionLabels";
import type { AppRole } from "@/integrations/supabase/database.types";
import { useRolePermissions, useToggleRolePermission } from "@/hooks/useCustomRoles";

const APP_ROLES: AppRole[] = ["admin", "accountant", "collector", "readonly", "tenant"];

/**
 * مصفوفة صلاحيات الأدوار المدمجة القابلة للتعديل؛ دور المدير مقفل لأنه يملك كل الصلاحيات.
 */
export function BuiltInMatrixPanel() {
  const { t, locale } = useI18n();
  const rolePerms = useRolePermissions();
  const toggle = useToggleRolePermission();

  const map = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of rolePerms.data ?? []) {
      const s = m.get(r.role) ?? new Set<string>();
      s.add(r.permission_code);
      m.set(r.role, s);
    }
    return m;
  }, [rolePerms.data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.rolesPermissions")}</CardTitle>
        <CardDescription>{t("rolesSettings.togglePermissionsPerBuiltIn")}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table dir={locale === "ar" ? "rtl" : "ltr"}>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[220px]">{t("rolesSettings.permission")}</TableHead>
              {APP_ROLES.map((role) => (
                <TableHead key={role} className="text-center">
                  {t(`roles.${role}`)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {PERMISSION_MODULES.flatMap((mod) =>
              PERMISSION_CODES.filter((c) => c.startsWith(`${mod}.`)),
            )
              .concat(
                PERMISSION_CODES.filter(
                  (c) => !PERMISSION_MODULES.some((m) => c.startsWith(`${m}.`)),
                ),
              )
              .map((code) => (
                <TableRow key={code}>
                  <TableCell>
                    <span className="block text-xs">{permissionLabel(code, locale)}</span>
                    <span className="font-mono text-xs text-muted-foreground">{code}</span>
                  </TableCell>
                  {APP_ROLES.map((role) => {
                    const isAdmin = role === "admin";
                    const checked = isAdmin || map.get(role)?.has(code) || false;
                    return (
                      <TableCell key={role} className="text-center">
                        <Checkbox
                          checked={checked}
                          disabled={isAdmin || toggle.isPending}
                          onCheckedChange={async (v) => {
                            try {
                              await toggle.mutateAsync({
                                role,
                                code,
                                enable: v === true,
                              });
                            } catch (err) {
                              toast.error(extractErrorMessage(err));
                            }
                          }}
                        />
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
