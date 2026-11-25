import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n/provider";

export function ModuleHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-2xl text-base text-muted-foreground">{subtitle}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function TableState({
  loading,
  error,
  empty,
  children,
}: {
  loading: boolean;
  error: boolean;
  empty: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (loading)
    return (
      <div className="space-y-3 p-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    );
  if (error) return <p className="p-6 text-base text-destructive">{t("common.error")}</p>;
  if (empty)
    return <p className="p-8 text-center text-base text-muted-foreground">{t("common.empty")}</p>;
  return <>{children}</>;
}

/** أحجام الصفحات المعروضة حين يسمح النداء بتغيير الحجم. */
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

/** أحجام صفحات جداول السجلات (التدقيق والإشعارات) — سجلات طويلة تُقرأ بالجملة. */
export const LOG_PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

/**
 * ترقيم الصفحات، مع مُحدِّد اختياري لعدد السجلات المعروضة.
 *
 * `setPageSize` is optional so the pages that have not asked for a size selector
 * render exactly as before rather than all growing a control at once.
 */
export function Pager({
  page,
  pageSize,
  count,
  setPage,
  setPageSize,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
}: {
  page: number;
  pageSize: number;
  count: number;
  setPage: (page: number) => void;
  setPageSize?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
}) {
  const { t } = useI18n();
  const lastPage = Math.max(1, Math.ceil(count / pageSize));
  return (
    <div className="flex items-center justify-between border-t px-4 py-3 text-base text-muted-foreground">
      <div className="flex items-center gap-3">
        <span>
          {page} / {lastPage}
        </span>
        {setPageSize && (
          <Select
            value={String(pageSize)}
            onValueChange={(value) => {
              setPageSize(Number(value));
              // Page 4 of a 10-row list is past the end of a 100-row one.
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-[5.5rem]" aria-label={t("common.perPage")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          {t("common.previous")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= lastPage}
          onClick={() => setPage(page + 1)}
        >
          {t("common.next")}
        </Button>
      </div>
    </div>
  );
}

export function SelectFilter({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  options: { value: string; label: ReactNode }[];
}) {
  const { t } = useI18n();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t("common.all")}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function DeleteConfirmation({
  open,
  pending,
  title,
  description,
  close,
  confirm,
}: {
  open: boolean;
  pending: boolean;
  title: string;
  description: string;
  close: () => void;
  confirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={confirm}>
            {pending ? t("common.loading") : t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
