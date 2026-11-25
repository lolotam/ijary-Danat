import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { catalogueLabelFor } from "@/lib/commercialActivityOptions";

export type OptionList = Tables<"option_lists">;
export type OptionListItem = Tables<"option_list_items">;

export function useOptionLists() {
  return useQuery({
    queryKey: ["option-lists"],
    queryFn: async (): Promise<OptionList[]> => {
      const { data, error } = await supabase.from("option_lists").select("*").order("name_en");
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useOptionListItems(listId: string | null) {
  return useQuery({
    queryKey: ["option-list-items", listId],
    enabled: Boolean(listId),
    queryFn: async (): Promise<OptionListItem[]> => {
      const { data, error } = await supabase
        .from("option_list_items")
        .select("*")
        .eq("list_id", listId!)
        .order("sort_order")
        .order("label_en");
      if (error) throw error;
      return data;
    },
  });
}

/** Fetch items by list code (e.g. "contract_types") — convenient for forms. */
export function useOptionListItemsByCode(code: string, enabled = true) {
  return useQuery({
    queryKey: ["option-list-items-by-code", code],
    enabled,
    queryFn: async (): Promise<OptionListItem[]> => {
      const { data: list, error: listErr } = await supabase
        .from("option_lists")
        .select("id")
        .eq("code", code)
        .single();
      if (listErr) throw listErr;
      const { data, error } = await supabase
        .from("option_list_items")
        .select("*")
        .eq("list_id", list.id)
        .eq("is_active", true)
        .order("sort_order")
        .order("label_en");
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Locale-aware select options driven by a Settings > Lists catalog.
 *
 * Only active items are returned, so toggling an item inactive removes it from
 * every form that uses the list. Values are restricted to `allowedValues`
 * (the Postgres enum) — a custom value outside the enum would be rejected by
 * the database on save. While the catalog is loading (or on error) the enum
 * values with their translated labels are used so forms never render empty.
 */
export function useListDrivenOptions(
  code: string,
  allowedValues: readonly string[],
  translatePrefix: string,
): Array<{ value: string; label: string }> {
  const { locale, t } = useI18n();
  const items = useOptionListItemsByCode(code);
  if (!items.data) {
    return allowedValues.map((value) => ({ value, label: t(`${translatePrefix}.${value}`) }));
  }
  const allowed = new Set(allowedValues);
  return items.data
    .filter((item) => allowed.has(item.value))
    .map((item) => ({
      value: item.value,
      label:
        (locale === "ar" ? item.label_ar : item.label_en) || t(`${translatePrefix}.${item.value}`),
    }));
}

/**
 * دالة تسمية للأعمدة الحرة المعتمدة على قوائم الإعدادات.
 *
 * Returns a resolver rather than a string so one hook call labels a whole
 * column — a hook per row is not possible, and refetching the catalogue per
 * cell would be wasteful. `useOptionListItemsByCode` is already cached for five
 * minutes and shared across call sites.
 *
 * Pairs with the select-side `mapCatalogueOptions`. Use it for any column made
 * free text by migrations 99 / 101 / 103; do NOT use it for enum-backed columns
 * (`contract_types`, `unit_statuses`, …), whose values are closed sets that the
 * dictionary covers exhaustively.
 */
export function useCatalogueLabel(
  code: string,
  translatePrefix: string,
): (value: string) => string {
  const { locale, t } = useI18n();
  const items = useOptionListItemsByCode(code);
  return (value: string) =>
    catalogueLabelFor({ items: items.data ?? [], locale, value, translate: t, translatePrefix });
}

export function useCreateOptionListItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: TablesInsert<"option_list_items">) => {
      const { data, error } = await supabase
        .from("option_list_items")
        .insert(values)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "option_list_item.create",
        entityType: "option_list_item",
        entityId: data.id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: ["option-list-items", item.list_id] });
      queryClient.invalidateQueries({ queryKey: ["option-list-items-by-code"] });
    },
  });
}

export function useUpdateOptionListItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TablesUpdate<"option_list_items">;
    }) => {
      const { data, error } = await supabase
        .from("option_list_items")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "option_list_item.update",
        entityType: "option_list_item",
        entityId: id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: ["option-list-items", item.list_id] });
      queryClient.invalidateQueries({ queryKey: ["option-list-items-by-code"] });
    },
  });
}

/**
 * يعدّ السجلات التي ستتغير عند إعادة تسمية قيمة عنصر القائمة، لعرضها قبل التنفيذ.
 *
 * Previews the cascade; it changes nothing — the rename itself goes through
 * `useRenameOptionListValue` after the admin confirms the counts.
 */
export function useOptionListValueUsage() {
  return useMutation({
    mutationFn: async (itemId: string) => {
      const { data, error } = await supabase.rpc("count_option_list_value_usage", {
        p_item_id: itemId,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  });
}

/**
 * يعيد تسمية قيمة عنصر القائمة وكل السجلات التي تخزنها في معاملة واحدة على الخادم.
 *
 * Invalidates every query whose rows store a list value — the real roots in
 * useUnits / useProperties / useContracts (list + single), deposits and the
 * Gmail inbox — so tables and forms pick up the new value without a reload.
 */
export function useRenameOptionListValue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, newValue }: { itemId: string; newValue: string }) => {
      const { data, error } = await supabase.rpc("rename_option_list_value", {
        p_item_id: itemId,
        p_new_value: newValue,
      });
      if (error) throw error;
      return data as { updated: Record<string, number> };
    },
    onSuccess: () => {
      for (const key of [
        "option-lists",
        "option-list-items",
        "option-list-items-by-code",
        "units",
        "unit",
        "properties",
        "property",
        "contracts",
        "contract",
        "deposits",
        "gmail-messages",
        "gmail-message",
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useDeleteOptionListItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (item: OptionListItem) => {
      const { error } = await supabase.from("option_list_items").delete().eq("id", item.id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "option_list_item.delete",
        entityType: "option_list_item",
        entityId: item.id,
        before: { ...item },
      });
      return item;
    },
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: ["option-list-items", item.list_id] });
      queryClient.invalidateQueries({ queryKey: ["option-list-items-by-code"] });
    },
  });
}
