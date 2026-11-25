import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import { fetchInChunks } from "@/lib/idChunks";
import type {
  PaymentAccountType,
  PaymentMethod,
  Tables,
} from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { notifyPaymentSuccessFn } from "@/fns/notifyPaymentSuccess";
import { PERMISSIONS } from "@/lib/permissions";
import { assertPdfOrImageWithinStorageLimit } from "@/lib/uploadLimits";
import { FINANCE_QUERY_OPTIONS } from "@/hooks/financeQueryOptions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

export interface PaymentWithTenant extends Tables<"payments"> {
  tenant: Tables<"tenants"> | null;
}
export interface PaymentListParams {
  /** Inclusive lower bound on `payment_date` (yyyy-mm-dd). */
  dateFrom?: string;
  /** Inclusive upper bound on `payment_date` (yyyy-mm-dd). */
  dateTo?: string;
  /** Inclusive lower bound on `amount`, in KWD. */
  amountMin?: number;
  /** Inclusive upper bound on `amount`, in KWD. */
  amountMax?: number;
  method?: PaymentMethod;
  page?: number;
  pageSize?: number;
  search?: string;
  status?: "pending" | "confirmed" | "reversed";
  tenantId?: string;
}
export interface CreateManualPaymentInput {
  accountType: PaymentAccountType | null;
  amount: number;
  attachment?: File | null;
  companyId: string | null;
  method: PaymentMethod;
  note?: string;
  /**
   * When false, skip the success notification so a multi-invoice settlement can
   * fire one aggregated notify for the whole batch instead of one receipt per
   * payment row. Default (undefined) keeps existing single-payment behaviour.
   */
  notify?: boolean;
  paymentDate: string;
  reference?: string;
  tenantId: string;
  unitId?: string | null;
}

export function usePayments(params: PaymentListParams = {}, enabled = true) {
  const {
    amountMax,
    amountMin,
    dateFrom,
    dateTo,
    method,
    page = 1,
    pageSize = 10,
    search = "",
    status,
    tenantId,
  } = params;
  return useQuery({
    // Every filter is in the key: one left out means changing it shows the
    // previous filter's rows from cache.
    queryKey: [
      "payments",
      { amountMax, amountMin, dateFrom, dateTo, method, page, pageSize, search, status, tenantId },
    ],
    enabled,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: async () => {
      const from = (page - 1) * pageSize;
      let query = supabase
        .from("payments")
        .select("*", { count: "exact" })
        // Order by entry time, not accounting date. `set_invoice_paid` backdates
        // payment_date into the invoice's own period (migration 23), so a payment
        // recorded today can carry a months-old date and never surface on page 1 —
        // which reads as "marking the invoice paid created nothing".
        // The id tiebreaker keeps LIMIT/OFFSET paging stable: without a unique
        // second key, rows sharing a timestamp may be ordered differently per
        // request and a row can land on no page at all.
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + pageSize - 1);
      if (method) query = query.eq("method", method);
      if (status) query = query.eq("status", status);
      if (tenantId) query = query.eq("tenant_id", tenantId);
      // Bounds are inclusive on both ends: an admin filtering a single day types
      // the same date twice and expects that day's payments, not none.
      if (dateFrom) query = query.gte("payment_date", dateFrom);
      if (dateTo) query = query.lte("payment_date", dateTo);
      // Compared against null, not falsiness — a 0 lower bound is a real filter
      // and must not be dropped for looking empty.
      if (amountMin != null) query = query.gte("amount", amountMin);
      if (amountMax != null) query = query.lte("amount", amountMax);
      const term = normalizePostgrestSearch(search);
      if (term) {
        const { data: matchedTenants, error: tenantSearchError } = await supabase
          .from("tenants")
          .select("id")
          .or(`code.ilike.%${term}%,name.ilike.%${term}%`)
          .limit(100);
        if (tenantSearchError) throw tenantSearchError;
        const tenantClause = matchedTenants.length
          ? `,tenant_id.in.(${matchedTenants.map((tenant) => tenant.id).join(",")})`
          : "";
        query = query.or(`code.ilike.%${term}%,reference.ilike.%${term}%${tenantClause}`);
      }
      const { data, error, count } = await query;
      if (error) throw error;
      const tenantIds = [...new Set(data.map((payment) => payment.tenant_id))];
      const tenantResult = tenantIds.length
        ? await supabase.from("tenants").select("*").in("id", tenantIds)
        : { data: [] as Tables<"tenants">[], error: null };
      if (tenantResult.error) throw tenantResult.error;
      const tenants = new Map(tenantResult.data.map((tenant) => [tenant.id, tenant]));
      return {
        items: data.map((payment) => ({
          ...payment,
          tenant: tenants.get(payment.tenant_id) ?? null,
        })) as PaymentWithTenant[],
        count: count ?? 0,
      };
    },
  });
}

/**
 * Ids of every payment that settled an invoice carrying a line item attributed
 * to this unit.
 *
 * `set_invoice_paid` (migration 108) copies `invoices.unit_id` into
 * `payments.unit_id`, and that column is NULL for a consolidated multi-unit
 * invoice (migration 112). Filtering the unit page's Payments tab on
 * `payments.unit_id` alone therefore hid every payment made against a
 * multi-unit contract — the same gap that was already fixed for the Invoices
 * tab immediately above it, which would otherwise have the two tabs on one
 * page answering the same question differently.
 *
 * A consolidated payment genuinely belongs to no single unit, so this does not
 * try to apportion it: the payment is listed under every unit its invoice
 * touches, exactly as the consolidated invoice itself already is.
 *
 * Payments with no allocations at all (an unapplied advance) are unaffected —
 * they still surface through their own `payments.unit_id`, which the caller
 * unions with this set.
 */
export async function fetchUnitPaymentIds(unitId: string): Promise<Set<string>> {
  if (!unitId) return new Set();
  const { data: items, error: itemError } = await supabase
    .from("invoice_items")
    .select("invoice_id")
    .eq("unit_id", unitId);
  if (itemError) throw itemError;
  const invoiceIds = [...new Set(items.map((row) => row.invoice_id))];
  // `.in(column, [])` is not a valid PostgREST filter, so short-circuit.
  if (!invoiceIds.length) return new Set();
  // Chunked: a unit on a twenty-year lease carries 238 invoices, past the
  // gateway URL ceiling for a single `in()` filter.
  const rows = await fetchInChunks(invoiceIds, (chunk) =>
    supabase.from("payment_allocations").select("payment_id").in("invoice_id", chunk),
  );
  return new Set(rows.map((row) => row.payment_id));
}

export function useUnitPaymentIds(unitId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["unit-payment-ids", unitId],
    enabled: Boolean(unitId) && enabled,
    queryFn: () => fetchUnitPaymentIds(unitId!),
  });
}

export function useCreateManualPayment() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: CreateManualPaymentInput) => {
      if (!permissions.can(PERMISSIONS.PAYMENTS_CREATE)) throw new Error("Permission denied.");
      const id = crypto.randomUUID();
      let attachmentPath: string | null = null;
      if (input.attachment) {
        assertPdfOrImageWithinStorageLimit(input.attachment);
        const extension = input.attachment.name
          .split(".")
          .pop()
          ?.toLowerCase()
          .replace(/[^a-z0-9]/g, "");
        attachmentPath = `companies/${input.companyId ?? "unassigned"}/tenants/${input.tenantId}/payments/${id}/evidence.${extension || "bin"}`;
        const { error: uploadError } = await supabase.storage
          .from("payment-attachments")
          .upload(attachmentPath, input.attachment, { upsert: false });
        if (uploadError) throw uploadError;
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("payments")
        .insert({
          id,
          company_id: input.companyId,
          tenant_id: input.tenantId,
          account_type: input.accountType,
          method: input.method,
          amount: input.amount,
          payment_date: input.paymentDate,
          reference: input.reference || null,
          unit_id: input.unitId || null,
          attachment_path: attachmentPath,
          note: input.note || null,
          created_by: user?.id ?? null,
          status: "confirmed",
        })
        .select("*")
        .single();
      if (error) {
        if (attachmentPath)
          await supabase.storage.from("payment-attachments").remove([attachmentPath]);
        throw error;
      }
      await logAuditForCurrentSession({
        action: "payment.create",
        entityType: "payment",
        entityId: data.id,
        after: data,
      });
      const { data: receipt, error: receiptError } = await supabase
        .from("receipts")
        .select("*")
        .eq("payment_id", data.id)
        .maybeSingle();
      if (!receiptError && receipt) {
        await logAuditForCurrentSession({
          action: "receipt.create",
          entityType: "receipt",
          entityId: receipt.id,
          after: receipt,
        });
      }
      if (input.notify !== false) {
        try {
          await notifyPaymentSuccessFn({ data: { paymentIds: [data.id] } });
        } catch (error) {
          console.error("Payment notifications failed", error);
        }
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      void invalidatePortalViews(queryClient);
      queryClient.invalidateQueries({ queryKey: ["receipts"] });
    },
  });
}
