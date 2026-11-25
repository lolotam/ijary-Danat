import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import {
  DepositAttachmentField,
  type DepositAttachmentValue,
} from "@/components/admin/DepositAttachmentField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCompany } from "@/hooks/useCompany";
import { useContractPickerOptions } from "@/hooks/useContractPickerOptions";
import { useCreateDeposit, useUpdateDeposit, type Deposit } from "@/hooks/useDeposits";
import { useContractInvoicesForDeposit } from "@/hooks/useInvoices";
import { useOptionListItemsByCode } from "@/hooks/useOptionLists";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { Field } from "@/components/admin/FieldControls";
import {
  depositFormSchema,
  depositStatuses,
  depositTypes,
  emptyDeposit,
  UNLINKED,
  type DepositForm,
} from "@/components/admin/deposits/depositFormSchema";
import { formatKwd } from "@/lib/money";
import { mapCatalogueOptions } from "@/lib/commercialActivityOptions";
import { depositInvoiceOptions } from "@/lib/depositInvoiceOptions";
import { depositSaveMessage } from "@/lib/depositSaveMessage";
import { invoicePeriodLabel } from "@/lib/invoicePeriodLabel";

/**
 * نافذة إضافة أو تعديل إيداع بنكي.
 *
 * Extracted from admin.deposits.tsx, which was over the file-size ceiling
 * before this form grew. It owns the form state rather than receiving it,
 * because `createdId` below only makes sense next to the submit handler that
 * sets it.
 */
export function DepositFormDialog({
  open,
  onOpenChange,
  target,
  onPreviewExisting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The deposit being edited, or null when adding. */
  target: Deposit | null;
  onPreviewExisting: () => void;
}) {
  const { t, locale } = useI18n();
  const company = useCompany();
  const contractOptions = useContractPickerOptions(open);
  const banks = useOptionListItemsByCode("kuwait_banks", open);
  const createDeposit = useCreateDeposit();
  const updateDeposit = useUpdateDeposit();
  const [attachment, setAttachment] = useState<DepositAttachmentValue>({ mode: "keep" });
  /**
   * معرّف الإيداع الذي أنشأه هذا النموذج، ليصبح الحفظ التالي تعديلًا لا إضافة.
   *
   * The form no longer closes on save, so a second Save without this would
   * record the same deposit twice.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);

  const form = useForm<DepositForm>({
    resolver: zodResolver(depositFormSchema),
    defaultValues: emptyDeposit(),
  });

  // Re-seeds the form each time the dialog opens. The route used to do this
  // inside `openForm` before the state moved here; without it, opening Edit on
  // a second deposit would show the first one's values.
  useEffect(() => {
    if (!open) return;
    setCreatedId(null);
    setAttachment({ mode: "keep" });
    form.reset(
      target
        ? {
            contract_id: target.contract_id,
            invoice_id: target.invoice_id,
            deposit_date: target.deposit_date,
            bank_name: target.bank_name,
            amount: target.amount,
            currency: "KWD" as const,
            deposit_type: target.deposit_type ?? "cash",
            status: target.status,
            note: target.note ?? "",
          }
        : emptyDeposit(),
    );
    // `form` is stable across renders; listing it would re-seed on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target]);

  const save = form.handleSubmit(async (values) => {
    const payload = {
      company_id: company.data?.id ?? null,
      contract_id: values.contract_id,
      invoice_id: values.invoice_id,
      deposit_date: values.deposit_date,
      bank_name: values.bank_name,
      amount: values.amount,
      currency: values.currency,
      deposit_type: values.deposit_type,
      status: values.status,
      note: values.note || null,
      attachment,
    };
    // Coalesced before the branch: the form stays open after a create and
    // `target` is still null then, so the next Save must update the deposit
    // this one recorded.
    const editingId = target?.id ?? createdId;
    try {
      if (editingId) await updateDeposit.mutateAsync({ id: editingId, updates: payload });
      else {
        // Create only allows replace-or-nothing; coerce the union down.
        const createAttachment = attachment.mode === "replace" ? attachment : null;
        const created = await createDeposit.mutateAsync({
          ...payload,
          attachment: createAttachment,
        });
        setCreatedId(created.id);
      }
      form.reset(values);
      // Back to "keep": the file is uploaded now, and leaving the union on
      // "replace" would re-upload it on the next Save *and* delete the object
      // this save just wrote.
      setAttachment({ mode: "keep" });
      toast.success(t("common.saved"));
    } catch (error) {
      toast.error(depositSaveMessage(error, t));
    }
  });

  const contractId = form.watch("contract_id");
  const invoiceId = form.watch("invoice_id");
  const amount = form.watch("amount");
  const invoices = useContractInvoicesForDeposit(contractId, open);
  const invoiceChoices = depositInvoiceOptions(invoices.data ?? []);
  const selectedInvoice = invoiceChoices.find((option) => option.id === invoiceId);

  // Warns rather than blocks. A deposit short of the balance settles what it
  // covers and leaves the invoice partially_paid, which is a legitimate thing
  // to record — but it is rarely what the accountant meant to type.
  const amountMismatch =
    selectedInvoice && selectedInvoice.balance > 0 && Number(amount) !== selectedInvoice.balance;

  const bankOptions = mapCatalogueOptions(banks.data ?? [], locale);
  const storedBank = form.watch("bank_name");
  // An older deposit may name a bank that is not in the catalogue, or one the
  // owner has since deactivated. Keeping it in the list means editing that
  // deposit for an unrelated reason does not silently rewrite its bank.
  const bankChoices =
    storedBank && !bankOptions.some((option) => option.value === storedBank)
      ? [...bankOptions, { value: storedBank, label: storedBank }]
      : bankOptions;

  const pending = createDeposit.isPending || updateDeposit.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target ? t("deposits.edit") : t("deposits.add")}</DialogTitle>
          <DialogDescription>{t("deposits.formHelp")}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={save}>
          {/* Contract first, then invoice, matching the partial-payment dialog:
              the accountant picks who the money is for before anything else. */}
          <Field label={t("deposits.contract")}>
            <Select
              value={contractId ?? UNLINKED}
              onValueChange={(value) => {
                form.setValue("contract_id", value === UNLINKED ? null : value);
                // The invoice list is scoped to the contract, so a leftover
                // selection would point at another contract's invoice — which
                // the database refuses with a mismatch error.
                form.setValue("invoice_id", null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("deposits.pickContract")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNLINKED}>{t("deposits.noContract")}</SelectItem>
                {contractOptions.map((option) => (
                  <SelectItem key={option.contractId} value={option.contractId}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("deposits.invoice")}>
            <Select
              value={invoiceId ?? UNLINKED}
              disabled={!contractId}
              onValueChange={(value) =>
                form.setValue("invoice_id", value === UNLINKED ? null : value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder={t("deposits.pickInvoice")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNLINKED}>{t("deposits.noInvoice")}</SelectItem>
                {invoiceChoices.map((option) => (
                  <SelectItem
                    key={option.id}
                    value={option.id}
                    // Blocked options stay visible so the accountant can see the
                    // invoice exists and why it cannot be used, rather than
                    // hunting for one that was silently filtered out.
                    disabled={option.block !== null}
                  >
                    {`${option.code} (${invoicePeriodLabel(option.period_year, option.period_month)}) — ${t(
                      `invoiceState.${option.state}`,
                    )}`}
                    {option.block === "outOfOrder" ? ` — ${t("deposits.blockedOutOfOrder")}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            required
            label={t("deposits.date")}
            error={form.formState.errors.deposit_date?.message}
          >
            <DateInput
              value={form.watch("deposit_date")}
              onChange={(value) => form.setValue("deposit_date", value, { shouldValidate: true })}
            />
          </Field>
          <Field
            required
            label={t("deposits.bank")}
            error={form.formState.errors.bank_name?.message}
          >
            <Select
              value={storedBank || undefined}
              onValueChange={(value) => form.setValue("bank_name", value, { shouldValidate: true })}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("deposits.pickBank")} />
              </SelectTrigger>
              <SelectContent>
                {bankChoices.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field required label={t("common.amount")} error={form.formState.errors.amount?.message}>
            <Input type="number" step="0.001" min="0.001" {...form.register("amount")} />
            {amountMismatch ? (
              <p className="text-xs text-amber-600">
                {t("deposits.amountDiffersFromBalance")}{" "}
                {formatKwd(selectedInvoice.balance, locale)}
              </p>
            ) : null}
          </Field>
          {/* Disabled, not hidden: the accountant asked to see that the currency
              is fixed. `deposits_currency_kwd` enforces the same thing in the
              database, so a form-only lock is not the only guard. */}
          <Field required label={t("deposits.currency")}>
            <Input dir="ltr" value="KWD" disabled readOnly />
          </Field>
          <Field
            required
            label={t("deposits.type")}
            error={form.formState.errors.deposit_type?.message}
          >
            <Select
              value={form.watch("deposit_type")}
              onValueChange={(value) =>
                form.setValue("deposit_type", value as DepositForm["deposit_type"], {
                  shouldValidate: true,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {depositTypes.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`depositType.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field required label={t("common.status")}>
            <Select
              value={form.watch("status")}
              onValueChange={(value) => form.setValue("status", value as Deposit["status"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {depositStatuses.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`depositStatus.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="space-y-2 sm:col-span-2">
            <DepositAttachmentField
              existingPath={target?.attachment_path}
              value={attachment}
              onChange={setAttachment}
              onPreviewExisting={onPreviewExisting}
              disabled={pending}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>{t("common.notes")}</Label>
            <Textarea {...form.register("note")} />
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
