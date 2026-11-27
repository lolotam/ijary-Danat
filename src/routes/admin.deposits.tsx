import { useState, type ReactNode } from "react";
import { documentDownloadName } from "@/lib/documentDownloadName";
import { downloadStoredFile } from "@/lib/downloadStoredFile";
import { createFileRoute } from "@tanstack/react-router";
import { guardModuleRoute } from "@/company/requireModule";
import { Download, Eye, FileSpreadsheet, Plus, Upload } from "lucide-react";
import { toast } from "sonner";

import { AttachmentPreviewDialog } from "@/components/admin/AttachmentPreviewDialog";
import { DepositFormDialog } from "@/components/admin/deposits/DepositFormDialog";
import { depositStatuses } from "@/components/admin/deposits/depositFormSchema";
import { CsvImportDialog } from "@/components/admin/CsvImportDialog";
import { DeleteConfirmation, ModuleHeader, Pager, TableState } from "@/components/admin/Phase2Ui";
import { DepositsKpiCards } from "@/components/admin/ownedPageKpis";
import { SummaryCards } from "@/components/admin/SummaryCards";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import { paymentStatusTone } from "@/lib/statusTone";
import { formatKwd } from "@/lib/money";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useDeleteDeposit,
  useDepositBanks,
  useDepositExport,
  useDeposits,
  useUpdateDeposit,
  type Deposit,
} from "@/hooks/useDeposits";
import { useDepositsSummary } from "@/hooks/useDepositsSummary";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { useCatalogueLabel } from "@/hooks/useOptionLists";
import { usePermissions } from "@/hooks/usePermissions";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import { AllFilterSelect } from "@/components/admin/FieldControls";
import { supabase } from "@/integrations/supabase/client";
import { downloadCsv } from "@/lib/csv";
import { PERMISSIONS } from "@/lib/permissions";
import { downloadXls } from "@/lib/xlsx";

export const Route = createFileRoute("/admin/deposits")({
  beforeLoad: () => guardModuleRoute("deposits"),
  component: DepositsPage,
});

function DepositsPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const { isCardVisible } = useCardVisibility();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [bank, setBank] = useState<string>();
  const [status, setStatus] = useState<Deposit["status"] | undefined>();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const filters = {
    search: debouncedSearch,
    bank,
    status,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const deposits = useDeposits(
    { ...filters, page, pageSize: 10 },
    permissions.can(PERMISSIONS.DEPOSITS_READ),
  );
  const exportRows = useDepositExport(filters, permissions.can(PERMISSIONS.DEPOSITS_EXPORT));
  const summary = useDepositsSummary(filters, permissions.can(PERMISSIONS.DEPOSITS_READ));
  const banks = useDepositBanks(permissions.can(PERMISSIONS.DEPOSITS_READ));
  // Resolves a stored bank name to its catalogue label, so an Arabic UI reads
  // «بنك الكويت الوطني» while the column still stores the English value. Falls
  // back to the raw string for a bank recorded before the catalogue existed.
  const bankLabel = useCatalogueLabel("kuwait_banks", "deposits.bank");
  const {
    sort,
    toggle,
    sorted: sortedDeposits,
  } = useTableSort(
    deposits.data?.items ?? [],
    (deposit, key) => (deposit as unknown as Record<string, unknown>)[key],
  );
  const updateDeposit = useUpdateDeposit();
  const deleteDeposit = useDeleteDeposit();
  const [target, setTarget] = useState<Deposit | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Deposit | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [previewDeposit, setPreviewDeposit] = useState<Deposit | null>(null);

  async function downloadAttachmentRemote(deposit: Deposit) {
    if (!deposit.attachment_path) return;
    try {
      // The stored leaf is a UUID — name the download after the deposit code
      // so the saved file is recognisable and keeps its real extension.
      await downloadStoredFile(
        "deposit-attachments",
        deposit.attachment_path,
        documentDownloadName(deposit.code, deposit.attachment_path, "deposit"),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }
  if (!permissions.can(PERMISSIONS.DEPOSITS_READ)) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  const resetPage = () => setPage(1);
  const openForm = (deposit?: Deposit) => {
    setTarget(deposit ?? null);
    setFormOpen(true);
  };
  const data = (exportRows.data?.items ?? []).map((deposit) => ({
    code: deposit.code,
    deposit_date: deposit.deposit_date,
    bank_name: deposit.bank_name,
    amount: deposit.amount,
    currency: deposit.currency,
    deposit_type: t(`depositType.${deposit.deposit_type ?? "cash"}`),
    status: t(`depositStatus.${deposit.status}`),
    note: deposit.note ?? "",
  }));
  const headers = Object.keys(data[0] ?? {});

  return (
    <div className="space-y-6">
      <ModuleHeader
        title={t("deposits.title")}
        subtitle={t("deposits.subtitle")}
        actions={
          <>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.DEPOSITS_EXPORT) || !data.length}
              onClick={() => downloadCsv("deposits.csv", data, locale)}
            >
              <Download className="size-4" />
              {t("export.csv")}
            </Button>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.DEPOSITS_EXPORT) || !data.length}
              onClick={() =>
                downloadXls(
                  "deposits.xls",
                  headers,
                  data.map((row) => headers.map((header) => row[header as keyof typeof row])),
                )
              }
            >
              <FileSpreadsheet className="size-4" />
              {t("export.xls")}
            </Button>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.DEPOSITS_CREATE)}
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-4" />
              {t("common.import")}
            </Button>
            <Button
              disabled={!permissions.can(PERMISSIONS.DEPOSITS_CREATE)}
              onClick={() => openForm()}
            >
              <Plus className="size-4" />
              {t("deposits.add")}
            </Button>
          </>
        }
      />

      <SummaryCards loading={summary.isLoading} error={summary.error}>
        <DepositsKpiCards summary={summary.data} isCardVisible={isCardVisible} />
      </SummaryCards>

      <Card>
        <CardHeader className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="space-y-1">
            <Label>{t("common.search")}</Label>
            <Input
              value={search}
              placeholder={t("common.search")}
              onChange={(event) => {
                setSearch(event.target.value);
                resetPage();
              }}
            />
          </div>
          <AllFilterSelect
            label={t("deposits.bank")}
            value={bank ?? "all"}
            options={(banks.data ?? []).map((value) => ({ value, label: bankLabel(value) }))}
            onChange={(value) => {
              setBank(value === "all" ? undefined : value);
              resetPage();
            }}
          />
          <AllFilterSelect
            label={t("common.status")}
            value={status ?? "all"}
            options={depositStatuses.map((value) => ({
              value,
              label: t(`depositStatus.${value}`),
            }))}
            onChange={(value) => {
              setStatus(value === "all" ? undefined : (value as Deposit["status"]));
              resetPage();
            }}
          />
          <div className="space-y-1">
            <Label>{t("common.from")}</Label>
            <DateInput
              value={dateFrom}
              onChange={(value) => {
                setDateFrom(value);
                resetPage();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("common.to")}</Label>
            <DateInput
              value={dateTo}
              onChange={(value) => {
                setDateTo(value);
                resetPage();
              }}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <TableState
            loading={deposits.isLoading}
            error={deposits.isError}
            empty={!deposits.data?.items.length}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                      {t("deposits.code")}
                    </SortableHead>
                    <SortableHead sortKey="deposit_date" sort={sort} toggle={toggle}>
                      {t("deposits.date")}
                    </SortableHead>
                    <SortableHead sortKey="bank_name" sort={sort} toggle={toggle}>
                      {t("deposits.bank")}
                    </SortableHead>
                    <SortableHead sortKey="deposit_type" sort={sort} toggle={toggle}>
                      {t("deposits.type")}
                    </SortableHead>
                    <SortableHead sortKey="amount" sort={sort} toggle={toggle}>
                      {t("common.amount")}
                    </SortableHead>
                    <SortableHead sortKey="status" sort={sort} toggle={toggle}>
                      {t("common.status")}
                    </SortableHead>
                    <SortableHead sortKey="note" sort={sort} toggle={toggle}>
                      {t("common.notes")}
                    </SortableHead>
                    <TableHead>{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedDeposits.map((deposit, index) => (
                    <TableRow key={deposit.id}>
                      <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
                      <TableCell className="font-mono">{deposit.code}</TableCell>
                      <TableCell>{deposit.deposit_date}</TableCell>
                      <TableCell>{bankLabel(deposit.bank_name)}</TableCell>
                      <TableCell>{t(`depositType.${deposit.deposit_type ?? "cash"}`)}</TableCell>
                      <TableCell className="font-medium">
                        {formatKwd(deposit.amount, locale, deposit.currency)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={paymentStatusTone(deposit.status)}>
                          {t(`depositStatus.${deposit.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-72 truncate">{deposit.note ?? "—"}</TableCell>
                      <TableCell>
                        <div className="flex">
                          {deposit.attachment_path && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                title={t("deposits.previewAttachment")}
                                aria-label={t("deposits.previewAttachment")}
                                onClick={() => setPreviewDeposit(deposit)}
                              >
                                <Eye className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                title={t("deposits.downloadAttachment")}
                                aria-label={t("deposits.downloadAttachment")}
                                onClick={() => downloadAttachmentRemote(deposit)}
                              >
                                <Download className="size-4" />
                              </Button>
                            </>
                          )}
                          <TableActionButton
                            action="edit"
                            disabled={!permissions.can(PERMISSIONS.DEPOSITS_UPDATE)}
                            onClick={() => openForm(deposit)}
                          />
                          <TableActionButton
                            action="delete"
                            disabled={!permissions.can(PERMISSIONS.DEPOSITS_DELETE)}
                            onClick={() => setDeleteTarget(deposit)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5} className="font-semibold">
                      {t("deposits.total")}
                    </TableCell>
                    <TableCell className="font-bold">
                      <LtrText>{formatKwd(summary.data?.total.amount ?? 0, locale)}</LtrText>
                    </TableCell>
                    <TableCell colSpan={3} />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </TableState>
          <Pager page={page} pageSize={10} count={deposits.data?.count ?? 0} setPage={setPage} />
        </CardContent>
      </Card>

      <DepositFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        target={target}
        onPreviewExisting={() => target && setPreviewDeposit(target)}
      />

      <AttachmentPreviewDialog
        open={Boolean(previewDeposit)}
        onOpenChange={(open) => {
          if (!open) setPreviewDeposit(null);
        }}
        bucket="deposit-attachments"
        path={previewDeposit?.attachment_path}
        title={t("deposits.previewAttachment")}
        subtitle={previewDeposit?.code}
        onDelete={
          previewDeposit
            ? () => {
                const target_ = previewDeposit;
                setPreviewDeposit(null);
                void updateDeposit
                  .mutateAsync({
                    id: target_.id,
                    updates: {
                      company_id: target_.company_id,
                      deposit_date: target_.deposit_date,
                      bank_name: target_.bank_name,
                      amount: target_.amount,
                      currency: target_.currency,
                      deposit_type: target_.deposit_type ?? "cash",
                      status: target_.status,
                      note: target_.note,
                      attachment: { mode: "clear" },
                    },
                  })
                  .then(() => toast.success(t("deposits.attachmentRemoved")))
                  .catch((error) =>
                    toast.error(error instanceof Error ? error.message : t("common.error")),
                  );
              }
            : undefined
        }
        deleteLabel={t("deposits.removeAttachment")}
      />

      <CsvImportDialog entity="deposits" open={importOpen} onOpenChange={setImportOpen} />
      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={deleteDeposit.isPending}
        title={t("common.delete")}
        description={t("deposits.deleteConfirm")}
        close={() => setDeleteTarget(null)}
        confirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteDeposit.mutateAsync(deleteTarget);
            setDeleteTarget(null);
            toast.success(t("common.saved"));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
    </div>
  );
}
