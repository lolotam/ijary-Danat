import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { resolveUploadCompanyId } from "@/company/browserCompany";
import { companyStoragePath } from "@/company/storagePath";
import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type {
  ExpenseClass,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchInChunks } from "@/lib/idChunks";
import { fetchExportRows } from "@/lib/pagedQuery";
import { PERMISSIONS } from "@/lib/permissions";
import { assertPdfOrImageWithinStorageLimit } from "@/lib/uploadLimits";

export type Expense = Tables<"expenses">;
export type ExpenseCategory = Tables<"expense_categories">;
export interface ExpenseWithRelations extends Expense {
  building: Pick<Tables<"buildings">, "code" | "name_ar" | "name_en"> | null;
  category: ExpenseCategory | null;
  property: Pick<Tables<"properties">, "code" | "name_ar" | "name_en"> | null;
  unit: Pick<Tables<"units">, "code" | "name"> | null;
}
export interface ExpenseListParams {
  categoryId?: string;
  class?: ExpenseClass;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  propertyId?: string;
  search?: string;
  status?: Expense["status"];
}
export type CreateExpenseInput = Omit<
  TablesInsert<"expenses">,
  "attachment_path" | "created_at" | "created_by" | "id" | "updated_at"
> & { attachment?: File | null };
export type UpdateExpenseInput = Omit<
  TablesUpdate<"expenses">,
  "attachment_path" | "created_at" | "created_by" | "id" | "updated_at"
> & { attachment?: File | null };

/**
 * يلحق بالصفوف علاقاتها (الفئة، العقار، المبنى، الوحدة) على دفعات لا في مرشّح واحد.
 *
 * The lookups go through `fetchInChunks` because the paged export can now feed
 * this more ids than one `in()` filter can carry in a URL — the 8 KB gateway
 * limit measured in PR #160. Below one chunk the request is exactly what it
 * always was, so the list page is unchanged.
 */
async function attachExpenseRelations(expenses: Expense[]): Promise<ExpenseWithRelations[]> {
  const categoryIds = [
    ...new Set(expenses.flatMap((item) => (item.category_id ? [item.category_id] : []))),
  ];
  const propertyIds = [
    ...new Set(expenses.flatMap((item) => (item.property_id ? [item.property_id] : []))),
  ];
  const buildingIds = [
    ...new Set(expenses.flatMap((item) => (item.building_id ? [item.building_id] : []))),
  ];
  const unitIds = [...new Set(expenses.flatMap((item) => (item.unit_id ? [item.unit_id] : [])))];
  const [categories, properties, buildings, units] = await Promise.all([
    categoryIds.length
      ? fetchInChunks(categoryIds, (chunk) =>
          supabase.from("expense_categories").select("*").in("id", chunk),
        )
      : Promise.resolve([] as ExpenseCategory[]),
    propertyIds.length
      ? fetchInChunks(propertyIds, (chunk) =>
          supabase.from("properties").select("id,code,name_ar,name_en").in("id", chunk),
        )
      : Promise.resolve(
          [] as Array<Pick<Tables<"properties">, "id" | "code" | "name_ar" | "name_en">>,
        ),
    buildingIds.length
      ? fetchInChunks(buildingIds, (chunk) =>
          supabase.from("buildings").select("id,code,name_ar,name_en").in("id", chunk),
        )
      : Promise.resolve(
          [] as Array<Pick<Tables<"buildings">, "id" | "code" | "name_ar" | "name_en">>,
        ),
    unitIds.length
      ? fetchInChunks(unitIds, (chunk) =>
          supabase.from("units").select("id,code,name").in("id", chunk),
        )
      : Promise.resolve([] as Array<Pick<Tables<"units">, "id" | "code" | "name">>),
  ]);
  const categoryMap = new Map(categories.map((item) => [item.id, item]));
  const propertyMap = new Map(properties.map((item) => [item.id, item]));
  const buildingMap = new Map(buildings.map((item) => [item.id, item]));
  const unitMap = new Map(units.map((item) => [item.id, item]));
  return expenses.map((expense) => ({
    ...expense,
    category: expense.category_id ? (categoryMap.get(expense.category_id) ?? null) : null,
    property: expense.property_id ? (propertyMap.get(expense.property_id) ?? null) : null,
    building: expense.building_id ? (buildingMap.get(expense.building_id) ?? null) : null,
    unit: expense.unit_id ? (unitMap.get(expense.unit_id) ?? null) : null,
  }));
}

/**
 * يجلب مدى صفوف المصروفات المطابقة للمرشّحات — اللب المشترك بين القائمة والتصدير.
 */
async function fetchExpenseRange(
  params: Omit<ExpenseListParams, "page" | "pageSize">,
  from: number,
  to: number,
): Promise<{ rows: Expense[]; count: number }> {
  let query = supabase
    .from("expenses")
    .select("*", { count: "exact" })
    // `id` is the unique tiebreaker. `expense_date` alone is not unique, and an
    // offset page boundary that falls between two rows sharing a timestamp can
    // return one of them twice and skip the other. A total order makes each
    // page boundary deterministic (Codex review, PR #218).
    .order("expense_date", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);
  if (params.class) query = query.eq("class", params.class);
  if (params.categoryId) query = query.eq("category_id", params.categoryId);
  if (params.propertyId) query = query.eq("property_id", params.propertyId);
  if (params.dateFrom) query = query.gte("expense_date", params.dateFrom);
  if (params.dateTo) query = query.lte("expense_date", params.dateTo);
  if (params.status) query = query.eq("status", params.status);
  const term = normalizePostgrestSearch(params.search ?? "");
  if (term)
    query = query.or(
      `code.ilike.%${term}%,payee.ilike.%${term}%,cost_center.ilike.%${term}%,note.ilike.%${term}%`,
    );
  const result = await query;
  if (result.error) throw result.error;
  return { rows: result.data, count: result.count ?? 0 };
}

/** يجلب صفحة واحدة من المصروفات للقائمة — غلاف ترقيم فوق fetchExpenseRange. */
async function fetchExpenses(params: ExpenseListParams) {
  const { page = 1, pageSize = 10 } = params;
  const from = (page - 1) * pageSize;
  const { rows, count } = await fetchExpenseRange(params, from, from + pageSize - 1);
  return { items: await attachExpenseRelations(rows), count };
}

async function uploadAttachment(
  bucket: "expense-attachments",
  companyId: string | null | undefined,
  id: string,
  file: File,
): Promise<string> {
  assertPdfOrImageWithinStorageLimit(file);
  const resolvedCompanyId = await resolveUploadCompanyId(companyId);
  const extension =
    file.name
      .split(".")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "bin";
  const path = companyStoragePath(
    resolvedCompanyId,
    `expenses/${id}/${crypto.randomUUID()}.${extension}`,
  );
  const upload = await supabase.storage.from(bucket).upload(path, file, { upsert: false });
  if (upload.error) throw upload.error;
  return path;
}

export function useExpenses(params: ExpenseListParams = {}, enabled = true) {
  return useQuery({
    queryKey: ["expenses", params],
    enabled,
    queryFn: () => fetchExpenses(params),
  });
}

/**
 * بيانات تصدير المصروفات: كل الصفوف المطابقة صفحةً صفحة، والعلاقات تُلحق مرة واحدة بعد الجمع.
 */
export async function fetchExpenseExport(
  params: Omit<ExpenseListParams, "page" | "pageSize">,
): Promise<{ items: ExpenseWithRelations[]; count: number; truncated: boolean }> {
  const { rows, count, truncated } = await fetchExportRows((from, to) =>
    fetchExpenseRange(params, from, to),
  );
  return { items: await attachExpenseRelations(rows), count, truncated };
}

export function useExpenseExport(
  params: Omit<ExpenseListParams, "page" | "pageSize">,
  enabled = true,
) {
  return useQuery({
    queryKey: ["expenses", "export", params],
    enabled,
    queryFn: () => fetchExpenseExport(params),
  });
}

export function useExpenseCategories(enabled = true) {
  return useQuery({
    queryKey: ["expense-categories"],
    enabled,
    queryFn: async () => {
      const result = await supabase
        .from("expense_categories")
        .select("*")
        .order("sort_order")
        .order("name_ar");
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useCreateExpenseCategory() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: TablesInsert<"expense_categories">) => {
      if (!permissions.can(PERMISSIONS.EXPENSES_CATEGORIES)) throw new Error("Permission denied.");
      const result = await supabase.from("expense_categories").insert(values).select("*").single();
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "expense_category.create",
        entityType: "expense_category",
        entityId: result.data.id,
        after: result.data,
      });
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["expense-categories"] }),
  });
}

export function useUpdateExpenseCategory() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TablesUpdate<"expense_categories">;
    }) => {
      if (!permissions.can(PERMISSIONS.EXPENSES_CATEGORIES)) throw new Error("Permission denied.");
      const before = await supabase.from("expense_categories").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const after = await supabase
        .from("expense_categories")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (after.error) throw after.error;
      await logAuditForCurrentSession({
        action: "expense_category.update",
        entityType: "expense_category",
        entityId: id,
        before: before.data,
        after: after.data,
      });
      return after.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["expense-categories"] }),
  });
}

export function useDeleteExpenseCategory() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (category: ExpenseCategory) => {
      if (!permissions.can(PERMISSIONS.EXPENSES_CATEGORIES)) throw new Error("Permission denied.");
      const result = await supabase.from("expense_categories").delete().eq("id", category.id);
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "expense_category.delete",
        entityType: "expense_category",
        entityId: category.id,
        before: category,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["expense-categories"] }),
  });
}

export function useCreateExpense() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ attachment, ...values }: CreateExpenseInput) => {
      if (!permissions.can(PERMISSIONS.EXPENSES_CREATE)) throw new Error("Permission denied.");
      const id = crypto.randomUUID();
      let attachmentPath: string | null = null;
      if (attachment)
        attachmentPath = await uploadAttachment(
          "expense-attachments",
          values.company_id,
          id,
          attachment,
        );
      const user = await supabase.auth.getUser();
      const result = await supabase
        .from("expenses")
        .insert({
          ...values,
          id,
          attachment_path: attachmentPath,
          created_by: user.data.user?.id ?? null,
        })
        .select("*")
        .single();
      if (result.error) {
        if (attachmentPath)
          await supabase.storage.from("expense-attachments").remove([attachmentPath]);
        throw result.error;
      }
      await logAuditForCurrentSession({
        action: "expense.create",
        entityType: "expense",
        entityId: result.data.id,
        after: result.data,
      });
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["budget"] });
      queryClient.invalidateQueries({ queryKey: ["report-preview"] });
    },
  });
}

export function useUpdateExpense() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: UpdateExpenseInput }) => {
      if (!permissions.can(PERMISSIONS.EXPENSES_UPDATE)) throw new Error("Permission denied.");
      const before = await supabase.from("expenses").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const { attachment, ...values } = updates;
      let attachmentPath = before.data.attachment_path;
      let uploadedPath: string | null = null;
      if (attachment) {
        uploadedPath = await uploadAttachment(
          "expense-attachments",
          values.company_id ?? before.data.company_id,
          id,
          attachment,
        );
        attachmentPath = uploadedPath;
      }
      const after = await supabase
        .from("expenses")
        .update({ ...values, attachment_path: attachmentPath })
        .eq("id", id)
        .select("*")
        .single();
      if (after.error) {
        if (uploadedPath) await supabase.storage.from("expense-attachments").remove([uploadedPath]);
        throw after.error;
      }
      if (uploadedPath && before.data.attachment_path) {
        await supabase.storage.from("expense-attachments").remove([before.data.attachment_path]);
      }
      await logAuditForCurrentSession({
        action: "expense.update",
        entityType: "expense",
        entityId: id,
        before: before.data,
        after: after.data,
      });
      return after.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["budget"] });
      queryClient.invalidateQueries({ queryKey: ["report-preview"] });
    },
  });
}

export function useDeleteExpense() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (expense: Expense) => {
      if (!permissions.can(PERMISSIONS.EXPENSES_DELETE)) throw new Error("Permission denied.");
      const result = await supabase.from("expenses").delete().eq("id", expense.id);
      if (result.error) throw result.error;
      if (expense.attachment_path)
        await supabase.storage.from("expense-attachments").remove([expense.attachment_path]);
      await logAuditForCurrentSession({
        action: "expense.delete",
        entityType: "expense",
        entityId: expense.id,
        before: expense,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["budget"] });
      queryClient.invalidateQueries({ queryKey: ["report-preview"] });
    },
  });
}
