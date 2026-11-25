import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute } from "@tanstack/react-router";
import { Download, FileSpreadsheet, Plus, Tags, Upload } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { CsvImportDialog } from "@/components/admin/CsvImportDialog";
import { DeleteConfirmation, ModuleHeader, Pager, TableState } from "@/components/admin/Phase2Ui";
import { ExpensesKpiCards } from "@/components/admin/ownedPageKpis";
import { SummaryCards } from "@/components/admin/SummaryCards";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { expenseStatusTone } from "@/lib/statusTone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCompany } from "@/hooks/useCompany";
import {
  useCreateExpense,
  useDeleteExpense,
  useExpenseCategories,
  useExpenseExport,
  useExpenses,
  useUpdateExpense,
  type Expense,
  type ExpenseWithRelations,
} from "@/hooks/useExpenses";
import { useExpensesSummary } from "@/hooks/useExpensesSummary";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperties } from "@/hooks/useProperties";
import { useUnits } from "@/hooks/useUnits";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import { downloadCsv } from "@/lib/csv";
import { formatKwd } from "@/lib/money";
import { PERMISSIONS } from "@/lib/permissions";
import { sortPropertiesByCodeNatural } from "@/lib/propertyDisplayName";
import { downloadXls } from "@/lib/xlsx";
import { AllFilterSelect } from "@/components/admin/FieldControls";
import { CategoryEditor, CategoryManager } from "@/components/admin/expenses/ExpenseCategories";
import { ExpenseFormDialog } from "@/components/admin/expenses/ExpenseFormDialog";
import {
  EXPENSE_STATUSES,
  emptyExpense,
  expensePayload,
  expenseSchema,
  expenseToForm,
  type ExpenseForm,
} from "@/lib/expenseForm";

export const Route = createFileRoute("/admin/expenses")({ component: ExpensesPage });

/**
 * شاشة المصروفات: الفلاتر، الجدول، التصدير، والإضافة والتعديل والحذف.
 *
 * The add/edit dialog, the category manager and the form's schema and
 * mappings live in `components/admin/expenses/` and `lib/expenseForm.ts`
 * (audit M13/M32); the page keeps the form, the record being edited and the
 * save, because a save keeps the dialog open.
 */
function ExpensesPage() {
  const { locale, t } = useI18n();
  const permissions = usePermissions();
  const { isCardVisible } = useCardVisibility();
  const company = useCompany();
  const categories = useExpenseCategories(permissions.can(PERMISSIONS.EXPENSES_READ));
  const properties = useProperties({ page: 1, pageSize: 500 });
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [categoryFilter, setCategoryFilter] = useState<string>();
  const [propertyFilter, setPropertyFilter] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<Expense["status"] | undefined>();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const filters = {
    search: debouncedSearch,
    categoryId: categoryFilter,
    propertyId: propertyFilter,
    status: statusFilter,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const expenses = useExpenses(
    { ...filters, page, pageSize: 10 },
    permissions.can(PERMISSIONS.EXPENSES_READ),
  );
  const summary = useExpensesSummary(filters, permissions.can(PERMISSIONS.EXPENSES_READ));
  const exportRows = useExpenseExport(filters, permissions.can(PERMISSIONS.EXPENSES_EXPORT));
  const [formOpen, setFormOpen] = useState(false);
  const [target, setTarget] = useState<ExpenseWithRelations | null>(null);
  /**
   * معرّف المصروف الذي أنشأه هذا النموذج، ليصبح الحفظ التالي تعديلًا لا إضافة.
   *
   * Not `setTarget(saved)`: `target` is an `ExpenseWithRelations` and the
   * mutation returns a bare `Expense`, so assigning it would not typecheck.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [inlineCategory, setInlineCategory] = useState(false);
  const form = useForm<ExpenseForm>({
    resolver: zodResolver(expenseSchema),
    defaultValues: emptyExpense(),
  });
  const propertyId = form.watch("property_id");
  const units = useUnits({
    page: 1,
    pageSize: 500,
    propertyId: propertyId || undefined,
  });
  const {
    sort,
    toggle,
    sorted: sortedExpenses,
  } = useTableSort(expenses.data?.items ?? [], (expense, key) => {
    switch (key) {
      case "category":
        return expense.category?.name_ar ?? null;
      case "location":
        return expense.property?.code ?? null;
      default:
        return (expense as unknown as Record<string, unknown>)[key];
    }
  });
  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense();
  const deleteExpense = useDeleteExpense();

  if (!permissions.can(PERMISSIONS.EXPENSES_READ)) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  const resetPage = () => setPage(1);
  const openForm = (expense?: ExpenseWithRelations) => {
    setTarget(expense ?? null);
    setCreatedId(null);
    setAttachment(null);
    form.reset(expense ? expenseToForm(expense) : emptyExpense());
    setFormOpen(true);
  };

  const save = form.handleSubmit(async (values) => {
    const payload = expensePayload(values, { companyId: company.data?.id ?? null, attachment });
    // Coalesced before the branch: the form stays open after a create and
    // `target` is still null then, so the next Save must update the expense
    // this one recorded rather than record a second.
    const editingId = target?.id ?? createdId;
    try {
      if (editingId) await updateExpense.mutateAsync({ id: editingId, updates: payload });
      else {
        const created = await createExpense.mutateAsync(payload);
        setCreatedId(created.id);
      }
      form.reset(values);
      // The upload lives outside the form, so `form.reset` does not clear it.
      // Leaving it set would re-upload the same file on the next Save and
      // repoint attachment_path at a fresh copy — closing the dialog used to
      // clear it by unmounting.
      setAttachment(null);
      toast.success(t("common.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  });

  const exportData = (exportRows.data?.items ?? []).map((expense) => ({
    code: expense.code,
    payee: expense.payee ?? "",
    category:
      locale === "ar"
        ? (expense.category?.name_ar ?? "")
        : (expense.category?.name_en ?? expense.category?.name_ar ?? ""),
    amount: expense.amount,
    currency: expense.currency,
    property: expense.property?.code ?? "",
    unit: expense.unit?.code ?? "",
    cost_center: expense.cost_center ?? "",
    expense_date: expense.expense_date,
    status: t(`expenseStatus.${expense.status}`),
    recurrence: expense.recurrence ? t(`recurrence.${expense.recurrence}`) : "",
    note: expense.note ?? "",
  }));
  const exportHeaders = Object.keys(exportData[0] ?? {});
  const relationLabel = (expense: ExpenseWithRelations) =>
    [expense.property?.code, expense.unit?.code].filter(Boolean).join(" / ") || "—";

  return (
    <div className="space-y-6">
      <ModuleHeader
        title={t("expenses.title")}
        subtitle={t("expenses.subtitle")}
        actions={
          <>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.EXPENSES_EXPORT) || !exportData.length}
              onClick={() => downloadCsv("expenses.csv", exportData, locale)}
            >
              <Download className="size-4" />
              {t("export.csv")}
            </Button>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.EXPENSES_EXPORT) || !exportData.length}
              onClick={() =>
                downloadXls(
                  "expenses.xls",
                  exportHeaders,
                  exportData.map((row) =>
                    exportHeaders.map((header) => row[header as keyof typeof row]),
                  ),
                )
              }
            >
              <FileSpreadsheet className="size-4" />
              {t("export.xls")}
            </Button>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.EXPENSES_CREATE)}
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-4" />
              {t("common.import")}
            </Button>
            {permissions.can(PERMISSIONS.EXPENSES_CATEGORIES) && (
              <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
                <Tags className="size-4" />
                {t("expenses.categories")}
              </Button>
            )}
            <Button
              disabled={!permissions.can(PERMISSIONS.EXPENSES_CREATE)}
              onClick={() => openForm()}
            >
              <Plus className="size-4" />
              {t("expenses.add")}
            </Button>
          </>
        }
      />

      <SummaryCards loading={summary.isLoading} error={summary.error}>
        <ExpensesKpiCards summary={summary.data} isCardVisible={isCardVisible} />
      </SummaryCards>

      <Card>
        <CardHeader className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1">
            <Label>{t("common.search")}</Label>
            <Input
              value={search}
              placeholder={t("common.search")}
              onChange={(event) => {
                setSearch(event.target.value);
                resetPage();
              }}
            />
          </div>
          <AllFilterSelect
            value={categoryFilter ?? "all"}
            label={t("expenses.category")}
            options={(categories.data ?? []).map((value) => ({
              value: value.id,
              label: locale === "ar" ? value.name_ar : (value.name_en ?? value.name_ar),
            }))}
            onChange={(value) => {
              setCategoryFilter(value === "all" ? undefined : value);
              resetPage();
            }}
          />
          <AllFilterSelect
            value={propertyFilter ?? "all"}
            label={t("expenses.property")}
            options={sortPropertiesByCodeNatural(properties.data?.items ?? []).map((value) => ({
              value: value.id,
              label: `${value.code} — ${locale === "ar" ? value.name_ar : (value.name_en ?? value.name_ar)}`,
            }))}
            onChange={(value) => {
              setPropertyFilter(value === "all" ? undefined : value);
              resetPage();
            }}
          />
          <AllFilterSelect
            value={statusFilter ?? "all"}
            label={t("common.status")}
            options={EXPENSE_STATUSES.map((value) => ({
              value,
              label: t(`expenseStatus.${value}`),
            }))}
            onChange={(value) => {
              setStatusFilter(value === "all" ? undefined : (value as Expense["status"]));
              resetPage();
            }}
          />
          <div className="space-y-1">
            <Label>{t("common.from")}</Label>
            <DateInput
              value={dateFrom}
              onChange={(value) => {
                setDateFrom(value);
                resetPage();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("common.to")}</Label>
            <DateInput
              value={dateTo}
              onChange={(value) => {
                setDateTo(value);
                resetPage();
              }}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <TableState
            loading={expenses.isLoading}
            error={expenses.isError}
            empty={!expenses.data?.items.length}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                      {t("expenses.code")}
                    </SortableHead>
                    <SortableHead sortKey="payee" sort={sort} toggle={toggle}>
                      {t("expenses.payee")}
                    </SortableHead>
                    <SortableHead sortKey="category" sort={sort} toggle={toggle}>
                      {t("expenses.category")}
                    </SortableHead>
                    <SortableHead sortKey="amount" sort={sort} toggle={toggle}>
                      {t("common.amount")}
                    </SortableHead>
                    <SortableHead sortKey="location" sort={sort} toggle={toggle}>
                      {t("expenses.location")}
                    </SortableHead>
                    <SortableHead sortKey="expense_date" sort={sort} toggle={toggle}>
                      {t("expenses.date")}
                    </SortableHead>
                    <SortableHead sortKey="status" sort={sort} toggle={toggle}>
                      {t("common.status")}
                    </SortableHead>
                    <SortableHead sortKey="recurrence" sort={sort} toggle={toggle}>
                      {t("expenses.recurrence")}
                    </SortableHead>
                    <TableHead>{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedExpenses.map((expense, index) => (
                    <TableRow key={expense.id}>
                      <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
                      <TableCell className="font-mono">{expense.code}</TableCell>
                      <TableCell>{expense.payee ?? "—"}</TableCell>
                      <TableCell>
                        {locale === "ar"
                          ? (expense.category?.name_ar ?? "—")
                          : (expense.category?.name_en ?? expense.category?.name_ar ?? "—")}
                      </TableCell>
                      <TableCell className="font-medium">
                        {formatKwd(expense.amount, locale)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{relationLabel(expense)}</TableCell>
                      <TableCell>{expense.expense_date}</TableCell>
                      <TableCell>
                        <Badge variant={expenseStatusTone(expense.status)}>
                          {t(`expenseStatus.${expense.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {expense.recurrence ? t(`recurrence.${expense.recurrence}`) : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex">
                          <TableActionButton
                            action="edit"
                            disabled={!permissions.can(PERMISSIONS.EXPENSES_UPDATE)}
                            onClick={() => openForm(expense)}
                          />
                          <TableActionButton
                            action="delete"
                            disabled={!permissions.can(PERMISSIONS.EXPENSES_DELETE)}
                            onClick={() => setDeleteTarget(expense)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableState>
          <Pager page={page} pageSize={10} count={expenses.data?.count ?? 0} setPage={setPage} />
        </CardContent>
      </Card>

      <ExpenseFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        form={form}
        isEdit={Boolean(target)}
        categories={categories.data ?? []}
        properties={properties.data?.items ?? []}
        units={units.data?.items ?? []}
        canAddCategory={permissions.can(PERMISSIONS.EXPENSES_CATEGORIES)}
        onAddCategory={() => setInlineCategory(true)}
        onAttachment={setAttachment}
        onSubmit={save}
        pending={createExpense.isPending || updateExpense.isPending}
      />

      <CategoryManager
        open={categoriesOpen}
        onOpenChange={setCategoriesOpen}
        categories={categories.data ?? []}
      />
      <CategoryEditor open={inlineCategory} onOpenChange={setInlineCategory} />
      <CsvImportDialog entity="expenses" open={importOpen} onOpenChange={setImportOpen} />
      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={deleteExpense.isPending}
        title={t("common.delete")}
        description={t("expenses.deleteConfirm")}
        close={() => setDeleteTarget(null)}
        confirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteExpense.mutateAsync(deleteTarget);
            setDeleteTarget(null);
            toast.success(t("common.saved"));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
    </div>
  );
}
