import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import {
  cancelContractCloseoutForCurrentSession,
  closeOutContractForCurrentSession,
  previewContractCloseoutForCurrentSession,
  restoreContractForCurrentSession,
  reverseRefundForCurrentSession,
  setInvoiceDisputeForCurrentSession,
  voidRefundForCurrentSession,
  writeOffInvoiceForCurrentSession,
} from "@/lib/closeout";
import type {
  CancelCloseoutInput,
  CloseoutInput,
  DisputeInput,
  PreviewCloseoutInput,
  RestoreInput,
  ReverseRefundInput,
  VoidRefundInput,
  WriteOffInput,
} from "@/lib/closeoutSchemas";
import { PERMISSIONS } from "@/lib/permissions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

export type ContractCloseout = Tables<"contract_closeouts">;
export type ContractCloseoutDeduction = Tables<"contract_closeout_deductions">;
export type ContractCloseoutInvoiceAction = Tables<"contract_closeout_invoice_actions">;
export type ContractOperationalEvent = Tables<"contract_operational_events">;

export interface ContractCloseoutWithLines extends ContractCloseout {
  deductions: ContractCloseoutDeduction[];
  invoiceActions: ContractCloseoutInvoiceAction[];
}

/**
 * يُحدّث أرصدة البوابة بعد الإغلاق أو تغيير حركة مالية مرتبطة بالعقد.
 * The held-insurance RPC also reads close-outs and linked refund lifecycle state.
 */
function invalidateCloseoutRelated(
  queryClient: ReturnType<typeof useQueryClient>,
  contractId?: string | null,
) {
  queryClient.invalidateQueries({ queryKey: ["contracts"] });
  queryClient.invalidateQueries({ queryKey: ["tenants"] });
  queryClient.invalidateQueries({ queryKey: ["units"] });
  queryClient.invalidateQueries({ queryKey: ["invoices"] });
  void invalidatePortalViews(queryClient);
  queryClient.invalidateQueries({ queryKey: ["refunds"] });
  queryClient.invalidateQueries({ queryKey: ["insurance_payments"] });
  queryClient.invalidateQueries({ queryKey: ["budget"] });
  queryClient.invalidateQueries({ queryKey: ["property-monthly-totals"] });
  if (contractId) {
    queryClient.invalidateQueries({ queryKey: ["contract-closeouts", contractId] });
    queryClient.invalidateQueries({ queryKey: ["contract-events", contractId] });
    queryClient.invalidateQueries({ queryKey: ["contract", contractId] });
  } else {
    queryClient.invalidateQueries({ queryKey: ["contract-closeouts"] });
    queryClient.invalidateQueries({ queryKey: ["contract-events"] });
    queryClient.invalidateQueries({ queryKey: ["contract"] });
  }
}

export function useContractCloseouts(contractId: string | null) {
  return useQuery({
    queryKey: ["contract-closeouts", contractId],
    enabled: Boolean(contractId),
    queryFn: async (): Promise<ContractCloseout[]> => {
      const { data, error } = await supabase
        .from("contract_closeouts")
        .select("*")
        .eq("contract_id", contractId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useContractCloseout(id: string | null) {
  return useQuery({
    queryKey: ["contract-closeout", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<ContractCloseoutWithLines> => {
      const header = await supabase.from("contract_closeouts").select("*").eq("id", id!).single();
      if (header.error) throw header.error;
      const [deductions, invoiceActions] = await Promise.all([
        supabase
          .from("contract_closeout_deductions")
          .select("*")
          .eq("closeout_id", id!)
          .order("line", { ascending: true }),
        supabase
          .from("contract_closeout_invoice_actions")
          .select("*")
          .eq("closeout_id", id!)
          .order("created_at", { ascending: true }),
      ]);
      if (deductions.error) throw deductions.error;
      if (invoiceActions.error) throw invoiceActions.error;
      return {
        ...header.data,
        deductions: deductions.data ?? [],
        invoiceActions: invoiceActions.data ?? [],
      };
    },
  });
}

export function useContractOperationalEvents(contractId: string | null) {
  return useQuery({
    queryKey: ["contract-events", contractId],
    enabled: Boolean(contractId),
    queryFn: async (): Promise<ContractOperationalEvent[]> => {
      const { data, error } = await supabase
        .from("contract_operational_events")
        .select("*")
        .eq("contract_id", contractId!)
        .order("occurred_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Live settlement preview for the close-out wizard draft.
 * `enabled` is controlled by the caller (wizard only fetches when the form is ready).
 */
export function useCloseoutPreview(
  contractId: string | null,
  draft: Omit<PreviewCloseoutInput, "contractId"> | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["closeout-preview", contractId, draft],
    enabled: Boolean(contractId && draft && enabled),
    queryFn: async () => {
      const result = await previewContractCloseoutForCurrentSession({
        contractId: contractId!,
        deductions: draft!.deductions,
        invoiceActions: draft!.invoiceActions,
        refundAmount: draft!.refundAmount,
      });
      if (!result?.ok) throw new Error("Close-out preview failed.");
      return result.result;
    },
  });
}

export function useCloseOutContract() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: CloseoutInput) => {
      if (!permissions.can(PERMISSIONS.CONTRACTS_CLOSE_OUT)) {
        throw new Error("Permission denied.");
      }
      const result = await closeOutContractForCurrentSession(input);
      if (!result?.ok) throw new Error("Close-out failed.");
      await logAuditForCurrentSession({
        action: "contract.close_out",
        entityType: "contract",
        entityId: input.contractId,
        after: { outcome: input.outcome, result: result.result },
      });
      return result;
    },
    onSuccess: (_data, input) => {
      invalidateCloseoutRelated(queryClient, input.contractId);
      queryClient.invalidateQueries({ queryKey: ["closeout-preview"] });
    },
  });
}

export function useCancelContractCloseout() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: CancelCloseoutInput & { contractId?: string }) => {
      if (!permissions.can(PERMISSIONS.CONTRACTS_CLOSE_OUT)) {
        throw new Error("Permission denied.");
      }
      const result = await cancelContractCloseoutForCurrentSession(input);
      if (!result?.ok) throw new Error("Cancel close-out failed.");
      await logAuditForCurrentSession({
        action: "contract.cancel_closeout",
        entityType: "contract_closeout",
        entityId: input.closeoutId,
        after: { reason: input.reason, result: result.result },
      });
      return result;
    },
    onSuccess: (_data, input) => {
      invalidateCloseoutRelated(queryClient, input.contractId ?? null);
      if (input.closeoutId) {
        queryClient.invalidateQueries({ queryKey: ["contract-closeout", input.closeoutId] });
      }
    },
  });
}

export function useRestoreContract() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: RestoreInput) => {
      if (!permissions.can(PERMISSIONS.CONTRACTS_RESTORE)) {
        throw new Error("Permission denied.");
      }
      const result = await restoreContractForCurrentSession(input);
      if (!result?.ok) throw new Error("Restore contract failed.");
      await logAuditForCurrentSession({
        action: "contract.restore",
        entityType: "contract",
        entityId: input.contractId,
        after: {
          targetState: input.targetState,
          restoreTenant: input.restoreTenant,
          reason: input.reason,
          result: result.result,
        },
      });
      return result;
    },
    onSuccess: (_data, input) => {
      invalidateCloseoutRelated(queryClient, input.contractId);
    },
  });
}

export function useReverseRefund() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: ReverseRefundInput & { contractId?: string | null }) => {
      if (!permissions.can(PERMISSIONS.REFUNDS_REVERSE)) {
        throw new Error("Permission denied.");
      }
      const result = await reverseRefundForCurrentSession(input);
      if (!result?.ok) throw new Error("Reverse refund failed.");
      await logAuditForCurrentSession({
        action: "refund.reverse",
        entityType: "refund",
        entityId: input.refundId,
        after: { reason: input.reason, rows: result.rows },
      });
      return result;
    },
    onSuccess: (_data, input) => {
      invalidateCloseoutRelated(queryClient, input.contractId ?? null);
    },
  });
}

export function useVoidRefund() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: VoidRefundInput & { contractId?: string | null }) => {
      if (!permissions.can(PERMISSIONS.REFUNDS_VOID)) {
        throw new Error("Permission denied.");
      }
      const result = await voidRefundForCurrentSession(input);
      if (!result?.ok) throw new Error("Void refund failed.");
      await logAuditForCurrentSession({
        action: "refund.void",
        entityType: "refund",
        entityId: input.refundId,
        after: { reason: input.reason },
      });
      return result;
    },
    onSuccess: (_data, input) => {
      invalidateCloseoutRelated(queryClient, input.contractId ?? null);
    },
  });
}

export function useWriteOffInvoice() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: WriteOffInput & { contractId?: string | null }) => {
      if (!permissions.can(PERMISSIONS.INVOICES_WRITE_OFF)) {
        throw new Error("Permission denied.");
      }
      const result = await writeOffInvoiceForCurrentSession(input);
      if (!result?.ok) throw new Error("Write-off failed.");
      return result;
    },
    onSuccess: (_data, input) => {
      invalidateCloseoutRelated(queryClient, input.contractId ?? null);
    },
  });
}

export function useSetInvoiceDispute() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: DisputeInput & { contractId?: string | null }) => {
      if (!permissions.can(PERMISSIONS.INVOICES_DISPUTE)) {
        throw new Error("Permission denied.");
      }
      const result = await setInvoiceDisputeForCurrentSession(input);
      if (!result?.ok) throw new Error("Dispute update failed.");
      return result;
    },
    onSuccess: (_data, input) => {
      invalidateCloseoutRelated(queryClient, input.contractId ?? null);
    },
  });
}
