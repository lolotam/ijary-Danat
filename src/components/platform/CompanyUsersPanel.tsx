import { useCallback, useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import {
  createPlatformCompanyUser,
  fetchPlatformCompanyUsers,
  platformErrorMessage,
  resetPlatformCompanyUserPassword,
  setPlatformCompanyUserActive,
} from "@/platform/platformFns";
import type { PlatformStaffRole, PlatformUserSummary } from "@/platform/users";

/** ما يعرضه لوحة حسابات الشركة. */
export interface CompanyUsersPanelProps {
  companyId: string;
}

/** الأدوار التي يمنحها المشرف العام، مع مفتاح ترجمة كل منها. */
const STAFF_ROLES: ReadonlyArray<{ role: PlatformStaffRole; labelKey: string }> = [
  { role: "admin", labelKey: "platformCompaniesUi.users.role.admin" },
  { role: "accountant", labelKey: "platformCompaniesUi.users.role.accountant" },
  { role: "collector", labelKey: "platformCompaniesUi.users.role.collector" },
  { role: "readonly", labelKey: "platformCompaniesUi.users.role.readonly" },
];

/** حقول نموذج إنشاء حساب. */
interface UserForm {
  fullName: string;
  username: string;
  email: string;
  phone: string;
  role: PlatformStaffRole;
}

/** نموذج فارغ، حتى لا تتسرّب قيمة حقل إلى الحساب التالي. */
const EMPTY_FORM: UserForm = {
  fullName: "",
  username: "",
  email: "",
  phone: "",
  role: "readonly",
};

/**
 * لوحة حسابات الشركة: إنشاء حساب، وإيقافه أو تفعيله، وإعادة تعيين كلمة مروره.
 *
 * The temporary password is shown once, in this panel, and cleared when the
 * panel is left: it is never written to a row, so there is nowhere else to
 * read it from.
 */
export function CompanyUsersPanel({ companyId }: CompanyUsersPanelProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<PlatformUserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<PlatformUserSummary | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);

  /** يقرأ حسابات الشركة ويعرضها. */
  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchPlatformCompanyUsers({ companyId });
      setRows(result.rows);
      setError(null);
    } catch (cause) {
      setError(platformErrorMessage(t, cause));
    } finally {
      setLoading(false);
    }
  }, [companyId, t]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  /** يضع قيمة حقل نصي من نموذج الإنشاء. */
  function setTextField(field: "fullName" | "username" | "email" | "phone", value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  /** يضع دور الحساب الجديد، من الأدوار التي يعرضها النموذج وحدها. */
  function setRole(role: PlatformStaffRole) {
    setForm((current) => ({ ...current, role }));
  }

  /** يوقّف حساباً أو يعيد تفعيله. */
  async function toggleActive(user: PlatformUserSummary) {
    setActionError(null);
    try {
      await setPlatformCompanyUserActive({
        companyId,
        userId: user.id,
        isActive: !user.isActive,
      });
      await loadUsers();
    } catch (cause) {
      setActionError(platformErrorMessage(t, cause));
    }
  }

  /** ينشئ حساباً جديداً ويعرض كلمة المرور المؤقتة مرة واحدة. */
  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const result = await createPlatformCompanyUser({
        companyId,
        fullName: form.fullName,
        username: form.username || null,
        email: form.email || null,
        phone: form.phone || null,
        role: form.role,
      });
      setTempPassword(result.tempPassword);
      setCopied(false);
      setForm(EMPTY_FORM);
      setCreateOpen(false);
      await loadUsers();
    } catch (cause) {
      setCreateError(platformErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  }

  /** يعيد تعيين كلمة مرور الحساب ويعرض الكلمة المؤقتة مرة واحدة. */
  async function confirmResetPassword() {
    if (!resetTarget) return;
    setActionError(null);
    setBusy(true);
    try {
      const result = await resetPlatformCompanyUserPassword({
        companyId,
        userId: resetTarget.id,
      });
      setTempPassword(result.tempPassword);
      setCopied(false);
      setResetTarget(null);
      await loadUsers();
    } catch (cause) {
      setActionError(platformErrorMessage(t, cause));
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
      setActionError(platformErrorMessage(t, cause));
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("platformCompaniesUi.users.title")}</h2>
        <Button type="button" variant="outline" onClick={() => setCreateOpen(true)}>
          {t("platformCompaniesUi.users.create")}
        </Button>
      </header>

      {tempPassword ? (
        <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-4">
          <p className="text-sm font-medium">{t("platformCompaniesUi.users.tempPassword")}</p>
          <code
            dir="ltr"
            className="block select-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
          >
            {tempPassword}
          </code>
          <p className="text-xs text-muted-foreground">
            {t("platformCompaniesUi.users.tempPasswordWarning")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyTempPassword(tempPassword)}
            >
              {t("platformCompaniesUi.users.copy")}
            </Button>
            {copied ? (
              <span role="status" className="text-xs text-muted-foreground">
                {t("platformCompaniesUi.users.copied")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {actionError ? (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("common.loading")}
        </p>
      ) : error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("platformCompaniesUi.users.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.name")}</TableHead>
                <TableHead>{t("platformCompaniesUi.users.role")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("platformCompaniesUi.column.created")}</TableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <span className="block font-medium">
                      {row.displayName ?? row.username ?? "—"}
                    </span>
                    {row.mustChangePassword ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("platformCompaniesUi.users.mustChange")}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.roles
                      .map((role) => t(`platformCompaniesUi.users.role.${role}`))
                      .join("، ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.isActive ? "success" : "warning"}>
                      {row.isActive
                        ? t("platformCompaniesUi.users.active")
                        : t("platformCompaniesUi.users.inactive")}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">
                    <time dateTime={row.createdAt}>{row.createdAt.slice(0, 10)}</time>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void toggleActive(row)}
                      >
                        {row.isActive
                          ? t("platformCompaniesUi.users.deactivate")
                          : t("platformCompaniesUi.users.activate")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setResetTarget(row)}
                      >
                        {t("platformCompaniesUi.users.resetPassword")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next);
          if (!next) {
            setCreateError(null);
            setForm(EMPTY_FORM);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("platformCompaniesUi.users.create.title")}</DialogTitle>
            <DialogDescription>
              {t("platformCompaniesUi.users.tempPasswordWarning")}
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleCreate}>
            <div className="grid gap-1.5">
              <Label htmlFor="platform-user-full-name" required>
                {t("platformCompaniesUi.users.create.fullName")}
              </Label>
              <Input
                id="platform-user-full-name"
                value={form.fullName}
                onChange={(event) => setTextField("fullName", event.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="platform-user-username">
                  {t("platformCompaniesUi.users.create.username")}
                </Label>
                <Input
                  id="platform-user-username"
                  dir="ltr"
                  value={form.username}
                  onChange={(event) => setTextField("username", event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="platform-user-email">
                  {t("platformCompaniesUi.users.create.email")}
                </Label>
                <Input
                  id="platform-user-email"
                  type="email"
                  value={form.email}
                  onChange={(event) => setTextField("email", event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="platform-user-phone">
                  {t("platformCompaniesUi.users.create.phone")}
                </Label>
                <Input
                  id="platform-user-phone"
                  type="tel"
                  value={form.phone}
                  onChange={(event) => setTextField("phone", event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="platform-user-role" required>
                {t("platformCompaniesUi.users.create.role")}
              </Label>
              <Select
                value={form.role}
                onValueChange={(value) => {
                  const match = STAFF_ROLES.find((entry) => entry.role === value);
                  if (match) setRole(match.role);
                }}
              >
                <SelectTrigger id="platform-user-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STAFF_ROLES.map((entry) => (
                    <SelectItem key={entry.role} value={entry.role}>
                      {t(entry.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {createError ? (
              <p className="text-sm text-destructive" role="alert">
                {createError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy
                  ? t("platformCompaniesUi.users.create.submitting")
                  : t("platformCompaniesUi.users.create.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={resetTarget !== null}
        onOpenChange={(next) => {
          if (!next) setResetTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("platformCompaniesUi.users.password.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("platformCompaniesUi.users.password.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">{t("common.cancel")}</Button>
            </AlertDialogCancel>
            <Button
              onClick={() => void confirmResetPassword()}
              disabled={busy || resetTarget === null}
            >
              {t("common.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
