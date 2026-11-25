import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchExportRows } from "@/lib/pagedQuery";
import { PERMISSIONS } from "@/lib/permissions";
import { assertPdfOrImageWithinStorageLimit } from "@/lib/uploadLimits";
import { notifyDepositConfirmed } from "@/fns/notifyDepositConfirmed";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

/**
 * يبطل ذاكرة الاستعلامات التي قد تتغير بعد كتابة إيداع.
 *
 * Wider than the deposits ledger since migration 152: a confirmed deposit
 * linked to an invoice now creates a real payment and allocation, so the
 * invoice list, the payments list, their summaries, the receipt and the
 * contract detail tabs are all stale afterwards. Before the link existed only
 * the first three keys could change, and leaving it that way would have shown
 * an invoice still reading "due" beside the deposit that just paid it.
 */
function invalidateAfterDepositWrite(queryClient: QueryClient): void {
  for (const key of [
    "deposits",
    "budget",
    "report-preview",
    "invoices",
    "payments",
    "receipts",
    "contract-payments",
  ]) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
  void invalidatePortalViews(queryClient);
}

export type Deposit = Tables<"deposits">;
export interface DepositListParams {
  bank?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  search?: string;
  status?: Deposit["status"];
}
export type DepositAttachmentInput =
  | { mode: "keep" }
  | { mode: "clear" }
  | { mode: "replace"; file: File };

export type CreateDepositInput = Omit<
  TablesInsert<"deposits">,
  "attachment_path" | "created_at" | "created_by" | "id" | "updated_at"
> & { attachment?: { mode: "replace"; file: File } | null };
export type UpdateDepositInput = Omit<
  TablesUpdate<"deposits">,
  "attachment_path" | "created_at" | "created_by" | "id" | "updated_at"
> & { attachment?: DepositAttachmentInput };

/**
 * يجلب مدى صفوف الإيداعات المطابقة للمرشّحات — اللب المشترك بين القائمة والتصدير.
 *
 * Split out of `fetchDeposits` when the export stopped asking for one giant
 * page: the export now requests the same ranged query in a loop, and the two
 * must never disagree about what the filters mean.
 */
async function fetchDepositRange(
  params: Omit<DepositListParams, "page" | "pageSize">,
  from: number,
  to: number,
): Promise<{ rows: Deposit[]; count: number }> {
  let query = supabase
    .from("deposits")
    .select("*", { count: "exact" })
    // `id` is the unique tiebreaker. `deposit_date` alone is not unique, and an
    // offset page boundary that falls between two rows sharing a timestamp can
    // return one of them twice and skip the other. A total order makes each
    // page boundary deterministic (Codex review, PR #218).
    .order("deposit_date", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);
  if (params.dateFrom) query = query.gte("deposit_date", params.dateFrom);
  if (params.dateTo) query = query.lte("deposit_date", params.dateTo);
  if (params.bank) query = query.eq("bank_name", params.bank);
  if (params.status) query = query.eq("status", params.status);
  const term = normalizePostgrestSearch(params.search ?? "");
  if (term) query = query.or(`code.ilike.%${term}%,bank_name.ilike.%${term}%,note.ilike.%${term}%`);
  const result = await query;
  if (result.error) throw result.error;
  return { rows: result.data, count: result.count ?? 0 };
}

/** يجلب صفحة واحدة من الودائع للقائمة — غلاف ترقيم فوق fetchDepositRange. */
async function fetchDeposits(params: DepositListParams) {
  const { page = 1, pageSize = 10 } = params;
  const from = (page - 1) * pageSize;
  const { rows, count } = await fetchDepositRange(params, from, from + pageSize - 1);
  return { items: rows, count };
}

async function uploadAttachment(
  companyId: string | null | undefined,
  id: string,
  file: File,
): Promise<string> {
  assertPdfOrImageWithinStorageLimit(file);
  const extension =
    file.name
      .split(".")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "bin";
  const path = `companies/${companyId ?? "unassigned"}/deposits/${id}/${crypto.randomUUID()}.${extension}`;
  const upload = await supabase.storage
    .from("deposit-attachments")
    .upload(path, file, { upsert: false });
  if (upload.error) throw upload.error;
  return path;
}

export function useDeposits(params: DepositListParams = {}, enabled = true) {
  return useQuery({
    queryKey: ["deposits", params],
    enabled,
    queryFn: () => fetchDeposits(params),
  });
}

/**
 * بيانات تصدير الإيداعات: كل الصفوف المطابقة صفحةً صفحة، لا أول ألف يقتطعها الخادم.
 *
 * The old export asked for `pageSize: 5000`, a number `PGRST_MAX_ROWS = 1000`
 * clips silently — a finance CSV short by four fifths with no error. Paging
 * collects every row; `truncated` is true only if the safety ceiling stopped
 * the loop (S16 finding 1).
 */
export async function fetchDepositExport(
  params: Omit<DepositListParams, "page" | "pageSize">,
): Promise<{ items: Deposit[]; count: number; truncated: boolean }> {
  const { rows, count, truncated } = await fetchExportRows((from, to) =>
    fetchDepositRange(params, from, to),
  );
  return { items: rows, count, truncated };
}

export function useDepositExport(
  params: Omit<DepositListParams, "page" | "pageSize">,
  enabled = true,
) {
  return useQuery({
    queryKey: ["deposits", "export", params],
    enabled,
    queryFn: () => fetchDepositExport(params),
  });
}

export function useDepositTotal(
  params: Omit<DepositListParams, "page" | "pageSize">,
  enabled = true,
) {
  return useQuery({
    queryKey: ["deposits", "total", params],
    enabled,
    queryFn: async () => {
      const term = normalizePostgrestSearch(params.search ?? "");
      const result = await supabase.rpc("get_deposit_total", {
        p_bank: params.bank ?? null,
        p_from: params.dateFrom ?? null,
        p_search: term || null,
        p_status: params.status ?? null,
        p_to: params.dateTo ?? null,
      });
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useDepositBanks(enabled = true) {
  return useQuery({
    queryKey: ["deposits", "banks"],
    enabled,
    queryFn: async () => {
      const result = await supabase
        .from("deposits")
        .select("bank_name")
        .order("bank_name")
        .limit(1000);
      if (result.error) throw result.error;
      return [...new Set(result.data.map((item) => item.bank_name))];
    },
  });
}

export function useCreateDeposit() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ attachment, ...values }: CreateDepositInput) => {
      if (!permissions.can(PERMISSIONS.DEPOSITS_CREATE)) throw new Error("Permission denied.");
      const id = crypto.randomUUID();
      let attachmentPath: string | null = null;
      if (attachment && attachment.mode === "replace") {
        attachmentPath = await uploadAttachment(values.company_id, id, attachment.file);
      }
      const user = await supabase.auth.getUser();
      const result = await supabase
        .from("deposits")
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
          await supabase.storage.from("deposit-attachments").remove([attachmentPath]);
        throw result.error;
      }
      await logAuditForCurrentSession({
        action: "deposit.create",
        entityType: "deposit",
        entityId: result.data.id,
        after: result.data,
      });
      if (result.data.status === "confirmed") {
        try {
          await notifyDepositConfirmed({ data: { depositId: result.data.id } });
        } catch (error) {
          console.error("Deposit confirmation notification failed", error);
        }
      }
      return result.data;
    },
    onSuccess: () => invalidateAfterDepositWrite(queryClient),
  });
}

export function useUpdateDeposit() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: UpdateDepositInput }) => {
      if (!permissions.can(PERMISSIONS.DEPOSITS_UPDATE)) throw new Error("Permission denied.");
      const before = await supabase.from("deposits").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const { attachment, ...values } = updates;
      let attachmentPath = before.data.attachment_path;
      let uploadedPath: string | null = null;
      if (attachment) {
        if (attachment.mode === "replace") {
          uploadedPath = await uploadAttachment(
            values.company_id ?? before.data.company_id,
            id,
            attachment.file,
          );
          attachmentPath = uploadedPath;
        } else if (attachment.mode === "clear") {
          attachmentPath = null;
        }
        // mode === "keep" → preserve attachmentPath as-is
      }
      const after = await supabase
        .from("deposits")
        .update({ ...values, attachment_path: attachmentPath })
        .eq("id", id)
        .select("*")
        .single();
      if (after.error) {
        if (uploadedPath) await supabase.storage.from("deposit-attachments").remove([uploadedPath]);
        throw after.error;
      }
      // Clean up the previous file from storage on successful replace or clear.
      if (before.data.attachment_path && (uploadedPath || attachment?.mode === "clear")) {
        await supabase.storage.from("deposit-attachments").remove([before.data.attachment_path]);
      }
      await logAuditForCurrentSession({
        action: "deposit.update",
        entityType: "deposit",
        entityId: id,
        before: before.data,
        after: after.data,
      });
      if (after.data.status === "confirmed" && before.data.status !== "confirmed") {
        try {
          await notifyDepositConfirmed({ data: { depositId: after.data.id } });
        } catch (error) {
          console.error("Deposit confirmation notification failed", error);
        }
      }
      return after.data;
    },
    onSuccess: () => invalidateAfterDepositWrite(queryClient),
  });
}

export function useDeleteDeposit() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (deposit: Deposit) => {
      if (!permissions.can(PERMISSIONS.DEPOSITS_DELETE)) throw new Error("Permission denied.");
      const result = await supabase.from("deposits").delete().eq("id", deposit.id);
      if (result.error) throw result.error;
      if (deposit.attachment_path)
        await supabase.storage.from("deposit-attachments").remove([deposit.attachment_path]);
      await logAuditForCurrentSession({
        action: "deposit.delete",
        entityType: "deposit",
        entityId: deposit.id,
        before: deposit,
      });
    },
    onSuccess: () => invalidateAfterDepositWrite(queryClient),
  });
}
