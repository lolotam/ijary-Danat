import type { ComponentProps, ReactNode } from "react";
import { Ban, CircleCheck, Eye, FileText, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { tenantBlockedIconClass } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

export type TableAction = "view" | "edit" | "delete" | "documents" | "block" | "unblock";

const actionIcons = {
  view: Eye,
  edit: Pencil,
  delete: Trash2,
  documents: FileText,
  block: Ban,
  unblock: CircleCheck,
} as const;

/**
 * `block` and `unblock` are coloured by the row's CURRENT state, not by what
 * clicking does — which is why the green one is the button that blocks.
 *
 * The caller picks the action as `lifecycle === "blocked" ? "unblock" : "block"`
 * (admin.tenants.index.tsx), so `unblock` is only ever rendered for a tenant who
 * is already blocked. Red therefore reads "this tenant is blocked" while
 * scanning the table, which is the question the icon exists to answer.
 *
 * Deliberately the opposite convention from `delete`, where red describes the
 * action rather than the row. If either colour is ever flipped, flip the caller
 * too or the pair stops meaning anything.
 */
const actionColors: Partial<Record<TableAction, string>> = {
  delete: "text-destructive",
  unblock: tenantBlockedIconClass.blocked,
  block: tenantBlockedIconClass.unblocked,
};

export function TableActionButton({
  action,
  indicator,
  children,
  className,
  ...buttonProps
}: ComponentProps<typeof Button> & {
  action: TableAction;
  /** حلقة حمراء صغيرة حول الأيقونة تدل على وجود محتوى (مثل وثائق مرفوعة). */
  indicator?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const Icon = actionIcons[action];
  const label =
    action === "documents"
      ? t("tenants.documents")
      : action === "block"
        ? t("tenants.block")
        : action === "unblock"
          ? t("tenants.unblock")
          : t(`common.${action}`);

  return (
    <Button
      size="icon"
      variant="ghost"
      className={cn(actionColors[action], className)}
      title={label}
      aria-label={label}
      {...buttonProps}
    >
      {children ?? (
        <span className="relative inline-flex">
          <Icon className="size-4" />
          {indicator && (
            <span
              aria-hidden
              className="pointer-events-none absolute -inset-1 rounded-full border-2 border-red-500"
            />
          )}
        </span>
      )}
    </Button>
  );
}
