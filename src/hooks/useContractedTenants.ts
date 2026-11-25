import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";

/**
 * The tenant fields the portal-login picker needs: enough to label an option
 * and to prefill the account it creates. Deliberately not the whole row — this
 * list is fetched to fill a dropdown, not to render a tenant.
 */
export type ContractedTenant = Pick<
  Tables<"tenants">,
  "id" | "name" | "name_en" | "code" | "email" | "mobile" | "whatsapp" | "lifecycle"
>;

/** Invalidated wherever a portal link is created or removed. */
export const CONTRACTED_TENANTS_KEY = ["tenants", "with-any-contract"] as const;

/**
 * يبقي المستأجرين الذين لديهم عقد ولا يملكون حساب بوابة بعد.
 *
 * A tenant reappears once its account is deleted (the profile row cascades
 * away) or its tenant role is revoked (`revokeUserRole` clears the link). A
 * deactivated account still holds the tenant: it can be switched back on.
 */
export function portalLoginCandidates<T extends { id: string }>(
  tenants: T[],
  contracted: ReadonlySet<string>,
  linked: ReadonlySet<string>,
): T[] {
  return tenants.filter((tenant) => contracted.has(tenant.id) && !linked.has(tenant.id));
}

/**
 * المستأجرون الذين لديهم عقد بأي حالة ولا يرتبط بهم حساب بوابة.
 *
 * A portal login is only meaningful for a tenant who actually rents something,
 * and a tenant gets one login, so this is the list the create-tenant-user form
 * offers. `createAppUser` repeats the one-login check on the server, because
 * this list can be stale by the time the admin saves.
 *
 * `tenants.lifecycle` cannot stand in for the test. Migration 54 made that
 * column derived from *active* contracts alone, so a tenant whose only contract
 * is draft, expired or terminated reads as `inactive` while still being a real
 * account holder. The membership test is therefore "has a contract row", with
 * no state filter at all.
 */
export function useContractedTenants(enabled = true) {
  return useQuery({
    queryKey: CONTRACTED_TENANTS_KEY,
    enabled,
    queryFn: async (): Promise<ContractedTenant[]> => {
      const { data: tenants, error } = await supabase
        .from("tenants")
        .select("id, name, name_en, code, email, mobile, whatsapp, lifecycle")
        // Archiving a tenant disables their portal login (see useTenants).
        // Offering them here would hand back the login the archive took away.
        .is("archived_at", null)
        .order("code", { ascending: true })
        .limit(1000);
      if (error) throw error;
      if (!tenants?.length) return [];

      // Bounded by the ids just fetched rather than scanning the whole contracts
      // table: only membership matters, and an unbounded select would pay for
      // every contract in the database to answer a question about ~n tenants.
      const { data: contracts, error: contractError } = await supabase
        .from("contracts")
        .select("tenant_id")
        .in(
          "tenant_id",
          tenants.map((tenant) => tenant.id),
        );
      if (contractError) throw contractError;

      const { data: linkedProfiles, error: profileError } = await supabase
        .from("profiles")
        .select("tenant_id")
        .in(
          "tenant_id",
          tenants.map((tenant) => tenant.id),
        );
      if (profileError) throw profileError;

      return portalLoginCandidates(
        tenants,
        new Set((contracts ?? []).map((row) => row.tenant_id)),
        new Set((linkedProfiles ?? []).flatMap((row) => (row.tenant_id ? [row.tenant_id] : []))),
      );
    },
  });
}
