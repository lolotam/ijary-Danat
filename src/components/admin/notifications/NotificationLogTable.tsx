import { Ban, RotateCcw } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";

import { notificationLogColumns } from "@/components/admin/notifications/notificationLogColumns";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import type { NotificationWithRelations } from "@/hooks/useNotifications";
import { useI18n } from "@/i18n/provider";
import type { NotificationState } from "@/integrations/supabase/database.types";
import { notificationLogSortValue } from "@/lib/adminTableSortValues";

/**
 * جدول/بطاقات سجل الإشعارات — عرض واحد حسب العرض (useIsMobile).
 *
 * سطح المكتب: الجدول الكامل. الجوال: بطاقات معنونة من نفس واصف الأعمدة
 * حتى لا تتباعد العروض. الـ checkbox ورقم الصف والإجراءات خارج الحلقة
 * لأنها هيكلية وليست بيانات.
 */
export function NotificationLogTable({
  canDelete,
  selected,
  setSelected,
  page,
  pageSize,
  items,
  retryPending,
  onRetry,
  onCancel,
  stateVariant,
  stateBadgeClass,
}: {
  canDelete: boolean;
  selected: string[];
  setSelected: Dispatch<SetStateAction<string[]>>;
  page: number;
  pageSize: number;
  items: NotificationWithRelations[];
  retryPending: boolean;
  onRetry: (
    item: NotificationWithRelations,
    handlers: { onError: (error: Error) => void; onSuccess: () => void },
  ) => void;
  onCancel: (item: NotificationWithRelations) => void;
  stateVariant: (state: NotificationState) => "default" | "destructive" | "secondary";
  stateBadgeClass: (state: NotificationState) => string;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const columns = notificationLogColumns(t, stateVariant, stateBadgeClass);
  const { sort, toggle, sorted: sortedItems } = useTableSort(items, notificationLogSortValue);

  const allSelected = sortedItems.length > 0 && selected.length === sortedItems.length;

  /**
   * رقم الصف المعروض، مستمر عبر الصفحات لا مُعاد من ١ في كل صفحة.
   */
  function rowNumber(index: number): number {
    return (page - 1) * pageSize + index + 1;
  }

  /**
   * يبدّل تحديد صف واحد في قائمة الحذف الجماعي.
   */
  function toggleRow(id: string, checked: boolean | "indeterminate") {
    setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  /**
   * يحدّد كل صفوف الصفحة الحالية أو يفرّغ التحديد.
   */
  function toggleAll(checked: boolean | "indeterminate") {
    setSelected(checked ? sortedItems.map((n) => n.id) : []);
  }

  /**
   * أزرار إعادة المحاولة / إلغاء لطابور الإشعارات.
   *
   * `needs_review` is retryable on purpose. The drain job parks rows there for
   * conditions a human resolves outside IJARY — a quota that resets, an
   * administrator who re-authorizes — and their failure_reason tells staff to
   * re-queue afterwards. Without this button there was no way to do that, which
   * made a parked row harder to recover than an ordinary failure.
   */
  function RowActions({ item }: { item: NotificationWithRelations }) {
    return (
      <div className="flex">
        {["failed", "skipped", "needs_review"].includes(item.state) && (
          <Button
            title={t("notifications.retry")}
            size="icon"
            variant="ghost"
            className="pointer-coarse:size-11"
            disabled={retryPending}
            onClick={() =>
              onRetry(item, {
                onError: (error) => toast.error(error.message),
                onSuccess: () => toast.success(t("notifications.sent")),
              })
            }
          >
            <RotateCcw className="size-4" />
            <span className="sr-only">{t("notifications.retry")}</span>
          </Button>
        )}
        {item.state === "queued" && (
          <Button
            title={t("notifications.cancel")}
            size="icon"
            variant="ghost"
            className="text-destructive pointer-coarse:size-11"
            onClick={() => onCancel(item)}
          >
            <Ban className="size-4" />
            <span className="sr-only">{t("notifications.cancel")}</span>
          </Button>
        )}
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="space-y-3 p-3">
        {/* شريط التحديد الجماعي — ضروري على الهاتف لأن رأس الجدول غير ظاهر (A5). */}
        {canDelete && sortedItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
              <span>{t("common.selectAll")}</span>
            </label>
            {selected.length > 0 && (
              <>
                <span className="text-muted-foreground">
                  {t("inbox.selectedCount").replace("{{count}}", String(selected.length))}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                  {t("documents.clearSelection")}
                </Button>
              </>
            )}
          </div>
        )}
        {sortedItems.map((item, index) => (
          <article
            key={item.id}
            className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both space-y-3 rounded-xl border bg-card p-3 shadow-sm duration-300 motion-reduce:animate-none"
            style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {canDelete && (
                  // الـ Checkbox نفسه 16px؛ الغلاف هو هدف اللمس، ورقم الصف جزء
                  // من الاسم المنطوق.
                  // Selecting a row is the entry point to bulk delete, so on a
                  // phone it cannot be the smallest target on the card. The row
                  // number goes in the label because on a card there is no
                  // column header to give the checkbox context — without it a
                  // screen reader announces twenty identical "Select".
                  <label className="-m-2 flex size-11 cursor-pointer items-center justify-center p-2">
                    <Checkbox
                      checked={selected.includes(item.id)}
                      onCheckedChange={(v) => toggleRow(item.id, v)}
                      aria-label={`${t("common.select")} #${rowNumber(index)}`}
                    />
                  </label>
                )}
                <span className="text-muted-foreground tabular-nums text-sm">
                  #{rowNumber(index)}
                </span>
              </div>
              <RowActions item={item} />
            </div>
            <dl className="grid gap-2 text-sm">
              {columns.map((column) => (
                <div
                  key={column.key}
                  data-field={column.key}
                  className="grid grid-cols-[minmax(0,7.5rem)_1fr] gap-2 border-b border-border/60 pb-2 last:border-0 last:pb-0"
                >
                  <dt className="text-xs font-medium text-muted-foreground">{column.label}</dt>
                  <dd className="min-w-0 break-words" title={column.title?.(item)}>
                    {column.render(item)}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className="relative max-h-[min(70vh,52rem)] overflow-auto">
      {/* لا يوجد تدرّج عند حافة التمرير، عن قصد.
        A gradient direction is physical, and this app cannot flip one
        reliably. Tailwind's `rtl:` variant resolves to `[dir=rtl] *`, and
        __root.tsx hardcodes `<html lang="ar" dir="rtl">` for every locale, so
        it matches in English too — direction is actually switched per subtree
        by `<div dir={dir}>`. `[&:dir(rtl)]:` does not compile. A decorative
        cue is not worth a fade that points the wrong way in Arabic, so the
        native scrollbar stands in. */}
      <Table>
        <TableHeader className="bg-background/95 sticky top-0 z-10 shadow-[0_1px_0_0_hsl(var(--border))] backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <TableRow className="hover:bg-transparent">
            {canDelete && (
              <TableHead className="w-8">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
              </TableHead>
            )}
            <TableHead>#</TableHead>
            {columns.map((column) => (
              <SortableHead key={column.key} sortKey={column.key} sort={sort} toggle={toggle}>
                {column.label}
              </SortableHead>
            ))}
            <TableHead>{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedItems.map((item, index) => (
            <TableRow
              key={item.id}
              className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300 motion-reduce:animate-none"
              style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
            >
              {canDelete && (
                <TableCell>
                  <Checkbox
                    checked={selected.includes(item.id)}
                    onCheckedChange={(v) => toggleRow(item.id, v)}
                  />
                </TableCell>
              )}
              <TableCell className="text-muted-foreground tabular-nums">
                {rowNumber(index)}
              </TableCell>
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  data-field={column.key}
                  className={column.cellClassName}
                  title={column.title?.(item)}
                >
                  {column.render(item)}
                </TableCell>
              ))}
              <TableCell>
                <RowActions item={item} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
