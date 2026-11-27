import { useState } from "react";

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
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { createPlatformCompany, platformErrorMessage } from "@/platform/platformFns";

/** ما يعرضه نافذة إنشاء شركة. */
export interface CompanyCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** يُستدعى بعد إنشاء الشركة، ليجدّد مشرف المنصة القائمة. */
  onCompanyCreated: (companyId: string) => void;
}

/** حقول نموذج إنشاء الشركة؛ كل الحقول نصوص. */
interface CompanyForm {
  nameAr: string;
  nameEn: string;
  slug: string;
  adminName: string;
  adminUsername: string;
  adminEmail: string;
  adminPhone: string;
}

/** نموذج فارغ، حتى لا تتسرّب قيمة حقل إلى الشركة التالية. */
const EMPTY_FORM: CompanyForm = {
  nameAr: "",
  nameEn: "",
  slug: "",
  adminName: "",
  adminUsername: "",
  adminEmail: "",
  adminPhone: "",
};

/**
 * الشكل المقبول للمعرّف المختصر.
 *
 * The server owns the rule (`src/platform/slug.ts`); this copy only lets the
 * screen refuse an obvious mistake before the request leaves the browser.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

/** نتيجة إنشاء شركة، كما تحملها كلمة المرور المؤقتة. */
interface CreatedCompany {
  companyId: string;
  host: string;
  tempPassword: string;
}

/**
 * نافذة إنشاء شركة بمديرها الأول.
 *
 * The temporary password is shown once, after the company exists, and is
 * cleared when the dialog closes: it is never written to a row, so the panel
 * could not show it a second time even if it wanted to.
 */
export function CompanyCreateDialog({
  open,
  onOpenChange,
  onCompanyCreated,
}: CompanyCreateDialogProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<CompanyForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [slugInvalid, setSlugInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedCompany | null>(null);
  const [copied, setCopied] = useState(false);

  /** يضع قيمة حقل واحد من نموذج الإنشاء. */
  function setField(field: keyof CompanyForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  /** يفرّغ النموذج ونتيجة الإنشاء، فتبقى كلمة المرور المؤقتة لن تُعرض ثانية. */
  function resetDialog() {
    setForm(EMPTY_FORM);
    setCreated(null);
    setCopied(false);
    setError(null);
    setSlugInvalid(false);
  }

  /** يتابع فتح النافذة وإغلاقها، ويمسح ما لا يجوز عرضه مرة أخرى. */
  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      resetDialog();
    }
  }

  /**
   * ينشئ الشركة، ويعرض كلمة المرور المؤقتة لمديرها الأول.
   */
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!SLUG_PATTERN.test(form.slug)) {
      setSlugInvalid(true);
      return;
    }
    setSlugInvalid(false);
    setBusy(true);

    try {
      const result = await createPlatformCompany({
        nameAr: form.nameAr,
        nameEn: form.nameEn,
        slug: form.slug,
        firstAdmin: {
          fullName: form.adminName,
          username: form.adminUsername || null,
          email: form.adminEmail || null,
          phone: form.adminPhone || null,
        },
      });

      setCreated(result);
      onCompanyCreated(result.companyId);
    } catch (cause) {
      setError(platformErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  }

  /**
   * ينسخ كلمة المرور المؤقتة إلى حافظة المتصفح.
   */
  async function copyTempPassword(password: string) {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch (cause) {
      setError(platformErrorMessage(t, cause));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("platformCompaniesUi.create.title")}</DialogTitle>
          <DialogDescription>{t("platformCompaniesUi.create.description")}</DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3 rounded-xl border border-warning/40 bg-warning/10 p-4">
            <p className="text-sm font-medium">{t("platformCompaniesUi.create.tempPassword")}</p>
            <code
              dir="ltr"
              className="block select-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
            >
              {created.tempPassword}
            </code>
            <p className="text-xs text-muted-foreground">
              {t("platformCompaniesUi.create.tempPasswordWarning")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyTempPassword(created.tempPassword)}
              >
                {t("platformCompaniesUi.create.copy")}
              </Button>
              {copied ? (
                <span role="status" className="text-xs text-muted-foreground">
                  {t("platformCompaniesUi.create.copied")}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("platformCompaniesUi.create.host")}:{" "}
              <code dir="ltr" className="font-mono">
                {created.host}
              </code>
            </p>
            <Button type="button" onClick={() => handleOpenChange(false)}>
              {t("platformCompaniesUi.create.done")}
            </Button>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="platform-company-name-ar" required>
                  {t("platformCompaniesUi.create.nameAr")}
                </Label>
                <Input
                  id="platform-company-name-ar"
                  value={form.nameAr}
                  onChange={(event) => setField("nameAr", event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="platform-company-name-en" required>
                  {t("platformCompaniesUi.create.nameEn")}
                </Label>
                <Input
                  id="platform-company-name-en"
                  dir="ltr"
                  value={form.nameEn}
                  onChange={(event) => setField("nameEn", event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="platform-company-slug" required>
                {t("platformCompaniesUi.create.slug")}
              </Label>
              <Input
                id="platform-company-slug"
                dir="ltr"
                value={form.slug}
                onChange={(event) => setField("slug", event.target.value)}
                aria-invalid={slugInvalid}
              />
              <p className="text-xs text-muted-foreground">
                {t("platformCompaniesUi.create.slugHint")}
              </p>
              {slugInvalid ? (
                <p className="text-xs text-destructive" role="alert">
                  {t("platformCompaniesUi.create.slugInvalid")}
                </p>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="platform-company-admin-name" required>
                {t("platformCompaniesUi.create.adminName")}
              </Label>
              <Input
                id="platform-company-admin-name"
                value={form.adminName}
                onChange={(event) => setField("adminName", event.target.value)}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="platform-company-admin-username">
                  {t("platformCompaniesUi.create.adminUsername")}
                </Label>
                <Input
                  id="platform-company-admin-username"
                  dir="ltr"
                  value={form.adminUsername}
                  onChange={(event) => setField("adminUsername", event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="platform-company-admin-email">
                  {t("platformCompaniesUi.create.adminEmail")}
                </Label>
                <Input
                  id="platform-company-admin-email"
                  type="email"
                  value={form.adminEmail}
                  onChange={(event) => setField("adminEmail", event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="platform-company-admin-phone">
                  {t("platformCompaniesUi.create.adminPhone")}
                </Label>
                <Input
                  id="platform-company-admin-phone"
                  type="tel"
                  value={form.adminPhone}
                  onChange={(event) => setField("adminPhone", event.target.value)}
                />
              </div>
            </div>

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy
                  ? t("platformCompaniesUi.create.submitting")
                  : t("platformCompaniesUi.create.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
