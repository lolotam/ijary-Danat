import { useMemo, useState } from "react";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import { PERMISSION_CODES } from "@/lib/permissions";
import { permissionLabel } from "@/lib/permissionLabels";
import { type CustomRoleWithPermissions } from "@/hooks/useCustomRoles";

export interface RoleFormValues {
  code: string;
  name_ar: string;
  name_en: string;
  description: string;
  is_active: boolean;
  permissions: string[];
}

/**
 * نافذة إنشاء/تعديل دور مخصص مع اختيار صلاحياته من مجمّع الصلاحيات.
 */
export function RoleEditorDialog({
  open,
  onOpenChange,
  editing,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: CustomRoleWithPermissions | null;
  onSubmit: (values: RoleFormValues) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [values, setValues] = useState<RoleFormValues>(() => ({
    code: "",
    name_ar: "",
    name_en: "",
    description: "",
    is_active: true,
    permissions: [],
  }));
  const [search, setSearch] = useState("");

  // Reset state when dialog opens
  useMemo(() => {
    if (open) {
      setValues(
        editing
          ? {
              code: editing.code,
              name_ar: editing.name_ar,
              name_en: editing.name_en,
              description: editing.description ?? "",
              is_active: editing.is_active,
              permissions: [...editing.permissions],
            }
          : {
              code: "",
              name_ar: "",
              name_en: "",
              description: "",
              is_active: true,
              permissions: [],
            },
      );
      setSearch("");
    }
  }, [open, editing]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<string, string[]>();
    for (const code of PERMISSION_CODES) {
      if (q && !code.toLowerCase().includes(q)) continue;
      const module = code.split(".")[0];
      const arr = map.get(module) ?? [];
      arr.push(code);
      map.set(module, arr);
    }
    return map;
  }, [search]);

  function toggle(code: string) {
    setValues((v) => ({
      ...v,
      permissions: v.permissions.includes(code)
        ? v.permissions.filter((c) => c !== code)
        : [...v.permissions, code],
    }));
  }
  function toggleModule(module: string, codes: string[]) {
    setValues((v) => {
      const allSelected = codes.every((c) => v.permissions.includes(c));
      const set = new Set(v.permissions);
      if (allSelected) codes.forEach((c) => set.delete(c));
      else codes.forEach((c) => set.add(c));
      return { ...v, permissions: Array.from(set) };
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? t("rolesSettings.editRole") : t("rolesSettings.newRole")}
          </DialogTitle>
          <DialogDescription>{t("rolesSettings.fillInTheDetailsAnd")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2" dir={locale === "ar" ? "rtl" : "ltr"}>
          <div>
            {/* Required on create only — the input is disabled while editing,
                and an asterisk on a field you cannot type into is an
                instruction the user cannot follow. */}
            <Label required={!editing}>{t("rolesSettings.code")}</Label>
            <Input
              value={values.code}
              disabled={!!editing}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  code: e.target.value.toLowerCase().replace(/\s+/g, "_"),
                }))
              }
              placeholder="e.g. property_manager"
            />
          </div>
          <div>
            <Label>{t("rolesSettings.status")}</Label>
            <div className="flex h-10 items-center gap-2">
              <Switch
                checked={values.is_active}
                onCheckedChange={(c) => setValues((v) => ({ ...v, is_active: c }))}
              />
              <span className="text-sm text-muted-foreground">
                {values.is_active ? t("rolesSettings.active") : t("rolesSettings.disabled")}
              </span>
            </div>
          </div>
          <div>
            <Label required>{t("rolesSettings.nameArabic")}</Label>
            <Input
              value={values.name_ar}
              onChange={(e) => setValues((v) => ({ ...v, name_ar: e.target.value }))}
            />
          </div>
          <div>
            <Label required>{t("rolesSettings.nameEnglish")}</Label>
            <Input
              value={values.name_en}
              onChange={(e) => setValues((v) => ({ ...v, name_en: e.target.value }))}
            />
          </div>
          <div className="md:col-span-2">
            <Label>{t("rolesSettings.description")}</Label>
            <Textarea
              value={values.description}
              onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
              rows={2}
            />
          </div>
        </div>

        <div className="space-y-3" dir={locale === "ar" ? "rtl" : "ltr"}>
          <div className="flex items-center justify-between gap-3">
            <Label className="text-base">
              {t("rolesSettings.permissionPool")}{" "}
              <Badge variant="secondary" className="ms-2">
                {values.permissions.length}/{PERMISSION_CODES.length}
              </Badge>
            </Label>
            <Input
              className="max-w-xs"
              placeholder={t("rolesSettings.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {Array.from(grouped.entries()).map(([module, codes]) => {
              const selectedInModule = codes.filter((c) => values.permissions.includes(c)).length;
              return (
                <div key={module} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => toggleModule(module, codes)}
                      className="flex items-center gap-2 text-sm font-semibold hover:text-primary"
                    >
                      <Shield className="h-4 w-4" />
                      {permissionLabel(`${module}.read`, locale).split(":")[0]}
                      <Badge variant="outline" className="ms-1">
                        {selectedInModule}/{codes.length}
                      </Badge>
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {codes.map((code) => (
                      <label key={code} className="flex cursor-pointer items-center gap-2 text-xs">
                        <Checkbox
                          checked={values.permissions.includes(code)}
                          onCheckedChange={() => toggle(code)}
                        />
                        <span>
                          {permissionLabel(code, locale)}
                          <span className="ms-2 font-mono text-muted-foreground">{code}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("rolesSettings.cancel")}
          </Button>
          <Button
            onClick={() => onSubmit(values)}
            disabled={
              !values.name_ar.trim() || !values.name_en.trim() || (!editing && !values.code.trim())
            }
          >
            {t("rolesSettings.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
