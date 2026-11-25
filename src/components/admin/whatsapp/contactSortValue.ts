import type { Locale } from "@/i18n/dictionary";
import type { WhatsAppContactWithContracts } from "@/hooks/useWhatsAppInbox";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

/**
 * يعيد القيمة التي يُرتَّب بها عمود في جدول جهات الاتصال.
 *
 * Separate from the table so the two columns that do not sort on a raw field
 * can be tested: the tenant column sorts on the tenant's *displayed* name (and
 * therefore changes with the UI language), and the contracts column on how many
 * contracts are linked, since a list of codes has no defined order.
 */
export function contactSortValue(
  contact: WhatsAppContactWithContracts,
  key: string,
  locale: Locale,
): unknown {
  if (key === "tenant") return contact.tenant ? tenantDisplayName(contact.tenant, locale) : null;
  if (key === "contracts") return contact.contracts.length;
  return contact[key as keyof WhatsAppContactWithContracts];
}
