import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import {
  FormComboboxField,
  FormSelectField,
  FormSwitchField,
  FormTextField,
  FormTriStateField,
} from "@/components/admin/Phase2FormFields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { useCompany } from "@/hooks/useCompany";
import { useListDrivenOptions } from "@/hooks/useOptionLists";
import { useCreateTenant, useUpdateTenant, type Tenant } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { NATIONALITIES } from "@/lib/nationalities";
import { PORTAL_TABS } from "@/lib/portalTabs";
import {
  buildTenantSubmitPayload,
  resolveTenantFormValues,
  tenantCategories,
  tenantFormDefaults,
  tenantFormSchema,
  type TenantFormValues,
} from "@/lib/tenantForm";
import { isTenantSavedAuditFailed, isTenantStaleSave } from "@/lib/tenantStaleSave";
import { showError } from "@/lib/toastError";

export type TenantFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create; set = edit. */
  editing: Tenant | null;
};

/**
 * حوار إنشاء/تعديل المستأجر — النموذج والحفظ يعيشان هنا حتى يبقى المسار للتنسيق فقط.
 *
 * The dialog stays open after a save. `createdId` is what makes the next Save
 * an update: `editing` is still null on the create path, and promoting it
 * would also require an active-location relation the create mutation does not
 * return.
 */
export function TenantFormDialog({ open, onOpenChange, editing }: TenantFormDialogProps) {
  const { t, locale } = useI18n();
  const company = useCompany();
  const create = useCreateTenant();
  const update = useUpdateTenant();
  const [createdId, setCreatedId] = useState<string | null>(null);
  // The `updated_at` revision the form was loaded from. It travels with the
  // save so a row someone else changed meanwhile is refused, not overwritten.
  const [revision, setRevision] = useState<string | null>(null);
  const form = useForm<TenantFormValues>({
    resolver: zodResolver(tenantFormSchema),
    defaultValues: tenantFormDefaults,
  });
  const categoryOptions = useListDrivenOptions(
    "tenant_categories",
    tenantCategories,
    "tenantCategory",
  );

  useEffect(() => {
    if (open) {
      // A reopened dialog is a fresh create until it saves again.
      setCreatedId(null);
      // The revision the form starts from — the save checks it before writing.
      setRevision(editing?.updated_at ?? null);
      form.reset(resolveTenantFormValues(editing));
    }
  }, [open, editing, form]);

  /**
   * يحفظ المستأجر: يضيف صفاً جديداً أو يعدّل الصف المفتوح / الذي أُنشئ للتو.
   *
   * The revision the form was loaded with goes along with the update, and the
   * saved row's new revision replaces it — so the next save from the same
   * dialog is guarded against whoever changed the tenant in between.
   */
  async function save(values: TenantFormValues) {
    const payload = buildTenantSubmitPayload(values, company.data?.id ?? null);
    const editingId = editing?.id ?? createdId;
    try {
      if (editingId) {
        const saved = await update.mutateAsync({
          id: editingId,
          updates: payload,
          expectedUpdatedAt: revision,
        });
        setRevision(saved.updated_at);
      } else {
        const created = await create.mutateAsync(payload);
        setCreatedId(created.id);
        setRevision(created.updated_at);
      }
      form.reset(values);
      toast.success(t("phase2.saved"));
    } catch (error) {
      // حُفظ المستأجر فعلاً ولم يُسجَّل تدقيقه: نأخذ المراجعة الجديدة حتى لا
      // يُرفَض الحفظ التالي كأنه قديم، ونُعلم المشغّل بأن التدقيق ناقص.
      // The tenant was saved and only the audit failed, so the new revision is
      // kept and the operator is told the audit log is missing the change.
      if (isTenantSavedAuditFailed(error)) {
        setRevision(error.tenant.updated_at);
        form.reset(values);
        toast.warning(t("tenants.savedAuditFailed"));
        return;
      }
      // Somebody else changed the tenant while the form was open: refuse the
      // save instead of writing our stale values over their change.
      if (isTenantStaleSave(error)) {
        toast.error(t("tenants.staleSave"));
        return;
      }
      showError(t("phase2.saveError"), error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? t("tenants.edit") : t("tenants.add")}</DialogTitle>
          <DialogDescription>{editing?.code ?? t("phase2.codeGenerated")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={form.handleSubmit(save)}
          >
            <FormTextField required control={form.control} name="name" label={t("common.nameAr")} />
            <FormTextField control={form.control} name="name_en" label={t("common.nameEn")} />
            <FormTextField
              control={form.control}
              name="owner_civil_id"
              label={t("tenants.ownerCivilId")}
            />
            <FormSelectField
              required
              control={form.control}
              name="category"
              label={t("tenants.category")}
              options={categoryOptions}
            />
            <FormComboboxField
              control={form.control}
              name="nationality"
              label={t("tenants.nationality")}
              options={NATIONALITIES.map((nationality) => ({
                value: nationality.value,
                label: locale === "ar" ? nationality.ar : nationality.en,
              }))}
              placeholder={t("common.select")}
              searchPlaceholder={t("common.search")}
              emptyText={t("common.noResults")}
            />
            <FormSelectField
              required
              control={form.control}
              name="preferred_language"
              label={t("tenants.language")}
              options={[
                { value: "ar", label: "العربية" },
                { value: "en", label: "English" },
              ]}
            />
            <FormTextField
              control={form.control}
              name="mobile"
              type="tel"
              label={t("tenants.mobile")}
            />
            <FormTextField
              control={form.control}
              name="whatsapp"
              type="tel"
              label={t("tenants.whatsapp")}
            />
            <FormTextField
              control={form.control}
              name="email"
              type="email"
              label={t("tenants.email")}
            />
            <FormTextField
              required
              control={form.control}
              name="commercial_name_ar"
              label={t("tenants.commercialNameAr")}
            />
            <FormTextField
              required
              control={form.control}
              name="commercial_name_en"
              label={t("tenants.commercialNameEn")}
            />
            <FormTextField
              control={form.control}
              name="authorized_manager"
              label={t("tenants.authorizedManager")}
            />
            <FormTextField
              control={form.control}
              name="authorized_manager_civil_id"
              label={t("tenants.authorizedManagerCivilId")}
            />
            <div className="sm:col-span-2 lg:col-span-3">
              <FormTextField
                control={form.control}
                name="commercial_address"
                label={t("tenants.commercialAddress")}
                multiline
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <div className="grid gap-4 rounded-xl border bg-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-4">
                <FormSwitchField
                  control={form.control}
                  name="reminders_enabled"
                  label={t("tenants.remindersEnable")}
                />
                <FormSwitchField
                  control={form.control}
                  name="receipt_visible_to_tenant"
                  label={t("tenants.receiptVisibleToTenant")}
                />
                <FormSwitchField
                  control={form.control}
                  name="tenant_portal_enabled"
                  label={t("tenants.portalEnable")}
                />
                <FormSwitchField
                  control={form.control}
                  name="notifications_paused"
                  label={t("tenants.notificationsPaused")}
                />
              </div>
            </div>
            {/* Per-tenant overrides of the tenant role's tab permissions. */}
            <div className="grid gap-3 sm:col-span-2 lg:col-span-3">
              <div>
                <p className="text-sm font-medium">{t("tenants.portalTabs.legend")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("tenants.portalTabs.hint")}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {PORTAL_TABS.map((tab) => (
                  <div key={tab.key} className="space-y-1">
                    <FormTriStateField
                      control={form.control}
                      name={tab.column}
                      label={t(tab.labelKey)}
                      inheritLabel={t("tenants.portalTabs.inherit")}
                      showLabel={t("tenants.portalTabs.show")}
                      hideLabel={t("tenants.portalTabs.hide")}
                    />
                    {tab.hintKey ? (
                      <p className="text-xs text-muted-foreground">{t(tab.hintKey)}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <FormTextField
                control={form.control}
                name="notes"
                label={t("common.notes")}
                multiline
              />
            </div>
            <DialogFooter className="sm:col-span-2 lg:col-span-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={create.isPending || update.isPending}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
