/**
 * علاقات صفحتي العقود والمستأجرين: طلب واحد بدل سلسلة طلبات متتالية.
 *
 * Both lists used to fetch their page and then fan out into 5–7 requests that
 * each waited for the previous one — about a second of round trips on the
 * contracts screen for data that takes milliseconds to read. The two RPCs
 * (migration 244) return the same raw rows in one response, read through the
 * caller's RLS; the grouping and business rules stay in the callers.
 */
import { supabase } from "@/integrations/supabase/client";
import type { ContractState, Tables } from "@/integrations/supabase/database.types";
import type { BrandAssetUrls } from "@/lib/brandLogos";
import type { ConcessionColumnRow } from "@/lib/concessionColumns";

/** صف علامة تجارية واحد لكل عقد كما يرجعه `contract_brand_assets`. */
interface BrandAssetRow {
  contract_id: string;
  logo_path: string | null;
  cover_path: string | null;
}

export interface ContractListRelations {
  tenants: Tables<"tenants">[];
  /** In `line_order` within each contract, so the first line is the primary unit. */
  contractUnits: Array<{
    contract_id: string;
    unit_id: string;
    monthly_amount: number;
    line_order: number;
  }>;
  units: Tables<"units">[];
  properties: Tables<"properties">[];
  concessions: ConcessionColumnRow[];
  brandByContract: Map<string, BrandAssetUrls>;
  overdueContractIds: Set<string>;
}

export interface TenantListRelations {
  contracts: Array<{
    id: string;
    code: string;
    tenant_id: string;
    state: ContractState;
    start_date: string;
    end_date: string | null;
    monthly_amount: number;
  }>;
  /** In `line_order` within each contract. */
  contractUnits: Array<{ contract_id: string; unit_id: string }>;
  units: Tables<"units">[];
  properties: Tables<"properties">[];
  brandByContract: Map<string, BrandAssetUrls>;
  overdue: Array<{ tenant_id: string; contract_id: string }>;
}

/** يقرأ مصفوفة من ناتج الـ RPC، وأي شكل آخر يُعامل كقائمة فارغة. */
function arrayField<T>(data: unknown, key: string): T[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const value = (data as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as unknown as T[]) : [];
}

/** يحوّل صفوف العلامات إلى خريطة بمفتاح العقد، بالشكل الذي تقرؤه الصفحتان. */
function brandMap(rows: BrandAssetRow[]): Map<string, BrandAssetUrls> {
  return new Map(
    rows.map((row) => [row.contract_id, { logoUrl: row.logo_path, cardUrl: row.cover_path }]),
  );
}

/** يجلب علاقات العقود المعروضة في صفحة العقود بطلب واحد. */
export async function fetchContractListRelations(
  contractIds: string[],
): Promise<ContractListRelations> {
  const { data, error } = await supabase.rpc("contract_list_relations", {
    p_contract_ids: contractIds,
  });
  if (error) throw error;
  return {
    tenants: arrayField(data, "tenants"),
    contractUnits: arrayField(data, "contract_units"),
    units: arrayField(data, "units"),
    properties: arrayField(data, "properties"),
    concessions: arrayField(data, "concessions"),
    brandByContract: brandMap(arrayField(data, "brands")),
    overdueContractIds: new Set(arrayField<string>(data, "overdue_contract_ids")),
  };
}

/** يجلب عقود المستأجرين المعروضين ووحداتهم ومبانيهم وعلاماتهم ومتأخراتهم بطلب واحد. */
export async function fetchTenantListRelations(tenantIds: string[]): Promise<TenantListRelations> {
  const { data, error } = await supabase.rpc("tenant_list_relations", {
    p_tenant_ids: tenantIds,
  });
  if (error) throw error;
  return {
    contracts: arrayField(data, "contracts"),
    contractUnits: arrayField(data, "contract_units"),
    units: arrayField(data, "units"),
    properties: arrayField(data, "properties"),
    brandByContract: brandMap(arrayField(data, "brands")),
    overdue: arrayField(data, "overdue"),
  };
}
