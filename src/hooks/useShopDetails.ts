import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { CommercialBrandRow } from "@/integrations/supabase/database.types";

/**
 * تفاصيل متجر المستأجر من دالة RPC المحدودة بالأذونات.
 *
 * يبقى المحل معطلّاً مرئياً هنا حتى لو أخفاه المسؤول عن الصفحة العامة.
 * التحميل عبر `shop_details_for_tenant` وليس عبر جدول `commercial_brands`
 * حتى لا تُطبق قاعدة `is_active` ولا يختفي السجل.
 */

export interface ShopDetails {
  id: string;
  name_original: string;
  name_ar: string;
  name_en: string;
  phone: string | null;
  opening_hours: string | null;
  website_url: string | null;
  instagram_url: string | null;
  description_ar: string | null;
  description_en: string | null;
  logo_media_id: string | null;
  cover_media_id: string | null;
  logo_url: string | null;
  cover_url: string | null;
  updated_at: string;
}

/**
 * تفاصيل متجر المستأجر للعقد المختار حالياً.
 *
 * Scoped by contract, not merely "the tenant's first shop":
 * `commercial_brand_contracts` already lets one tenant hold distinct brands on
 * distinct contracts, and the portal's `?contract=` selector is how they choose
 * between them. Taking the first globally ordered row would make the second shop
 * uneditable and could show the wrong one after switching contracts.
 *
 * A null contract means "not scoped" and the RPC returns every shop the caller
 * owns, which is what the tab-availability check wants.
 */
export function useShopDetails(contractId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ["shop-details", contractId ?? null],
    enabled,
    queryFn: async (): Promise<ShopDetails[]> => {
      const { data, error } = await supabase.rpc("shop_details_for_tenant", {
        p_contract_id: contractId ?? undefined,
      });
      if (error) throw error;
      return (data ?? []) as unknown as ShopDetails[];
    },
  });
}

export interface SaveShopDetailsPayload {
  brandId: string;
  name_original: string;
  name_ar: string;
  name_en: string;
  phone: string | null;
  opening_hours: string | null;
  website_url: string | null;
  instagram_url: string | null;
  description_ar: string | null;
  description_en: string | null;
  logo_media_id: string | null;
  cover_media_id: string | null;
  expectedUpdatedAt: string | null;
}

/**
 * يحفظ تفاصيل متجر المستأجر عبر RPC القائمة البيضاء.
 *
 * بعد الحفظ يُبطل جميع مفاتيح الاستعلام التي قد تعرض هذا المتجر — كل من
 * مفاتيح بوابة المستأجر ومفاتيح لوحة الإدارة — حتى لا تبقى بيانات قديمة على الشاشة.
 */
export function useSaveShopDetails() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: SaveShopDetailsPayload): Promise<CommercialBrandRow> => {
      const { data, error } = await supabase.rpc("save_shop_details_as_tenant", {
        p_brand_id: payload.brandId,
        p_name_original: payload.name_original,
        p_name_ar: payload.name_ar,
        p_name_en: payload.name_en,
        p_phone: payload.phone,
        p_opening_hours: payload.opening_hours,
        p_website_url: payload.website_url,
        p_instagram_url: payload.instagram_url,
        p_description_ar: payload.description_ar,
        p_description_en: payload.description_en,
        p_logo_media_id: payload.logo_media_id,
        p_cover_media_id: payload.cover_media_id,
        p_expected_updated_at: payload.expectedUpdatedAt,
      });
      if (error) throw error;
      return data as unknown as CommercialBrandRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shop-details"] });
      queryClient.invalidateQueries({ queryKey: ["shop-linked"] });
      queryClient.invalidateQueries({ queryKey: ["commercial_brands"] });
      queryClient.invalidateQueries({ queryKey: ["linked-brands"] });
      queryClient.invalidateQueries({ queryKey: ["linked-brand"] });
    },
  });
}
