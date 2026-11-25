/**
 * المحلات التجارية وروابطها بالعقود: الاستعلامات والطفرات.
 *
 * Split out of `useLandingSettings.ts`, which re-exports everything here — import
 * from `@/hooks/useLandingSettings`, not this file, so test mocks of that path keep
 * intercepting.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { assertNotRowCapped } from "@/lib/idChunks";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";

export type CommercialBrand = Tables<"commercial_brands">;
export type CommercialBrandInsert = TablesInsert<"commercial_brands">;
export type CommercialBrandUpdate = TablesUpdate<"commercial_brands">;

/** خيار عقد نشط كما يعرضه اختيار العقود في نموذج المحل. */
export interface ActiveContractOption {
  id: string;
  code: string;
  tenantName: string;
  unitName: string;
}

/**
 * معرّفات العقود المرتبطة بكل محل، مفتاحها معرّف المحل.
 *
 * Read as its own query rather than embedded in `useLandingBrands`: the shops
 * table renders whether or not the links have arrived, and a brand row that
 * exists is more useful than no table at all while this resolves.
 */
export function useBrandContractLinks(enabled = true) {
  return useQuery({
    queryKey: ["commercial_brand_contracts"],
    enabled,
    queryFn: async (): Promise<Map<string, string[]>> => {
      const { data, error } = await supabase
        .from("commercial_brand_contracts")
        .select("brand_id, contract_id");
      if (error) throw error;
      // Unranged, so the server caps it. Well clear of the limit today, but a
      // clipped list here does not fail — it renders shops as linked to fewer
      // contracts than they are, and saving from that dialog would then WRITE
      // that shorter set back.
      assertNotRowCapped(data ?? [], "The shop-to-contract links");
      const byBrand = new Map<string, string[]>();
      for (const row of data ?? []) {
        const forBrand = byBrand.get(row.brand_id);
        if (forBrand) forBrand.push(row.contract_id);
        else byBrand.set(row.brand_id, [row.contract_id]);
      }
      return byBrand;
    },
  });
}

/**
 * يستبدل مجموعة عقود المحل كاملةً في معاملة واحدة.
 *
 * Through the `save_brand_contracts` RPC rather than a delete-then-insert pair
 * from here: a failure between the two would leave a shop linked to nothing
 * while the dialog reported a successful save, and the logo would silently
 * vanish from every lease it was on.
 *
 * The array is the complete desired set, so an empty one means "no contracts"
 * — a real state for a shop whose lease is not signed yet, not a no-op.
 */
export function useSaveBrandContracts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ brandId, contractIds }: { brandId: string; contractIds: string[] }) => {
      const { error } = await supabase.rpc("save_brand_contracts", {
        p_brand_id: brandId,
        p_contract_ids: contractIds,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commercial_brand_contracts"] });
      queryClient.invalidateQueries({ queryKey: ["shop-details"] });
      queryClient.invalidateQueries({ queryKey: ["shop-linked"] });
      // The tenant-detail and portal logo cards read the link the other way
      // round; without this they keep showing the pre-save storefront.
      queryClient.invalidateQueries({ queryKey: ["linked-brands"] });
      queryClient.invalidateQueries({ queryKey: ["linked-brand"] });
    },
  });
}

// 4. Commercial Brands Query & Mutations
export function useLandingBrands(enabled = true) {
  return useQuery({
    queryKey: ["commercial_brands"],
    enabled,
    queryFn: async (): Promise<CommercialBrand[]> => {
      const { data, error } = await supabase
        .from("commercial_brands")
        .select(
          `
          *,
          logo:logo_media_id ( storage_path ),
          cover:cover_media_id ( storage_path )
        `,
        )
        .order("display_order", { ascending: true });

      if (error) throw error;
      return data as any;
    },
  });
}

/**
 * Active contracts with tenant + unit labels, for the store ↔ contract link
 * dropdown in the Add/Edit Store dialog.
 */
export function useActiveContractOptions(enabled = true) {
  return useQuery({
    queryKey: ["active-contract-options"],
    enabled,
    queryFn: async (): Promise<ActiveContractOption[]> => {
      const { data: contracts, error } = await supabase
        .from("contracts")
        .select("id, code, tenant_id")
        .eq("state", "active")
        .order("code");
      if (error) throw error;
      if (!contracts.length) return [];
      // Units live on contract_units now (migration 110), not contracts.unit_id
      // (dropped in migration 118). The primary (lowest line_order, numbered from 1) unit stands in
      // for the contract here, matching `primaryUnit` in contractHelpers.ts.
      const [tenants, contractUnits] = await Promise.all([
        supabase
          .from("tenants")
          .select("id, name")
          .in("id", [...new Set(contracts.map((c) => c.tenant_id))]),
        supabase
          .from("contract_units")
          .select("contract_id, unit_id")
          .in(
            "contract_id",
            contracts.map((c) => c.id),
          )
          .order("line_order"),
      ]);
      if (tenants.error) throw tenants.error;
      if (contractUnits.error) throw contractUnits.error;
      const primaryUnitIdByContract = new Map<string, string>();
      for (const row of contractUnits.data) {
        if (!primaryUnitIdByContract.has(row.contract_id)) {
          primaryUnitIdByContract.set(row.contract_id, row.unit_id);
        }
      }
      const unitIds = [...new Set(primaryUnitIdByContract.values())];
      const units = unitIds.length
        ? await supabase.from("units").select("id, name").in("id", unitIds)
        : { data: [] as { id: string; name: string }[], error: null };
      if (units.error) throw units.error;
      const tenantById = new Map(tenants.data.map((t) => [t.id, t.name]));
      const unitById = new Map(units.data.map((u) => [u.id, u.name]));
      return contracts.map((c) => ({
        id: c.id,
        code: c.code,
        tenantName: tenantById.get(c.tenant_id) ?? "",
        unitName: unitById.get(primaryUnitIdByContract.get(c.id) ?? "") ?? "",
      }));
    },
  });
}

export function useCreateBrand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (brand: CommercialBrandInsert) => {
      const { data, error } = await supabase
        .from("commercial_brands")
        .insert(brand)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commercial_brands"] });
      queryClient.invalidateQueries({ queryKey: ["shop-details"] });
      queryClient.invalidateQueries({ queryKey: ["linked-brands"] });
      queryClient.invalidateQueries({ queryKey: ["linked-brand"] });
    },
  });
}

export function useUpdateBrand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: CommercialBrandUpdate }) => {
      const { data, error } = await supabase
        .from("commercial_brands")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commercial_brands"] });
      queryClient.invalidateQueries({ queryKey: ["shop-details"] });
      queryClient.invalidateQueries({ queryKey: ["shop-linked"] });
      queryClient.invalidateQueries({ queryKey: ["linked-brands"] });
      queryClient.invalidateQueries({ queryKey: ["linked-brand"] });
    },
  });
}

export function useDeleteBrand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("commercial_brands").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commercial_brands"] });
      queryClient.invalidateQueries({ queryKey: ["shop-details"] });
      queryClient.invalidateQueries({ queryKey: ["shop-linked"] });
      queryClient.invalidateQueries({ queryKey: ["linked-brands"] });
      queryClient.invalidateQueries({ queryKey: ["linked-brand"] });
    },
  });
}
