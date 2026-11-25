import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * حالة فارغة موحّدة: أيقونة وعنوان ووصف وإجراء اختياري.
 *
 * The three landing-page grids each rendered emptiness differently — two as
 * blank space, one as a bare paragraph. One component so they cannot drift.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center">
      <Icon className="size-10 text-muted-foreground" aria-hidden />
      <p className="mt-4 text-sm font-medium">{title}</p>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
