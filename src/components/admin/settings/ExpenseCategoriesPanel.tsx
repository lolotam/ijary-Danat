import { useState } from "react";
import { Plus, Pencil, Trash2, Save, X } from "lucide-react";
import { toast } from "sonner";

import { TableState } from "@/components/admin/Phase2Ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useCreateExpenseCategory,
  useDeleteExpenseCategory,
  useExpenseCategories,
  useUpdateExpenseCategory,
  type ExpenseCategory,
} from "@/hooks/useExpenses";
import type { OptionList } from "@/hooks/useOptionLists";
import { useI18n } from "@/i18n/provider";
import { emptyDraft, type ItemDraft } from "./listItemDraft";

/**
 * يدير فئات المصروفات مباشرة من جدول expense_categories.
 *
 * The "Expense categories" catalog is backed by the real
 * public.expense_categories table (expenses reference it by category_id),
 * not by option_list_items — so this panel manages that table directly.
 * Toggling a category inactive removes it from the Add-expense dropdown.
 */
export function ExpenseCategoriesPanel({ list }: { list: OptionList }) {
  const { t } = useI18n();
  const categories = useExpenseCategories();
  const createCategory = useCreateExpenseCategory();
  const updateCategory = useUpdateExpenseCategory();
  const deleteCategory = useDeleteExpenseCategory();
  const [draft, setDraft] = useState<ItemDraft>(emptyDraft);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function saveNew() {
    if (!draft.value.trim() || !draft.label_ar.trim()) {
      toast.error(t("lists.validationRequired"));
      return;
    }
    try {
      await createCategory.mutateAsync({
        code: draft.value.trim(),
        name_ar: draft.label_ar.trim(),
        name_en: draft.label_en.trim() || null,
        sort_order: draft.sort_order,
        is_active: draft.is_active,
      });
      toast.success(t("phase2.saved"));
      setDraft(emptyDraft);
      setShowAdd(false);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      await updateCategory.mutateAsync({
        id: editing.id,
        updates: {
          code: editing.code,
          name_ar: editing.name_ar,
          name_en: editing.name_en,
          sort_order: editing.sort_order,
          is_active: editing.is_active,
        },
      });
      toast.success(t("phase2.saved"));
      setEditing(null);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  async function remove(category: ExpenseCategory) {
    // `expenses.category_id` is ON DELETE SET NULL, so this never fails — it
    // quietly un-categorises past expenses instead. Saying so is the whole
    // point of the warning: the destructive part is invisible otherwise.
    const message = category.is_system
      ? `${t("lists.systemCategoryDeleteWarning")}\n\n${t("phase2.deleteDescription")}`
      : t("phase2.deleteDescription");
    if (!confirm(message)) return;
    try {
      await deleteCategory.mutateAsync(category);
      toast.success(t("phase2.deleted"));
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">{list.name_ar}</CardTitle>
          <CardDescription>{list.name_en}</CardDescription>
        </div>
        <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
          <Plus className="size-4" /> {t("lists.addItem")}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {showAdd && (
          <div className="grid gap-3 border-b bg-muted/30 p-4 sm:grid-cols-5">
            <div>
              <Label required className="text-xs">
                {t("lists.value")}
              </Label>
              <Input
                value={draft.value}
                onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
              />
            </div>
            <div>
              <Label required className="text-xs">
                {t("common.nameAr")}
              </Label>
              <Input
                value={draft.label_ar}
                onChange={(e) => setDraft((d) => ({ ...d, label_ar: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">{t("common.nameEn")}</Label>
              <Input
                value={draft.label_en}
                onChange={(e) => setDraft((d) => ({ ...d, label_en: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">{t("lists.sortOrder")}</Label>
              <Input
                type="number"
                value={draft.sort_order}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, sort_order: Number(e.target.value) || 0 }))
                }
              />
            </div>
            <div className="flex items-end gap-2">
              <Button size="sm" onClick={saveNew} disabled={createCategory.isPending}>
                <Save className="size-4" /> {t("common.save")}
              </Button>
              <Button
                title={t("common.cancel")}
                aria-label={t("common.cancel")}
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(emptyDraft);
                  setShowAdd(false);
                }}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
        )}
        <TableState
          loading={categories.isLoading}
          error={Boolean(categories.error)}
          empty={!categories.data?.length}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>{t("lists.value")}</TableHead>
                <TableHead>{t("common.nameAr")}</TableHead>
                <TableHead>{t("common.nameEn")}</TableHead>
                <TableHead>{t("lists.sortOrder")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.data?.map((category, index) => {
                const isEditing = editing?.id === category.id;
                return (
                  <TableRow key={category.id}>
                    <TableCell>{index + 1}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {isEditing ? (
                        <Input
                          value={editing.code}
                          onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                        />
                      ) : (
                        <>
                          {category.code}
                          {category.is_system && (
                            <Badge className="ms-2" variant="outline">
                              {t("lists.system")}
                            </Badge>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Input
                          value={editing.name_ar}
                          onChange={(e) => setEditing({ ...editing, name_ar: e.target.value })}
                        />
                      ) : (
                        category.name_ar
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Input
                          value={editing.name_en ?? ""}
                          onChange={(e) =>
                            setEditing({ ...editing, name_en: e.target.value || null })
                          }
                        />
                      ) : (
                        (category.name_en ?? "—")
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Input
                          type="number"
                          value={editing.sort_order}
                          onChange={(e) =>
                            setEditing({ ...editing, sort_order: Number(e.target.value) || 0 })
                          }
                        />
                      ) : (
                        category.sort_order
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Switch
                          checked={editing.is_active}
                          onCheckedChange={(v) => setEditing({ ...editing, is_active: v })}
                        />
                      ) : (
                        <Badge variant={category.is_active ? "default" : "secondary"}>
                          {category.is_active ? t("lists.active") : t("lists.inactive")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        {isEditing ? (
                          <>
                            <Button
                              size="sm"
                              onClick={saveEdit}
                              title={t("common.save")}
                              aria-label={t("common.save")}
                            >
                              <Save className="size-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditing(null)}
                              title={t("common.cancel")}
                              aria-label={t("common.cancel")}
                            >
                              <X className="size-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              title={t("common.edit")}
                              aria-label={t("common.edit")}
                              size="sm"
                              variant="outline"
                              onClick={() => setEditing(category)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              title={t("common.delete")}
                              aria-label={t("common.delete")}
                              size="sm"
                              variant="destructive"
                              onClick={() => remove(category)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableState>
      </CardContent>
    </Card>
  );
}
