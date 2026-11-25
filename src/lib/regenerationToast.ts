import type { RegenerationSummary } from "@/fns/regenerateContractInvoices";

/** ما يجب عرضه بعد مصالحة فواتير العقد: النوع، ومفتاح النص، والبدائل. */
export interface RegenerationToast {
  kind: "warning" | "success";
  key: string;
  values: Record<string, string>;
}

/**
 * يترجم حصيلة المصالحة إلى إشعار واحد، أو لا شيء إن لم يتغيّر شيء.
 *
 * Reconciliation runs on every contract save and can cancel or block invoices,
 * not only update them. Those outcomes take priority over the plain count: an
 * operator who edits a rent and is told "12 updated" while three invoices were
 * cancelled has been told the reassuring half of what happened.
 *
 * Returns null when nothing moved. A toast saying "0 updated" on a save that
 * only changed the notes field is noise, and noise is how the warning above
 * stops being read.
 */
export function regenerationToast(summary: RegenerationSummary): RegenerationToast | null {
  const updated = String(summary.updated);
  const inserted = String(summary.inserted);

  if (summary.cancelled > 0) {
    return {
      kind: "warning",
      key: "contracts.regeneratedWithCancellations",
      values: { updated, inserted, cancelled: String(summary.cancelled) },
    };
  }
  if (summary.blocked > 0) {
    return {
      kind: "warning",
      key: "contracts.regeneratedWithBlocked",
      values: { updated, inserted, blocked: String(summary.blocked) },
    };
  }
  if (summary.updated || summary.inserted || summary.deleted) {
    return { kind: "success", key: "contracts.regenerated", values: { updated, inserted } };
  }
  return null;
}

/**
 * يستبدل عناصر `{name}` في نص مترجم بقيمها.
 *
 * The dictionary carries the placeholders; substituting here keeps the caller
 * from chaining a `.replace` per value and quietly dropping one.
 */
export function fillPlaceholders(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template,
  );
}
