import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";

/**
 * Mobile fallback for wide admin tables: renders each row as a compact card.
 * Pages switch between this and their <Table> with useIsMobile().
 */
export function MobileCardList<T>({
  items,
  keyFor,
  renderCard,
  empty,
}: {
  items: T[];
  keyFor: (item: T) => string;
  renderCard: (item: T) => ReactNode;
  empty?: ReactNode;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center text-base text-muted-foreground">
        {empty}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <Card key={keyFor(item)}>
          <CardContent className="space-y-2 p-4">{renderCard(item)}</CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Label/value line used inside MobileCardList cards. */
export function CardField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-base">
      <span className="shrink-0 text-base text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-end font-medium">{children}</span>
    </div>
  );
}
