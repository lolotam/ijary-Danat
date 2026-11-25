import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A card with a colored gradient header bar — the admin dashboard's recurring
 * section pattern (see admin.index.tsx "Monthly invoices" / "Recent payments"
 * sections). Used by portal pages to match the admin's colorful section
 * headers.
 *
 * The header text is always white and sits on a `bg-gradient-to-r` bar whose
 * colors are passed via `gradient` (e.g. "from-blue-600 to-blue-700").
 */
interface SectionCardProps {
  title: ReactNode;
  gradient: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function SectionCard({
  title,
  gradient,
  action,
  children,
  className,
  bodyClassName,
}: SectionCardProps) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border border-slate-200 bg-card shadow-md transition-shadow hover:shadow-lg dark:border-slate-800",
        className,
      )}
    >
      <header
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r px-5 py-4 text-white",
          gradient,
        )}
      >
        <h2 className="text-lg font-bold tracking-wide">{title}</h2>
        {action}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
