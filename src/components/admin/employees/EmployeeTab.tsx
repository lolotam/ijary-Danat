import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Pager, TableState } from "@/components/admin/Phase2Ui";
import { CardField, MobileCardList } from "@/components/admin/MobileCardList";
import { TableActionButton } from "@/components/admin/TableActionButton";
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
import { LtrText } from "@/components/ui/ltr-text";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  useCreateEmployee,
  useDeleteEmployee,
  useEmployees,
  useUpdateEmployee,
  type Employee,
} from "@/hooks/useEmployees";
import { usePermissions } from "@/hooks/usePermissions";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import { formatAmount } from "@/lib/money";
import { PERMISSIONS } from "@/lib/permissions";

/** نموذج موظف فارغ لإضافة جديدة. */
const EMPTY_FORM = {
  name: "",
  name_en: "",
  nickname: "",
  mobile: "",
  email: "",
  salary: "",
  hired_on: "",
  notes: "",
  is_active: true,
};
type EmployeeForm = typeof EMPTY_FORM;

/**
 * تبويب الموظفين: القائمة، البحث، والإضافة والتعديل والحذف.
 *
 * Holds its fields in plain `useState`, not react-hook-form; a save keeps the
 * dialog open, so `createdId` turns the next Save into an update.
 */
export function EmployeeTab() {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const permissions = usePermissions();
  const canRead = permissions.can(PERMISSIONS.EMPLOYEES_READ);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const pageSize = 20;
  const employees = useEmployees(
    { includeInactive: true, page, pageSize, search: debouncedSearch },
    canRead,
  );
  const create = useCreateEmployee();
  const update = useUpdateEmployee();
  const remove = useDeleteEmployee();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  /**
   * معرّف الموظف الذي أنشأه هذا النموذج، ليصبح الحفظ التالي تعديلًا لا إضافة.
   *
   * This screen holds its fields in plain `useState`, not react-hook-form, so
   * there is no `form.reset` to call here — `openCreate`/`openEdit` already
   * seed `form`, and they clear this alongside it.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [form, setForm] = useState<EmployeeForm>(EMPTY_FORM);

  if (!canRead) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  /** يفتح النموذج فارغاً لإضافة موظف جديد. */
  function openCreate() {
    setEditing(null);
    setCreatedId(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  }

  /** يفتح النموذج معبّأً ببيانات الموظف المختار. */
  function openEdit(employee: Employee) {
    setEditing(employee);
    setCreatedId(null);
    setForm({
      name: employee.name,
      name_en: employee.name_en ?? "",
      nickname: employee.nickname ?? "",
      mobile: employee.mobile ?? "",
      email: employee.email ?? "",
      salary: String(employee.salary ?? ""),
      hired_on: employee.hired_on ?? "",
      notes: employee.notes ?? "",
      is_active: employee.is_active,
    });
    setOpen(true);
  }

  /** يحفظ الموظف: تعديل إن سبق إنشاؤه أو اختير، وإلا إضافة. */
  async function submit() {
    if (!form.name.trim()) {
      toast.error(t("employees.nameRequired"));
      return;
    }
    const salary = Number(form.salary || 0);
    if (!Number.isFinite(salary) || salary < 0) {
      toast.error(t("payments.invalidAmount"));
      return;
    }
    const payload = {
      name: form.name.trim(),
      name_en: form.name_en.trim() || null,
      nickname: form.nickname.trim() || null,
      mobile: form.mobile.trim() || null,
      email: form.email.trim() || null,
      salary,
      hired_on: form.hired_on || null,
      notes: form.notes.trim() || null,
      is_active: form.is_active,
    };
    // Coalesced before the branch: the dialog stays open after a create, and
    // `editing` is still null then, so the next Save must update the employee
    // this one added rather than add a second.
    const editingId = editing?.id ?? createdId;
    try {
      if (editingId) await update.mutateAsync({ id: editingId, updates: payload });
      else {
        const created = await create.mutateAsync(payload);
        setCreatedId(created.id);
      }
      toast.success(t("phase2.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  const rows = employees.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input
          className="max-w-sm"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder={t("common.search")}
        />
        {permissions.can(PERMISSIONS.EMPLOYEES_CREATE) && (
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            {t("employees.add")}
          </Button>
        )}
      </div>

      <TableState loading={employees.isLoading} error={employees.isError} empty={!rows.length}>
        {isMobile ? (
          <MobileCardList
            items={rows}
            keyFor={(employee) => employee.id}
            renderCard={(employee) => (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {locale === "en" ? (employee.name_en ?? employee.name) : employee.name}
                  </span>
                  <Badge variant={employee.is_active ? "secondary" : "outline"}>
                    {employee.is_active ? t("common.active") : t("common.inactive")}
                  </Badge>
                </div>
                <CardField label={t("employees.mobile")}>
                  <LtrText>{employee.mobile ?? "—"}</LtrText>
                </CardField>
                <CardField label={t("employees.salary")}>
                  <LtrText>{formatAmount(Number(employee.salary), locale)}</LtrText>
                </CardField>
                <div className="flex gap-1">
                  <TableActionButton
                    action="edit"
                    disabled={!permissions.can(PERMISSIONS.EMPLOYEES_UPDATE)}
                    onClick={() => openEdit(employee)}
                  />
                  <TableActionButton
                    action="delete"
                    disabled={!permissions.can(PERMISSIONS.EMPLOYEES_DELETE)}
                    onClick={() => remove.mutate(employee.id)}
                  />
                </div>
              </div>
            )}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.code")}</TableHead>
                <TableHead>{t("common.name")}</TableHead>
                <TableHead>{t("employees.mobile")}</TableHead>
                <TableHead>{t("employees.salary")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((employee) => (
                <TableRow key={employee.id}>
                  <TableCell className="font-mono text-xs">{employee.code}</TableCell>
                  <TableCell className="font-medium">
                    {locale === "en" ? (employee.name_en ?? employee.name) : employee.name}
                  </TableCell>
                  <TableCell>
                    <LtrText>{employee.mobile ?? "—"}</LtrText>
                  </TableCell>
                  <TableCell>
                    <LtrText>{formatAmount(Number(employee.salary), locale)}</LtrText>
                  </TableCell>
                  <TableCell>
                    <Badge variant={employee.is_active ? "secondary" : "outline"}>
                      {employee.is_active ? t("common.active") : t("common.inactive")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <TableActionButton
                        action="edit"
                        disabled={!permissions.can(PERMISSIONS.EMPLOYEES_UPDATE)}
                        onClick={() => openEdit(employee)}
                      />
                      <TableActionButton
                        action="delete"
                        disabled={!permissions.can(PERMISSIONS.EMPLOYEES_DELETE)}
                        onClick={() => remove.mutate(employee.id)}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableState>
      <Pager page={page} pageSize={pageSize} count={employees.data?.count ?? 0} setPage={setPage} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("employees.edit") : t("employees.add")}</DialogTitle>
            <DialogDescription>{t("employees.subtitle")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label required>{t("common.name")}</Label>
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("common.nameEn")}</Label>
              <Input
                value={form.name_en}
                onChange={(event) => setForm({ ...form, name_en: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("employees.nickname")}</Label>
              <Input
                value={form.nickname}
                onChange={(event) => setForm({ ...form, nickname: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("employees.mobile")}</Label>
              <Input
                type="tel"
                value={form.mobile}
                onChange={(event) => setForm({ ...form, mobile: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("employees.email")}</Label>
              <Input
                type="email"
                dir="ltr"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("employees.salary")}</Label>
              <Input
                type="number"
                step="0.001"
                min="0"
                value={form.salary}
                onChange={(event) => setForm({ ...form, salary: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("employees.hiredOn")}</Label>
              <Input
                type="date"
                value={form.hired_on}
                onChange={(event) => setForm({ ...form, hired_on: event.target.value })}
              />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch
                checked={form.is_active}
                onCheckedChange={(checked) => setForm({ ...form, is_active: checked })}
              />
              <Label>{t("employees.isActive")}</Label>
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>{t("common.notes")}</Label>
              <Input
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={create.isPending || update.isPending} onClick={submit}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
