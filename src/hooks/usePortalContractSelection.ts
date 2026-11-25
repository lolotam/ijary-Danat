import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { usePortalContracts } from "@/hooks/usePortalData";

/**
 * يبني كائن البحث التالي عند تغيير العقد المختار، مع الإبقاء على بقية المعاملات.
 *
 * Dropping `?tenant=` while an admin previews would bounce them to /admin —
 * the same bug portal.index.tsx already guards on its Pay Now link.
 */
export function withContractSearch(
  prev: Record<string, unknown>,
  next: string,
): Record<string, unknown> {
  return { ...prev, contract: next };
}

/**
 * يقصر معرّف العقد القادم من الرابط على عقود المستأجر، ويختار الأحدث تلقائيًا.
 *
 * The URL is user-controlled, so `?contract=` can carry anything: a typo, a
 * stale id from a contract since archived, or another tenant's uuid pasted from
 * elsewhere. Passing any of those straight through reaches a uuid RPC argument
 * — a malformed value errors on the cast, and a foreign one raises the
 * ownership exception migration 121 added.
 *
 * With no "all contracts" option left, an unusable value falls back to the
 * tenant's most recent contract rather than to a tenant-wide view. The
 * fallback is resolved here rather than by navigating on mount: four pages
 * mount this hook, and four `navigate()` calls racing to write the same search
 * parameter is how the admin's `?tenant=` preview gets dropped.
 *
 * An **empty** list still resolves to `null`, and that is not the same thing as
 * "not loaded yet". A tenant whose only contract has been archived has no rows
 * here but can still hold unpaid invoices; `null` keeps `p_contract_id` unset
 * so they can see and pay them.
 *
 * `isLoaded` false means the query is still in flight, so the raw value is held
 * rather than resolved — resolving it here would flip the selection to the
 * first contract on every refresh before the query returns.
 */
export function resolvePortalContractId(
  raw: string | null,
  available: readonly string[],
  isLoaded: boolean,
): string | null {
  if (!isLoaded) return raw;
  if (raw && available.includes(raw)) return raw;
  return available[0] ?? null;
}

/**
 * العقد المختار حاليًا في البوابة، مقروءًا من عنوان الصفحة `?contract=`.
 *
 * The URL, not component state: it is what lets "Pay Now" on the dashboard open
 * My Invoices already filtered, and what makes a refresh or a shared link keep
 * the tenant where they were. `null` means the tenant has no contract to select
 * — every tenant who has one gets one, chosen for them if the URL is silent.
 *
 * Pass the tenant so the value can be checked against their own contracts. The
 * contract query is shared through react-query's cache with the switcher's, so
 * validating costs no extra request.
 */
export function usePortalContractSelection(tenantId?: string | null): {
  contractId: string | null;
  setContractId: (next: string) => void;
} {
  const search = useSearch({ strict: false }) as {
    tenant?: string;
    contract?: string;
  };
  const navigate = useNavigate();
  const contracts = usePortalContracts(tenantId ?? null);
  const raw = typeof search.contract === "string" ? search.contract : null;
  const contractId = resolvePortalContractId(
    raw,
    (contracts.data ?? []).map((contract) => contract.id),
    contracts.isSuccess,
  );

  const setContractId = useCallback(
    (next: string) => {
      navigate({
        search: (prev: Record<string, unknown>) => withContractSearch(prev, next),
        replace: true,
      } as never);
    },
    [navigate],
  );

  return { contractId, setContractId };
}
