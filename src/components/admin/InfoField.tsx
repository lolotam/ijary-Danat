import type { ReactNode } from "react";

import { LtrText } from "@/components/ui/ltr-text";

/**
 * A labelled read-only value in a detail grid.
 *
 * Lifted out of admin.tenants.$id.index.tsx when the contract tabs arrived and
 * three files needed the same pairing.
 */
export function InfoField({
  label,
  value,
  ltr = false,
}: {
  label: string;
  value: ReactNode;
  /** Force the value to render LTR (phone/email/latin fields in Arabic mode). */
  ltr?: boolean;
}) {
  const displayed = value ?? "—";

  return (
    <div>
      <p className="text-sm uppercase tracking-wide text-muted-foreground">{label}</p>
      {/* Delegated rather than re-implemented: this file used to carry its own
          `dir="ltr"` + `text-start` pair, which is the bug LtrText documents. */}
      <div className="mt-0.5 text-base">{ltr ? <LtrText>{displayed}</LtrText> : displayed}</div>
    </div>
  );
}
