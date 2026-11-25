import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCompany } from "@/hooks/useCompany";
import { supabase } from "@/integrations/supabase/client";
import type { CardVisibilityRow } from "@/integrations/supabase/database.types";

/**
 * الأعمدة التي تقرأها الواجهة فقط، مشتقّة من صفّ الجدول لا مكرّرة عنه.
 *
 * Derived from the table row rather than re-declared, so a column rename in
 * database.types.ts breaks this at compile time instead of drifting silently.
 */
export type CardVisibilityFlag = Pick<CardVisibilityRow, "card_id" | "is_visible">;

const QUERY_KEY = ["card-visibility"] as const;

/**
 * يبني دالة الفحص: البطاقة ظاهرة ما لم يوجد صفّ يخفيها.
 *
 * Kept as a plain function rather than folded into the hook so the rule can be
 * asserted directly. The default matters: a card with no row is VISIBLE, so a
 * failed or empty read degrades to showing everything rather than to a blank
 * page.
 */
export function resolveCardVisibility(rows: CardVisibilityFlag[]): (cardId: string) => boolean {
  const hidden = new Set(rows.filter((row) => !row.is_visible).map((row) => row.card_id));
  return (cardId: string) => !hidden.has(cardId);
}

/**
 * إعدادات إظهار بطاقات المؤشرات على مستوى الشركة.
 *
 * While the config is loading `isCardVisible` returns true for everything, so
 * the cards do not flicker in from an empty state on every navigation.
 * `isReady` is true only after both the company and flag reads succeeded —
 * portal gates fail closed on that, because treating a failed read as
 * "visible" would un-hide a section the office had switched off.
 */
export function useCardVisibility() {
  const company = useCompany();
  const companyId = company.data?.id ?? null;
  const query = useQuery({
    // The company is in the key, not only in the filter: switching company must
    // not serve the previous one's hidden cards from cache.
    queryKey: [...QUERY_KEY, companyId],
    enabled: Boolean(companyId),
    queryFn: async (): Promise<CardVisibilityFlag[]> => {
      const { data, error } = await supabase
        .from("card_visibility")
        .select("card_id, is_visible")
        .eq("company_id", companyId!);
      if (error) throw error;
      return data ?? [];
    },
  });

  return {
    isCardVisible: resolveCardVisibility(query.data ?? []),
    isLoading: company.isLoading || query.isLoading,
    isReady: company.isSuccess && query.isSuccess,
    error: company.error ?? query.error,
  };
}

/**
 * يبدّل ظهور بطاقة واحدة لكل مستخدمي الشركة.
 *
 * Upserts rather than inserts: the primary key is (company_id, card_id), and an
 * admin toggling a card off and on again must not collide with the row they
 * created a moment ago. PostgREST infers `onConflict` from the primary key when
 * omitted, but for a composite key supabase-js needs it stated explicitly —
 * otherwise the second toggle of the same card raises a duplicate-key error
 * instead of updating.
 */
export function useSetCardVisibility() {
  const queryClient = useQueryClient();
  const company = useCompany();

  return useMutation({
    mutationFn: async ({ cardId, isVisible }: { cardId: string; isVisible: boolean }) => {
      const companyId = company.data?.id;
      if (!companyId) throw new Error("No company is configured.");
      const { error } = await supabase
        .from("card_visibility")
        .upsert(
          { company_id: companyId, card_id: cardId, is_visible: isVisible },
          { onConflict: "company_id,card_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      // Prefix match, so it invalidates whichever company id the read keyed on.
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}
