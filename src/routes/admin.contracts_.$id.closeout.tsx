import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { guardModuleRoute } from "@/company/requireModule";
import { useFieldArray, useForm, type FieldPath, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { ModuleHeader } from "@/components/admin/Phase2Ui";
import { WizardShell } from "@/components/admin/WizardShell";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Toaster } from "@/components/ui/sonner";
import { useCompany } from "@/hooks/useCompany";
import {
  useCloseOutContract,
  useCloseoutPreview,
  useContractCloseout,
  type ContractCloseoutWithLines,
} from "@/hooks/useContractCloseouts";
import { useContract, useContractUnits } from "@/hooks/useContracts";
import { useInvoices } from "@/hooks/useInvoices";
import { usePermissions } from "@/hooks/usePermissions";
import { useTenant } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import { joinLocalizedList } from "@/lib/contractUnits";
import { defaultInvoiceAction, reseedUntouched } from "@/lib/closeoutInvoiceActions";
import { closeoutSchema, type CloseoutInput, type InvoiceActionInput } from "@/lib/closeoutSchemas";
import { closeoutStatementHtml } from "@/lib/closeoutStatement";
import { PERMISSIONS } from "@/lib/permissions";
import { openPrintableDocument } from "@/lib/printDocument";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import { showError } from "@/lib/toastError";
import { CloseoutConfirmStep } from "@/components/admin/closeout/CloseoutConfirmStep";
import { CloseoutContractStep } from "@/components/admin/closeout/CloseoutContractStep";
import { CloseoutDeductionsStep } from "@/components/admin/closeout/CloseoutDeductionsStep";
import { CloseoutInvoiceActionsStep } from "@/components/admin/closeout/CloseoutInvoiceActionsStep";
import { CloseoutOutcomeStep } from "@/components/admin/closeout/CloseoutOutcomeStep";
import { CloseoutPreviewStep } from "@/components/admin/closeout/CloseoutPreviewStep";
import { CloseoutRefundStep } from "@/components/admin/closeout/CloseoutRefundStep";
import { CloseoutSuccess } from "@/components/admin/closeout/CloseoutSuccess";
import {
  num,
  type CloseoutResult,
  type PreviewResult,
} from "@/components/admin/closeout/closeoutShared";

export const Route = createFileRoute("/admin/contracts_/$id/closeout")({
  beforeLoad: () => guardModuleRoute("contracts"),
  component: CloseoutWizard,
});

/**
 * Fields validated when advancing FROM each step index.
 * Back never validates. One form object holds all values so Back is free.
 */
const FIELDS_BY_STEP: FieldPath<CloseoutInput>[][] = [
  ["moveOutDate"],
  ["invoiceActions"],
  ["deductions"],
  [], // settlement preview is server-only — no form fields
  ["refundAmount"],
  ["outcome", "finalContractState", "archiveTenant", "note"],
  [], // confirm checkbox is local state
];

/**
 * معالج إغلاق العقد: سبع خطوات فوق نموذج واحد، ثم التنفيذ وشاشة النجاح.
 *
 * The wizard owns the step index, the one form, the success result and the
 * five effects that seed and reseed that form; each step's markup lives in
 * `components/admin/closeout/` (audit M13). The effects stay here on purpose:
 * they read the form and the queries together, and a step component mounting
 * and unmounting as the operator moves would run them at the wrong times.
 */
function CloseoutWizard() {
  const { id } = Route.useParams();
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const canCloseOut = permissions.can(PERMISSIONS.CONTRACTS_CLOSE_OUT);

  // ONE form over the whole close-out schema + a single step index.
  // Data survives Back navigation for free because there is one form object,
  // not seven. Do not "refactor" this into per-step forms.
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [success, setSuccess] = useState<CloseoutResult | null>(null);
  const companyQuery = useCompany();
  const successCloseoutId = success?.closeout_id ?? null;
  const successCloseout = useContractCloseout(successCloseoutId);
  const [invoiceActionError, setInvoiceActionError] = useState<string | null>(null);
  // Invoice ids the operator has decided by hand (the radio onChange). A
  // backdated move-out must only move the write-off boundary for rows NOT in
  // this set — a hand decision is never overwritten by a re-seed.
  const [touchedActions, setTouchedActions] = useState<Set<string>>(new Set());
  // Amount inputs bind as strings; convert once at submit into schema numbers.
  const [refundAmountStr, setRefundAmountStr] = useState("");
  const [refundPrefillDone, setRefundPrefillDone] = useState(false);

  const form = useForm<CloseoutInput>({
    resolver: zodResolver(closeoutSchema) as Resolver<CloseoutInput>,
    defaultValues: {
      contractId: id,
      moveOutDate: new Date().toISOString().slice(0, 10),
      outcome: "keep_terminated",
      finalContractState: "terminated",
      archiveTenant: false,
      deductions: [],
      invoiceActions: [],
      refundAmount: null,
      note: null,
      idempotencyKey: crypto.randomUUID(),
      expectedContractUpdatedAt: null,
    },
    mode: "onSubmit",
  });

  const deductionsArray = useFieldArray({ control: form.control, name: "deductions" });

  const contractQuery = useContract(id);
  const contract = contractQuery.data ?? null;
  const tenantQuery = useTenant(contract?.tenant_id ?? null);
  // Every unit the contract holds (migration 110), not contracts.unit_id
  // (deprecated, no longer read) — the close-out summary names all of them.
  const contractUnitsQuery = useContractUnits(id, canCloseOut);
  // Held deposit for close-out is insurance_payments.amount (migration 87), not
  // contracts.deposit — the RPC settlement arithmetic uses the insurance row.
  const depositHeldQuery = useQuery({
    queryKey: ["closeout-deposit-held", id],
    enabled: Boolean(id) && canCloseOut,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("insurance_payments")
        .select("amount")
        .eq("contract_id", id)
        .maybeSingle();
      if (error) throw error;
      return Number(data?.amount ?? 0);
    },
  });
  // Every invoice of the contract, filtered client-side by balance. A page was
  // the wrong shape: a twenty-year lease raises ~240 invoices, so a cap of 200
  // ordered by due date dropped the last three years of the term — and the
  // close-out settlement built from what remained understated the liability.
  const invoicesQuery = useInvoices(
    { contractId: id, fetchAll: true, sortField: "due_date", sortAsc: true },
    canCloseOut,
  );
  const unpaidInvoices = useMemo(
    () => (invoicesQuery.data?.items ?? []).filter((invoice) => invoice.balance > 0),
    [invoicesQuery.data?.items],
  );

  const unitName = contractUnitsQuery.data?.length
    ? joinLocalizedList(
        contractUnitsQuery.data.map((detail) => `${detail.unit.code} — ${detail.unit.name}`),
        locale,
      )
    : "—";

  // Idempotency key + optimistic concurrency stamp: set ONCE, never regenerated.
  // Regenerating at submit time would defeat idempotency on retry.
  useEffect(() => {
    form.setValue("idempotencyKey", crypto.randomUUID());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  useEffect(() => {
    if (!contract) return;
    form.setValue("contractId", contract.id);
    if (!form.getValues("expectedContractUpdatedAt")) {
      form.setValue("expectedContractUpdatedAt", contract.updated_at);
    }
  }, [contract, form]);

  // Seed invoiceActions once unpaid invoices are known. Months AFTER the
  // move-out month start as write-off — the operator closing a 40-invoice
  // contract had to flip every radio by hand and the one missed stayed `due`.
  useEffect(() => {
    if (!unpaidInvoices.length) return;
    const existing = form.getValues("invoiceActions") ?? [];
    if (existing.length) return;
    form.setValue(
      "invoiceActions",
      unpaidInvoices.map(
        (invoice): InvoiceActionInput => ({
          invoice_id: invoice.id,
          action: defaultInvoiceAction(invoice, form.getValues("moveOutDate")),
          amount: 0,
        }),
      ),
    );
  }, [unpaidInvoices, form]);

  const watchedDeductions = form.watch("deductions");
  const watchedActions = form.watch("invoiceActions");
  const watchedMoveOutDate = form.watch("moveOutDate");

  // Changing the move-out date after the rows were seeded re-seeds every row
  // the operator has not touched; rows they changed by hand keep their value.
  useEffect(() => {
    if (!unpaidInvoices.length) return;
    const existing = form.getValues("invoiceActions") ?? [];
    if (!existing.length) return;
    form.setValue(
      "invoiceActions",
      reseedUntouched(existing, unpaidInvoices, watchedMoveOutDate, touchedActions),
    );
    // Re-running on a touched-set or invoice-list change is harmless: touched
    // rows are returned as-is and untouched rows recompute to the same value.
  }, [watchedMoveOutDate, unpaidInvoices, touchedActions, form]);
  const watchedOutcome = form.watch("outcome");
  const watchedRefund = form.watch("refundAmount");

  const previewDraft = useMemo(
    () => ({
      deductions: watchedDeductions ?? [],
      invoiceActions: watchedActions ?? [],
      refundAmount: watchedRefund ?? null,
    }),
    [watchedDeductions, watchedActions, watchedRefund],
  );

  const previewEnabled = step >= 3 && !success;
  const previewQuery = useCloseoutPreview(id, previewDraft, previewEnabled);
  const preview = (previewQuery.data ?? null) as PreviewResult | null;

  // Prefill refund amount (string) from server preview once when entering step 4+.
  useEffect(() => {
    if (step < 4 || refundPrefillDone || !preview) return;
    const suggested = num(preview.refund_total);
    setRefundAmountStr(String(suggested));
    form.setValue("refundAmount", suggested);
    setRefundPrefillDone(true);
  }, [step, preview, refundPrefillDone, form]);

  const closeOut = useCloseOutContract();

  const steps = useMemo(
    () =>
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        key: `step-${n}`,
        label: t(`closeout.step.${n}`),
      })),
    [t],
  );

  if (permissions.isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">{t("common.loading")}</p>;
  }
  if (!canCloseOut) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  async function goNext() {
    setInvoiceActionError(null);

    if (step === 1) {
      // EVERY unpaid invoice must have an action — the RPC refuses otherwise.
      const actions = form.getValues("invoiceActions") ?? [];
      const covered = new Set(actions.map((row) => row.invoice_id));
      const missing = unpaidInvoices.filter((invoice) => !covered.has(invoice.id));
      if (missing.length) {
        setInvoiceActionError(t("closeout.invoiceActionsRequired"));
        return;
      }
    }

    const fields = FIELDS_BY_STEP[step] ?? [];
    if (fields.length) {
      const ok = await form.trigger(fields);
      if (!ok) return;
    }

    if (step === 6) {
      if (!confirmed) {
        toast.error(t("closeout.confirmRequired"));
        return;
      }
      await submitCloseout();
      return;
    }

    setStep((value) => Math.min(value + 1, steps.length - 1));
  }

  function goBack() {
    setInvoiceActionError(null);
    setStep((value) => Math.max(value - 1, 0));
  }

  async function submitCloseout() {
    // Convert string amount inputs once at submit — no client money maths.
    const refundParsed =
      refundAmountStr.trim() === "" ? null : Number(refundAmountStr.replace(/,/g, ""));
    if (refundParsed != null && (!Number.isFinite(refundParsed) || refundParsed < 0)) {
      form.setError("refundAmount", { message: t("closeout.refundInvalid") });
      setStep(4);
      return;
    }
    form.setValue("refundAmount", refundParsed);

    // Convert deduction amount strings if any were kept as strings via setValue.
    const deductions = (form.getValues("deductions") ?? []).map((row) => ({
      ...row,
      amount: Number(row.amount),
    }));
    form.setValue("deductions", deductions);

    const valid = await form.trigger();
    if (!valid) {
      toast.error(t("closeout.formInvalid"));
      return;
    }

    try {
      const values = form.getValues();
      const result = await closeOut.mutateAsync(values);
      const payload = (result.result ?? {}) as CloseoutResult;
      setSuccess(payload);
      toast.success(t("closeout.success"));
    } catch (error) {
      showError(t("closeout.submitError"), error);
    }
  }

  async function openCloseoutStatement(closeout: ContractCloseoutWithLines) {
    try {
      // Falls back to the contract's primary (first) unit when the closeout row
      // itself has none — pre-multi-unit closeouts always name one, but a
      // multi-unit contract otherwise has no single unit closeout.unit_id could
      // hold.
      const unitId = closeout.unit_id ?? contractUnitsQuery.data?.[0]?.unit.id ?? null;
      let unitName = "—";
      let unitCode: string | null = null;
      let propertyName: string | null = null;
      if (unitId) {
        const unitRes = await supabase
          .from("units")
          .select("name, code, building:buildings(property:properties(name_ar, name_en))")
          .eq("id", unitId)
          .maybeSingle();
        if (unitRes.data) {
          unitName = unitRes.data.name;
          unitCode = unitRes.data.code;
          const building = unitRes.data.building as
            | { property?: { name_ar?: string | null; name_en?: string | null } | null }
            | null
            | undefined;
          propertyName =
            locale === "ar"
              ? (building?.property?.name_ar ?? building?.property?.name_en ?? null)
              : (building?.property?.name_en ?? building?.property?.name_ar ?? null);
        }
      }
      const doc = closeoutStatementHtml({
        closeout,
        contract: {
          code: contract?.code ?? success?.contract_code ?? "—",
          start_date: contract?.start_date ?? "—",
          end_date: contract?.end_date ?? "—",
          state: contract?.state ?? success?.contract_state ?? null,
        },
        tenant: {
          name: tenantQuery.data ? tenantDisplayName(tenantQuery.data, locale) : "—",
          code: tenantQuery.data?.code ?? null,
        },
        unit: { name: unitName, code: unitCode, property_name: propertyName },
        company: companyQuery.data,
        locale,
      });
      await openPrintableDocument(doc.html, {
        title: doc.title,
        dir: doc.dir,
        extraCss: doc.extraCss,
        autoPrint: false,
      });
    } catch (error) {
      showError(t("closeout.statementError"), error);
    }
  }

  function setInvoiceAction(invoiceId: string, action: InvoiceActionInput["action"]) {
    const current = form.getValues("invoiceActions") ?? [];
    const index = current.findIndex((row) => row.invoice_id === invoiceId);
    if (index >= 0) {
      form.setValue(`invoiceActions.${index}.action`, action, { shouldDirty: true });
      form.setValue(`invoiceActions.${index}.amount`, 0, { shouldDirty: true });
    } else {
      form.setValue("invoiceActions", [...current, { invoice_id: invoiceId, action, amount: 0 }], {
        shouldDirty: true,
      });
    }
  }

  function invoiceActionFor(invoiceId: string): InvoiceActionInput["action"] {
    const row = (form.watch("invoiceActions") ?? []).find((item) => item.invoice_id === invoiceId);
    return row?.action ?? "leave";
  }

  if (success) {
    return (
      <CloseoutSuccess
        success={success}
        statementCloseout={successCloseout.data}
        tenantId={contract?.tenant_id ?? null}
        onOpenStatement={(closeout) => void openCloseoutStatement(closeout)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader
        title={t("closeout.title")}
        subtitle={
          contract
            ? `${contract.code} — ${tenantQuery.data ? tenantDisplayName(tenantQuery.data, locale) : ""}`
            : t("closeout.subtitle")
        }
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/contracts" search={{ view: "current" }}>
              {t("common.back")}
            </Link>
          </Button>
        }
      />

      {contractQuery.isLoading || invoicesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : contractQuery.error || !contract ? (
        <p className="text-sm text-destructive">{t("common.error")}</p>
      ) : (
        <Form {...form}>
          <WizardShell
            steps={steps}
            current={step}
            onBack={goBack}
            onNext={() => void goNext()}
            nextLabel={step === 6 ? t("closeout.submit") : undefined}
            nextDisabled={closeOut.isPending || (step === 3 && previewQuery.isLoading)}
            busy={closeOut.isPending}
          >
            {step === 0 && (
              <CloseoutContractStep
                contract={contract}
                tenant={tenantQuery.data}
                unitName={unitName}
                depositHeld={depositHeldQuery.data}
                form={form}
              />
            )}

            {step === 1 && (
              <CloseoutInvoiceActionsStep
                error={invoiceActionError}
                invoices={unpaidInvoices}
                actionFor={invoiceActionFor}
                onPick={(invoiceId, action) => {
                  // A hand-picked action survives every later re-seed caused
                  // by a move-out date change.
                  setTouchedActions((prev) => new Set(prev).add(invoiceId));
                  setInvoiceAction(invoiceId, action);
                }}
              />
            )}

            {step === 2 && (
              <CloseoutDeductionsStep
                depositHeld={depositHeldQuery.data}
                deductions={deductionsArray}
                form={form}
              />
            )}

            {step === 3 && (
              <CloseoutPreviewStep
                loading={previewQuery.isLoading}
                error={previewQuery.error}
                preview={preview}
              />
            )}

            {step === 4 && (
              <CloseoutRefundStep
                preview={preview}
                refundAmountStr={refundAmountStr}
                setRefundAmountStr={setRefundAmountStr}
                form={form}
              />
            )}

            {step === 5 && <CloseoutOutcomeStep form={form} watchedOutcome={watchedOutcome} />}

            {step === 6 && (
              <CloseoutConfirmStep
                contract={contract}
                form={form}
                refundAmountStr={refundAmountStr}
                preview={preview}
                confirmed={confirmed}
                setConfirmed={setConfirmed}
              />
            )}
          </WizardShell>
        </Form>
      )}
    </div>
  );
}
