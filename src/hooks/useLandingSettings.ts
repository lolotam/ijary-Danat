import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getLandingCompanyId } from "@/company/rootPageDecision";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";

// The public entry point for landing-page hooks. Every importer and every
// `vi.mock("@/hooks/useLandingSettings")` goes through this path, so the split
// modules are re-exported here rather than imported directly by callers.
export type {
  ActiveContractOption,
  CommercialBrand,
  CommercialBrandInsert,
  CommercialBrandUpdate,
} from "@/hooks/useLandingBrands";
export {
  useActiveContractOptions,
  useBrandContractLinks,
  useCreateBrand,
  useDeleteBrand,
  useLandingBrands,
  useSaveBrandContracts,
  useUpdateBrand,
} from "@/hooks/useLandingBrands";
export type {
  LandingCarouselSlide,
  LandingCarouselSlideInsert,
  LandingCarouselSlideUpdate,
} from "@/hooks/useLandingSlides";
export {
  useCreateSlide,
  useDeleteSlide,
  useLandingSlides,
  useUpdateSlide,
} from "@/hooks/useLandingSlides";
export type {
  LeasingInquiry,
  LeasingInquiryListParams,
  LeasingInquiryListResult,
  LeasingInquiryUpdate,
} from "@/hooks/useLeasingInquiries";
export {
  useDeleteLeasingInquiries,
  useLeasingInquiries,
  useUpdateLeasingInquiry,
} from "@/hooks/useLeasingInquiries";

export type LandingMedia = Tables<"landing_media">;
export type LandingMediaInsert = TablesInsert<"landing_media">;
export type LandingMediaUpdate = TablesUpdate<"landing_media">;

export type LandingPageSettings = Tables<"landing_page_settings">;
export type LandingPageSettingsUpdate = TablesUpdate<"landing_page_settings">;

export type LandingPageSection = Tables<"landing_page_sections">;
export type LandingPageSectionUpdate = TablesUpdate<"landing_page_sections">;

type MediaRef = { storage_path: string } | null;

export type LandingPageSettingsWithMedia = LandingPageSettings & {
  hero_desktop: MediaRef;
  hero_mobile: MediaRef;
  about_primary: MediaRef;
  about_secondary: MediaRef;
};

/**
 * معرّف الشركة التي تخصّها صفحة الهبوط في هذا الطلب.
 *
 * The landing content belongs to the company that owns the host: the visitor
 * may hold no session at all, so only the server can say which company is
 * being looked at. The admin panel runs on the same company host, so one rule
 * serves both the public page and the editor.
 */
export function useLandingCompanyId(enabled = true) {
  return useQuery({
    queryKey: ["landing_company_id"],
    enabled,
    queryFn: async (): Promise<string | null> => getLandingCompanyId(),
    staleTime: 60_000,
  });
}

/**
 * يطلب معرّف الشركة صاحبة المضيف، ويرفض القراءة بلا صاحب.
 *
 * The read is bound to that company, so a query without one would be able to
 * return another company's content — and the row it wants does not exist
 * without it.
 */
export function requireLandingCompanyId(companyId: string | null | undefined): string {
  if (!companyId) throw new Error("Landing content is bound to the company that owns the host");
  return companyId;
}

// 1. Landing Settings Query & Mutation
export function useLandingSettings(locale: "ar" | "en", enabled = true) {
  const { data: companyId } = useLandingCompanyId(enabled);

  return useQuery({
    queryKey: ["landing_settings", locale, companyId],
    enabled: enabled && Boolean(companyId),
    queryFn: async (): Promise<LandingPageSettingsWithMedia | null> => {
      const { data, error } = await supabase
        .from("landing_page_settings")
        .select(
          `
          *,
          hero_desktop:hero_desktop_media_id ( storage_path ),
          hero_mobile:hero_mobile_media_id ( storage_path ),
          about_primary:about_primary_media_id ( storage_path ),
          about_secondary:about_secondary_media_id ( storage_path )
        `,
        )
        .eq("company_id", requireLandingCompanyId(companyId))
        .eq("locale", locale)
        .maybeSingle();

      if (error) throw error;
      return data as LandingPageSettingsWithMedia | null;
    },
  });
}

// Category labels for the public shop filter. `commercial_brands.category_id`
// is a uuid FK to building_categories, so the filter must compare ids and
// resolve display names from this list.
export type LandingCategory = Pick<
  Tables<"building_categories">,
  "id" | "code" | "name_ar" | "name_en"
>;

export function useLandingCategories(enabled = true) {
  const { data: companyId } = useLandingCompanyId(enabled);

  return useQuery({
    queryKey: ["building_categories", "landing", companyId],
    enabled: enabled && Boolean(companyId),
    queryFn: async (): Promise<LandingCategory[]> => {
      const { data, error } = await supabase
        .from("building_categories")
        .select("id, code, name_ar, name_en")
        .eq("company_id", requireLandingCompanyId(companyId))
        .order("sort_order", { ascending: true });

      // Anonymous visitors need migration 20 (public read policy). Until it
      // is applied, degrade to "All" instead of breaking the page.
      if (error) return [];
      return data ?? [];
    },
  });
}

export function useUpdateLandingSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: LandingPageSettingsUpdate }) => {
      const { data: before, error: beforeError } = await supabase
        .from("landing_page_settings")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;

      const { data: after, error } = await supabase
        .from("landing_page_settings")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;

      await logAuditForCurrentSession({
        action: "landing_settings.update",
        entityType: "landing_page_settings",
        entityId: id,
        before,
        after,
      });

      return after;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["landing_settings"] });
    },
  });
}

// 2. Landing Sections Query & Mutation
export function useLandingSections(enabled = true) {
  const { data: companyId } = useLandingCompanyId(enabled);

  return useQuery({
    queryKey: ["landing_sections", companyId],
    enabled: enabled && Boolean(companyId),
    queryFn: async (): Promise<LandingPageSection[]> => {
      const { data, error } = await supabase
        .from("landing_page_sections")
        .select("*")
        .eq("company_id", requireLandingCompanyId(companyId))
        .order("display_order", { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useUpdateLandingSection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: LandingPageSectionUpdate }) => {
      const { data, error } = await supabase
        .from("landing_page_sections")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["landing_sections"] });
    },
  });
}

// 3. Landing Media Query & Mutations
export type LandingMediaCategory =
  | "exterior"
  | "interior"
  | "shops"
  | "facilities"
  | "events"
  | "parking"
  | "logo"
  | "tenant_avatar"
  | "gallery";

export function useLandingMedia(category?: LandingMediaCategory, enabled = true) {
  const { data: companyId } = useLandingCompanyId(enabled);

  return useQuery({
    queryKey: ["landing_media", category, companyId],
    enabled: enabled && Boolean(companyId),
    queryFn: async (): Promise<LandingMedia[]> => {
      let query = supabase
        .from("landing_media")
        .select("*")
        .eq("company_id", requireLandingCompanyId(companyId))
        .order("display_order", { ascending: true });
      if (category) {
        query = query.eq("category", category);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateLandingMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (media: LandingMediaInsert) => {
      const { data, error } = await supabase
        .from("landing_media")
        .insert(media)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["landing_media"] });
    },
  });
}

/**
 * يحدّث صف وسائط واحدًا مع تحديث تفاؤلي فوري للمخبّأ وتراجع عند الفشل.
 *
 * Optimistic so the gallery toggle feels instant; the snapshot/restore pair
 * exists because a failed toggle must not leave the UI claiming a state the
 * database never accepted.
 */
export function useUpdateLandingMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: LandingMediaUpdate }) => {
      const { data, error } = await supabase
        .from("landing_media")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    // Cancel, snapshot, write, restore and invalidate all run on the
    // ["landing_media"] PREFIX, not a category partition: the toggle cannot
    // know which ["landing_media", category] list its row sits in, and the
    // row can sit in several at once (its partition plus the unfiltered
    // list). The other media mutations already invalidate this prefix.
    onMutate: async ({ id, updates }) => {
      await queryClient.cancelQueries({ queryKey: ["landing_media"] });
      const previous = queryClient.getQueriesData<LandingMedia[]>({
        queryKey: ["landing_media"],
      });
      queryClient.setQueriesData<LandingMedia[]>({ queryKey: ["landing_media"] }, (rows) =>
        rows?.map((row) => (row.id === id ? { ...row, ...updates } : row)),
      );
      return { previous };
    },
    // Roll back only the row this mutation touched, not the whole snapshot.
    // Two toggles in flight at once each snapshot the cache as it was before
    // them; restoring a whole snapshot would discard the other mutation's
    // still-pending optimistic row, which then flickers back only when its own
    // request settles.
    onError: (_error, variables, context) => {
      if (!context) return;
      for (const [queryKey, data] of context.previous) {
        const restored = data?.find((row) => row.id === variables.id);
        if (!restored) continue;
        queryClient.setQueryData<LandingMedia[]>(queryKey, (rows) =>
          rows?.map((row) => (row.id === variables.id ? restored : row)),
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["landing_media"] });
    },
  });
}

export function useDeleteLandingMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("landing_media").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["landing_media"] });
    },
  });
}
