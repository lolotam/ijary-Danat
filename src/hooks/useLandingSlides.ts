/**
 * شرائح العرض في صفحة الهبوط: الاستعلام والطفرات.
 *
 * Split out of `useLandingSettings.ts`, which re-exports everything here — import
 * from `@/hooks/useLandingSettings`, not this file, so test mocks of that path keep
 * intercepting.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { requireLandingCompanyId, useLandingCompanyId } from "@/hooks/useLandingSettings";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";

export type LandingCarouselSlide = Tables<"landing_carousel_slides">;
export type LandingCarouselSlideInsert = TablesInsert<"landing_carousel_slides">;
export type LandingCarouselSlideUpdate = TablesUpdate<"landing_carousel_slides">;

// 5. Landing Carousel Slides Query & Mutations
/**
 * شرائح العرض في صفحة الهبوط للشركة صاحبة المضيف.
 */
export function useLandingSlides(enabled = true) {
  const { data: companyId } = useLandingCompanyId(enabled);

  return useQuery({
    queryKey: ["landing_carousel_slides", companyId],
    enabled: enabled && Boolean(companyId),
    queryFn: async (): Promise<LandingCarouselSlide[]> => {
      const { data, error } = await supabase
        .from("landing_carousel_slides")
        .select(
          `
          *,
          media:media_id ( storage_path ),
          mobile_media:mobile_media_id ( storage_path )
        `,
        )
        .eq("company_id", requireLandingCompanyId(companyId))
        .order("display_order", { ascending: true });

      if (error) throw error;
      return data as any;
    },
  });
}

export function useCreateSlide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slide: LandingCarouselSlideInsert) => {
      const { data, error } = await supabase
        .from("landing_carousel_slides")
        .insert(slide)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["landing_carousel_slides"] });
    },
  });
}

export function useUpdateSlide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: LandingCarouselSlideUpdate }) => {
      const { data, error } = await supabase
        .from("landing_carousel_slides")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["landing_carousel_slides"] });
    },
  });
}

export function useDeleteSlide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("landing_carousel_slides").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["landing_carousel_slides"] });
    },
  });
}
