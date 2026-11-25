import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

export interface LinkedBrand {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  logoUrl: string | null;
  contractId: string | null;
}

/**
 * أعمدة العلامة المشتركة بين مسار الوحدة (صف واحد) ومسار المستأجر (خريطة).
 *
 * `links` is an INNER embed, so a brand with no contract never comes back at
 * all rather than coming back with an empty array — the filter below is on the
 * embedded table and an outer embed would return every brand in the database.
 * PostgREST also filters the embedded rows themselves, so `links` holds only
 * the contracts that were asked for, which is exactly what the fan-out wants.
 */
const BRAND_SELECT =
  "id, slug, name_ar, name_en, logo:logo_media_id ( storage_path ), links:commercial_brand_contracts!inner ( contract_id )" as const;

/** صفّ العلامة كما ترجعه PostgREST مع علاقة شعار اختيارية وعقودها المرتبطة. */
export interface LinkedBrandRow {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  logo: { storage_path: string } | null;
  links: Array<{ contract_id: string }>;
}

/**
 * يحوّل صفوفاً إلى خريطة عقد → علامة، مع الإبقاء على أول علامة لكل عقد.
 *
 * The map is still keyed by CONTRACT and the first brand still wins per
 * contract, matching `contract_brand_assets` (migration 244). What changed with
 * migration 162 is the other direction: one brand now fans out across every
 * contract it is linked to, so a shop occupying two leases shows its logo on
 * both instead of on whichever one the old scalar column happened to hold.
 *
 * A contract with no row is simply absent — callers must not fall back to a
 * sibling shop.
 */
export function linkedBrandsByContract(rows: LinkedBrandRow[]): Map<string, LinkedBrand> {
  const byContract = new Map<string, LinkedBrand>();
  for (const row of rows) {
    for (const link of row.links ?? []) {
      if (!link.contract_id || byContract.has(link.contract_id)) continue;
      byContract.set(link.contract_id, {
        id: row.id,
        slug: row.slug,
        name_ar: row.name_ar,
        name_en: row.name_en,
        logoUrl: row.logo?.storage_path ?? null,
        contractId: link.contract_id,
      });
    }
  }
  return byContract;
}

/**
 * يختار علامة العقد المعروض حالياً، أو لا شيء إن لم تُربَط به علامة.
 *
 * The portal selector and the tenant-detail tab both drive the logo from this
 * lookup. Falling back to `map.values().next()` would resurrect the one-logo-
 * per-tenant bug the moment a second shop is selected.
 */
export function brandForSelectedContract(
  brands: Map<string, LinkedBrand> | undefined,
  contractId: string | null,
): LinkedBrand | null {
  if (!brands || !contractId) return null;
  return brands.get(contractId) ?? null;
}

/**
 * يجلب كل العلامات النشطة للعقود المعطاة، بلا limit(1).
 *
 * `.limit(1).maybeSingle()` collapsed a multi-shop tenant to whichever row
 * PostgREST returned first. A unit still goes through `brandForContracts`
 * because `one_active_contract_per_unit` makes that path single-valued.
 */
export async function brandsForContracts(contractIds: string[]): Promise<Map<string, LinkedBrand>> {
  if (!contractIds.length) return new Map();
  const { data, error } = await supabase
    .from("commercial_brands")
    .select(BRAND_SELECT)
    // Filtered on the ALIAS, not the table name: PostgREST resolves an
    // embedded filter against the alias the select gave the relation, and
    // naming the raw table here silently matches nothing.
    .in("links.contract_id", contractIds)
    .eq("is_active", true)
    .order("display_order", { ascending: true });
  if (error) throw error;
  return linkedBrandsByContract((data ?? []) as unknown as LinkedBrandRow[]);
}

/**
 * Storefront brand linked to a contract.
 *
 * A brand is attached to its contracts from Settings > Landing page > Shops
 * (`commercial_brand_contracts`, migration 162 — a set, not a single column).
 * Given a unit we first collect that entity's contract ids, then look for a
 * brand linked to one of them, preferring the brand on an active contract.
 */
async function brandForContracts(contractIds: string[]): Promise<LinkedBrand | null> {
  if (!contractIds.length) return null;
  const { data, error } = await supabase
    .from("commercial_brands")
    .select(BRAND_SELECT)
    .in("links.contract_id", contractIds)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const record = data as unknown as LinkedBrandRow;
  return {
    id: record.id,
    slug: record.slug,
    name_ar: record.name_ar,
    name_en: record.name_en,
    logoUrl: record.logo?.storage_path ?? null,
    // `contractIds` is ordered active-first, so the first of this brand's links
    // that appears in it is the contract the caller would have picked anyway.
    contractId: contractIds.find((id) => record.links?.some((l) => l.contract_id === id)) ?? null,
  };
}

/** Active contracts first so a re-let unit shows the current storefront. */
function sortActiveFirst<T extends { state: string; id: string }>(rows: T[]): string[] {
  return [...rows]
    .sort((a, b) => Number(b.state === "active") - Number(a.state === "active"))
    .map((contract) => contract.id);
}

async function contractIdsForTenant(tenantId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("contracts")
    .select("id, state")
    .eq("tenant_id", tenantId);
  if (error) throw error;
  return sortActiveFirst(data);
}

/**
 * Units live on contract_units now (migration 110), not contracts.unit_id
 * (dropped in migration 118) — a unit's contracts are whichever ones have a
 * contract_units row naming it.
 */
async function contractIdsForUnit(unitId: string): Promise<string[]> {
  const { data: links, error: linkError } = await supabase
    .from("contract_units")
    .select("contract_id")
    .eq("unit_id", unitId);
  if (linkError) throw linkError;
  const contractIds = [...new Set(links.map((link) => link.contract_id))];
  if (!contractIds.length) return [];
  const { data, error } = await supabase
    .from("contracts")
    .select("id, state")
    .in("id", contractIds);
  if (error) throw error;
  return sortActiveFirst(data);
}

/**
 * كل علامات محلات المستأجر، مفتاحها معرّف العقد لا المستأجر.
 *
 * Replaces `useBrandForTenant`, which asked PostgREST for one row and so could
 * never show a second shop's logo. Callers pick from the map with the contract
 * currently selected on the portal or the tenant-detail tab strip.
 */
export function useBrandsForTenantContracts(tenantId: string | null) {
  return useQuery({
    queryKey: ["linked-brands", "tenant", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async () => brandsForContracts(await contractIdsForTenant(tenantId!)),
  });
}

export function useBrandForUnit(unitId: string | null) {
  return useQuery({
    queryKey: ["linked-brand", "unit", unitId],
    enabled: Boolean(unitId),
    queryFn: async () => brandForContracts(await contractIdsForUnit(unitId!)),
  });
}
