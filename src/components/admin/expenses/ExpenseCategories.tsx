import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { DeleteConfirmation } from "@/components/admin/Phase2Ui";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCreateExpenseCategory,
  useDeleteExpenseCategory,
  useUpdateExpenseCategory,
  type ExpenseCategory,
} from "@/hooks/useExpenses";
import { useI18n } from "@/i18n/provider";
import { Field } from "@/components/admin/FieldControls";

/** حوار إضافة فئة مصروفات أو تعديلها. */
export function CategoryEditor({
  open,
  onOpenChange,
  category,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category?: ExpenseCategory;
}) {
  const { t } = useI18n();
  const createCategory = useCreateExpenseCategory();
  const updateCategory = useUpdateExpenseCategory();
  const [code, setCode] = useState(category?.code ?? "");
  const [nameAr, setNameAr] = useState(category?.name_ar ?? "");
  const [nameEn, setNameEn] = useState(category?.name_en ?? "");
  const save = async () => {
    try {
      if (category)
        await updateCategory.mutateAsync({
          id: category.id,
          updates: { code, name_ar: nameAr, name_en: nameEn || null },
        });
      else await createCategory.mutateAsync({ code, name_ar: nameAr, name_en: nameEn || null });
      toast.success(t("common.saved"));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("expenses.categoryEditor")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={t("expenses.categoryCode")}>
            <Input dir="ltr" value={code} onChange={(event) => setCode(event.target.value)} />
          </Field>
          <Field label={t("common.nameAr")}>
            <Input value={nameAr} onChange={(event) => setNameAr(event.target.value)} />
          </Field>
          <Field label={t("common.nameEn")}>
            <Input dir="ltr" value={nameEn} onChange={(event) => setNameEn(event.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!code.trim() || !nameAr.trim()} onClick={save}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** حوار إدارة فئات المصروفات: القائمة، والتعديل، والحذف مع تحذير الفئات المزروعة. */
export function CategoryManager({
  open,
  onOpenChange,
  categories,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: ExpenseCategory[];
}) {
  const { locale, t } = useI18n();
  const [editor, setEditor] = useState<ExpenseCategory | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExpenseCategory | null>(null);
  const deleteCategory = useDeleteExpenseCategory();
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("expenses.categories")}</DialogTitle>
          </DialogHeader>
          <div className="flex justify-end">
            <Button onClick={() => setEditor("new")}>
              <Plus className="size-4" />
              {t("expenses.addCategory")}
            </Button>
          </div>
          <div className="max-h-96 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("expenses.categoryCode")}</TableHead>
                  <TableHead>{t("common.name")}</TableHead>
                  <TableHead>{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((category) => (
                  <TableRow key={category.id}>
                    <TableCell className="font-mono">{category.code}</TableCell>
                    <TableCell>
                      {locale === "ar" ? category.name_ar : (category.name_en ?? category.name_ar)}
                      {category.is_system && (
                        <Badge className="ms-2" variant="secondary">
                          {t("expenses.system")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <TableActionButton action="edit" onClick={() => setEditor(category)} />
                      <TableActionButton
                        action="delete"
                        onClick={() => setDeleteTarget(category)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>
      {editor && (
        <CategoryEditor
          key={editor === "new" ? "new" : editor.id}
          open
          onOpenChange={(next) => !next && setEditor(null)}
          category={editor === "new" ? undefined : editor}
        />
      )}
      {/*
        Seeded categories delete like any other (migration 61); the extra line
        says what that costs, since `expenses.category_id` is ON DELETE SET NULL
        and the loss is otherwise invisible.
      */}
      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={deleteCategory.isPending}
        title={t("common.delete")}
        description={
          deleteTarget?.is_system
            ? `${t("lists.systemCategoryDeleteWarning")} ${t("expenses.deleteCategoryConfirm")}`
            : t("expenses.deleteCategoryConfirm")
        }
        close={() => setDeleteTarget(null)}
        confirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteCategory.mutateAsync(deleteTarget);
            setDeleteTarget(null);
            toast.success(t("common.saved"));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
    </>
  );
}
