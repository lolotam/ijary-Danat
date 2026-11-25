import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDirection = "asc" | "desc";
export interface SortState {
  key: string | null;
  direction: SortDirection;
}

/**
 * Client-side column sorting for admin tables.
 *
 * Sorting applies to the rows currently held by the page. Tables that page
 * server-side therefore sort within the loaded page — which matches how the
 * lists are read in practice, and avoids pushing an `order` param through
 * every list hook and RPC.
 */
/**
 * يرتّب صفوف الجدول حسب العمود المختار، ويعيد حالة الترتيب ومبدّلها.
 *
 * The comparator is supplied by the caller because what a column sorts on is
 * rarely the raw field — an occupant sorts by name, a rent by the contracted
 * figure rather than the stored column.
 */
export function useTableSort<T>(
  rows: T[],
  getValue: (row: T, key: string) => unknown,
  initial: SortState = { key: null, direction: "asc" },
  // Extra values the comparator reads that are not `rows`. `getValue` is
  // deliberately out of the memo's dependencies — callers pass an inline lambda,
  // so a new identity every render would defeat the memo entirely. That is fine
  // while the comparator only reads its row, and wrong the moment it reads
  // something asynchronous: the units table sorts on a rent map that arrives
  // after the first render, and without this the rows kept their unsorted order
  // once it did.
  deps: readonly unknown[] = [],
) {
  const [sort, setSort] = useState<SortState>(initial);

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const key = sort.key;
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => factor * compareValues(getValue(a, key), getValue(b, key)));
    // getValue itself stays out: see `deps` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort.key, sort.direction, ...deps]);

  function toggle(key: string) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  }

  return { sort, toggle, sorted };
}

function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Table header cell with an up/down sort toggle. */
export function SortableHead({
  sortKey,
  sort,
  toggle,
  className,
  children,
}: {
  sortKey: string;
  sort: SortState;
  toggle: (key: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => toggle(sortKey)}
        aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1 -mx-1 hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {children}
        <Icon className={cn("size-3.5 shrink-0", active ? "opacity-100" : "opacity-40")} />
      </button>
    </TableHead>
  );
}
