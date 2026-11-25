import type { ReactNode } from "react";

/**
 * Grid wrapper for the list-page KPI rows.
 *
 * Fails SILENTLY: a broken aggregate must never blank the table beneath it.
 * The table is the product; the cards are a garnish.
 */
export function SummaryCards({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: unknown;
  children: ReactNode;
}) {
  if (error) {
    console.error("Summary cards failed to load", error);
    return null;
  }

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-[148px] animate-pulse rounded-2xl bg-muted"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">{children}</div>;
}
