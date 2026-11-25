import { useState } from "react";
import { toast } from "sonner";

import {
  useOptionListValueUsage,
  useRenameOptionListValue,
  useUpdateOptionListItem,
  type OptionListItem,
} from "@/hooks/useOptionLists";
import { useI18n } from "@/i18n/provider";

/** حالة تعديل صف: العنصر نفسه مع القيمة المخزّنة لحظة بدء التعديل. */
interface EditingState {
  item: OptionListItem;
  /** القيمة المخزّنة عند بدء التعديل — منها يُشتق طور الحفظ (إعادة تسمية أم بيانات وصفية). */
  originalValue: string;
}

/** معاينة إعادة التسمية: القيم القديمة والجديدة وأعداد السجلات المتأثرة. */
interface RenamePreview {
  oldValue: string;
  newValue: string;
  counts: Record<string, number>;
}

/**
 * يحوّل رمز خطأ دالة إعادة التسمية إلى رسالة مترجمة للمشرف.
 *
 * The RPC signals refusals with SQLSTATEs (23505 duplicate, 22023 refused
 * list or code-bound value, 42501 no permission); showing the raw English
 * message from Postgres would leave an Arabic-first admin guessing.
 */
function renameErrorMessage(error: unknown, t: (key: string) => string): string {
  switch ((error as { code?: string }).code) {
    case "23505":
      return t("lists.renameValueDuplicate");
    case "22023":
      return t("lists.renameValueRefused");
    case "42501":
      return t("lists.renameValueForbidden");
    default:
      return (error as Error).message;
  }
}

/**
 * يدير تعديل صف قائمة على طورين: إعادة تسمية القيمة ثم حفظ الأسماء والترتيب.
 *
 * The pending phase is derived from `item.value` vs `originalValue`, so no
 * extra state can drift: once a rename commits, `originalValue` moves to the
 * new value and a retry after a failed label save runs the metadata phase only.
 */
export function useListValueRenameFlow({
  refetchItems,
  validateValue,
}: {
  refetchItems: () => Promise<unknown>;
  /** يعيد رسالة خطأ للقيمة أو null إن كانت صالحة لهذه القائمة. */
  validateValue: (value: string) => string | null;
}) {
  const { t } = useI18n();
  const updateItem = useUpdateOptionListItem();
  const usage = useOptionListValueUsage();
  const rename = useRenameOptionListValue();
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [renamePreview, setRenamePreview] = useState<RenamePreview | null>(null);

  /**
   * يحدّث بيانات الصف الوصفية (الأسماء والترتيب والحالة) بلا value.
   *
   * On failure the items are refetched because the update may have committed
   * before its separate audit request failed (useOptionLists update mutation).
   */
  async function saveMetadata(item: OptionListItem, renamedNow: boolean) {
    try {
      await updateItem.mutateAsync({
        id: item.id,
        updates: {
          label_ar: item.label_ar,
          label_en: item.label_en,
          sort_order: item.sort_order,
          is_active: item.is_active,
        },
      });
      toast.success(t("phase2.saved"));
      setEditing(null);
    } catch (error) {
      await refetchItems();
      toast.error(renamedNow ? t("lists.renameValueLabelsNotSaved") : (error as Error).message);
    }
  }

  /**
   * يبدأ الحفظ: يتحقق من الحقول ثم إما يحفظ البيانات الوصفية مباشرة أو يعرض
   * معاينة إعادة التسمية؛ الحفظ الفعلي للقيمة لا يبدأ إلا باعتماد الحوار.
   */
  async function saveEdit() {
    if (!editing) return;
    const { item, originalValue } = editing;
    const newValue = item.value.trim();
    if (!newValue || !item.label_ar.trim() || !item.label_en.trim()) {
      toast.error(t("lists.validationRequired"));
      return;
    }
    const valueError = validateValue(newValue);
    if (valueError) {
      toast.error(valueError);
      return;
    }
    if (newValue === originalValue) {
      await saveMetadata(item, false);
      return;
    }
    try {
      const counts = await usage.mutateAsync(item.id);
      setRenamePreview({ oldValue: originalValue, newValue, counts });
    } catch (error) {
      toast.error(renameErrorMessage(error, t));
    }
  }

  /**
   * ينفّذ إعادة التسمية بعد اعتماد الحوار ثم ينتقل مباشرة إلى حفظ البيانات
   * الوصفية؛ نقل القيمة الأصلية هنا يمنع أي إعادة لاحقة لتشغيل الـ RPC.
   */
  async function confirmRename() {
    if (!editing || !renamePreview) return;
    const { item } = editing;
    try {
      await rename.mutateAsync({ itemId: item.id, newValue: renamePreview.newValue });
    } catch (error) {
      toast.error(renameErrorMessage(error, t));
      setRenamePreview(null);
      return;
    }
    setEditing({
      item: { ...item, value: renamePreview.newValue },
      originalValue: renamePreview.newValue,
    });
    setRenamePreview(null);
    await saveMetadata(item, true);
  }

  const renamePhasePending =
    editing !== null && editing.item.value.trim() !== editing.originalValue;

  return {
    editing,
    startEdit: (item: OptionListItem) => setEditing({ item, originalValue: item.value }),
    updateEditing: (patch: Partial<OptionListItem>) =>
      setEditing((current) =>
        current ? { ...current, item: { ...current.item, ...patch } } : current,
      ),
    cancelEdit: () => setEditing(null),
    saveEdit,
    savePending: renamePhasePending
      ? usage.isPending || rename.isPending || updateItem.isPending
      : updateItem.isPending,
    renamePreview,
    renamePending: rename.isPending,
    confirmRename,
    cancelRename: () => setRenamePreview(null),
  };
}
