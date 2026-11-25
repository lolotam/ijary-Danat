import type { PortalContractOption } from "@/hooks/usePortalData";

/**
 * يختار مفتاح الترجمة لحالة العقد: نشط أو غير نشط.
 *
 * `contract_states` has seven values (draft, active, frozen, suspended,
 * expired, renewed, terminated) and the portal collapses them to two. A tenant
 * has no use for the difference between "frozen" and "suspended" — those are
 * operational states the office manages. What they need to read off the list is
 * whether the contract they are about to look at is the one they are living
 * under today.
 */
export function portalContractStatusKey(state: PortalContractOption["state"]): string {
  return state === "active" ? "portal.contract.status.active" : "portal.contract.status.inactive";
}

/**
 * يبني عنوان العقد في قائمة البوابة: ترتيبه، ثم رمزه، ثم حالته بين قوسين.
 *
 * Unit codes used to lead this label. They are the longest part of it and the
 * least identifying — on a phone they pushed the contract code, which is what
 * every invoice, receipt and message refers to, past the truncation.
 *
 * `position` is the row's 1-based place in the list as displayed, and
 * `statusLabel` is resolved by the caller so both words stay in the dictionary
 * where the parity test covers them.
 */
export function portalContractLabel(
  contract: PortalContractOption,
  position: number,
  statusLabel: string,
): string {
  return `${position}-${contract.code} (${statusLabel})`;
}
