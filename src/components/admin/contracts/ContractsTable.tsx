import { Link } from "@tanstack/react-router";
import { Building, ExternalLink, Gift, RotateCcw } from "lucide-react";

import { EntityLink } from "@/components/admin/EntityLink";
import { PreviewableImage } from "@/components/admin/ImagePreviewDialog";
import { ContractDurationBadge } from "@/components/admin/ContractDurationBadge";
import { PropertiesCell, UnitsCell } from "@/components/admin/LocationCells";
import { TableState } from "@/components/admin/Phase2Ui";
import { SortableHead, type SortState } from "@/components/admin/SortableTable";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormattedDate } from "@/components/ui/formatted-date";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ArchiveMode } from "@/hooks/archiveMode";
import type { ContractWithRelations } from "@/hooks/useContracts";
import { usePermissions } from "@/hooks/usePermissions";
import { isContractEnded } from "@/lib/contractLifecycle";
import { PERMISSIONS } from "@/lib/permissions";
import { useI18n } from "@/i18n/provider";
import { formatFixedDiscountCell, formatPercentDiscountCell } from "@/lib/concessionColumns";
import { contractIncreaseEffectivePeriod, contractIncreaseLabel } from "@/lib/contractIncrease";
import { formatAmount, formatKwd } from "@/lib/money";
import { contractStateTone, OVERDUE_BADGE_CLASS } from "@/lib/statusTone";
import { dedupeById } from "@/lib/tenantLocations";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

export type ContractsTableProps = {
  items: ContractWithRelations[];
  sortedItems: ContractWithRelations[];
  loading: boolean;
  error: boolean;
  archiveMode: ArchiveMode;
  outstandingBalances: Map<string, number> | undefined;
  sort: SortState;
  toggle: (key: string) => void;
  canUpdate: boolean;
  canDelete: boolean;
  canCloseOut: boolean;
  canRestore: boolean;
  onEdit: (contract: ContractWithRelations) => void;
  onConcessions: (contract: ContractWithRelations) => void;
  onRestore: (contract: ContractWithRelations) => void;
  onDelete: (contract: ContractWithRelations) => void;
};

/**
 * جدول العقود: الصفوف وأزرار الصف.
 *
 * No pager: the page loads every contract at once and filters them in the
 * browser, so a page number would be a control over a list that has only one
 * page. Row numbers are therefore positions in the visible list.
 *
 * Archive columns stay on this table rather than a second layout so Current /
 * Archived / All cannot drift on the shared money columns.
 */
export function ContractsTable({
  items,
  sortedItems,
  loading,
  error,
  archiveMode,
  outstandingBalances,
  sort,
  toggle,
  canUpdate,
  canDelete,
  canCloseOut,
  canRestore,
  onEdit,
  onConcessions,
  onRestore,
  onDelete,
}: ContractsTableProps) {
  const { t, locale } = useI18n();
  const permissions = usePermissions();

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <TableState loading={loading} error={error} empty={!items.length}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("contracts.shop")}</TableHead>
              <TableHead>#</TableHead>
              <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                {t("common.code")}
              </SortableHead>
              <SortableHead sortKey="tenant" sort={sort} toggle={toggle}>
                {t("contracts.tenant")}
              </SortableHead>
              <SortableHead sortKey="unit" sort={sort} toggle={toggle}>
                {t("contracts.unit")}
              </SortableHead>
              <SortableHead sortKey="property" sort={sort} toggle={toggle}>
                {t("units.property")}
              </SortableHead>
              <SortableHead sortKey="deposit" sort={sort} toggle={toggle}>
                {t("contracts.insurancePaid")}
              </SortableHead>
              <SortableHead sortKey="state" sort={sort} toggle={toggle}>
                {t("common.status")}
              </SortableHead>
              {archiveMode !== "current" ? (
                <>
                  <TableHead>{t("archive.archivedDate")}</TableHead>
                  <TableHead>{t("archive.outstandingBalance")}</TableHead>
                </>
              ) : null}
              <SortableHead sortKey="start_date" sort={sort} toggle={toggle}>
                {t("contracts.start")}
              </SortableHead>
              <SortableHead sortKey="end_date" sort={sort} toggle={toggle}>
                {t("contracts.end")}
              </SortableHead>
              <SortableHead sortKey="freeMonths" sort={sort} toggle={toggle}>
                {t("contracts.freeMonths")}
              </SortableHead>
              <SortableHead sortKey="percentDiscount" sort={sort} toggle={toggle}>
                {t("contracts.percentDiscount")}
              </SortableHead>
              <SortableHead sortKey="fixedDiscount" sort={sort} toggle={toggle}>
                {t("contracts.fixedDiscount")}
              </SortableHead>
              <SortableHead sortKey="monthly_amount" sort={sort} toggle={toggle}>
                {t("contracts.monthlyAmount")}
              </SortableHead>
              <SortableHead sortKey="duration_months" sort={sort} toggle={toggle}>
                {t("contracts.durationMonths")}
              </SortableHead>
              <TableHead>{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedItems.map((contract, index) => {
              // Every unit and building on the contract. These cells used to
              // render `primaryUnit` / `primaryProperty` — units[0] — so a
              // three-unit contract showed one unit and one building as
              // though that were the whole contract.
              const units = contract.units.map((link) => link.unit);
              const properties = dedupeById(contract.units.map((link) => link.property));
              return (
                <TableRow key={contract.id}>
                  <TableCell>
                    {contract.brandLogoUrl ? (
                      <PreviewableImage
                        url={contract.brandLogoUrl}
                        className="h-10 w-16"
                        imageClassName="h-10 w-16 object-cover"
                      />
                    ) : (
                      <div
                        className="flex h-10 w-16 items-center justify-center rounded border bg-muted/30"
                        aria-label={t("common.logoPlaceholder")}
                      >
                        <Building className="size-4 text-muted-foreground" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{index + 1}</TableCell>
                  <TableCell className="font-mono text-xs">{contract.code}</TableCell>
                  <TableCell>
                    {contract.tenant ? (
                      <EntityLink kind="tenant" id={contract.tenant_id}>
                        {tenantDisplayName(contract.tenant, locale)}
                      </EntityLink>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <UnitsCell units={units} />
                  </TableCell>
                  <TableCell>
                    <PropertiesCell properties={properties} />
                  </TableCell>
                  <TableCell>
                    {/* LtrText, like the outstanding column: the KWD suffix must not reorder in RTL. */}
                    <LtrText>{formatKwd(contract.deposit ?? 0, locale)}</LtrText>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={contractStateTone(contract.state)}>
                        {t(`contractState.${contract.state}`)}
                      </Badge>
                      {/* Beside the state, never folded into it: a contract is
                          `active` AND in arrears, and one badge carrying both
                          would have to drop one of the two facts. Same pairing
                          the tenants table already shows. */}
                      {contract.hasOverdue ? (
                        <Badge variant="destructive" className={OVERDUE_BADGE_CLASS}>
                          {t("invoiceState.overdue")}
                        </Badge>
                      ) : null}
                      {contract.archived_at ? (
                        <Badge variant="violet">{t("archive.badge")}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  {archiveMode !== "current" ? (
                    <>
                      <TableCell>
                        {contract.archived_at ? (
                          <FormattedDate value={contract.archived_at} />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <LtrText>
                          {formatKwd(outstandingBalances?.get(contract.id) ?? 0, locale)}
                        </LtrText>
                      </TableCell>
                    </>
                  ) : null}
                  <TableCell>
                    <FormattedDate value={contract.start_date} />
                  </TableCell>
                  <TableCell>
                    <FormattedDate value={contract.end_date} />
                  </TableCell>
                  <TableCell>
                    {contract.freeMonths > 0 ? (
                      contract.freeMonths
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {formatPercentDiscountCell(contract.percentDiscount, locale) ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {formatFixedDiscountCell(contract.fixedDiscount, locale) ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {formatAmount(contract.monthly_amount, locale)}
                    {/* There is no contract detail route — the table is the one
                        display surface for the increase (spec T11). */}
                    {contract.increase_after_years != null && contract.increase_type ? (
                      <div className="text-xs text-muted-foreground">
                        {contractIncreaseLabel(
                          locale,
                          contract.increase_type,
                          Number(contract.increase_value),
                          contractIncreaseEffectivePeriod(
                            contract.start_date,
                            contract.increase_after_years,
                          ),
                        )}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <ContractDurationBadge months={contract.duration_months} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {permissions.can(PERMISSIONS.CONTRACTS_READ) && (
                        <Button asChild size="sm" variant="outline">
                          <Link to="/admin/contracts/builder" search={{ contract: contract.id }}>
                            {t("contractBuilder.buildFromContract")}
                          </Link>
                        </Button>
                      )}
                      <TableActionButton
                        action="edit"
                        disabled={!canUpdate}
                        onClick={() => onEdit(contract)}
                      />
                      <TableActionButton action="view" asChild>
                        <Link
                          to="/portal"
                          search={{ tenant: contract.tenant_id }}
                          title={t("portal.openPortal")}
                          aria-label={t("portal.openPortal")}
                        >
                          <ExternalLink className="size-4" />
                        </Link>
                      </TableActionButton>
                      <Button size="sm" variant="outline" onClick={() => onConcessions(contract)}>
                        <Gift className="size-4" />
                        {t("concessions.title")}
                      </Button>
                      {/* `archived_at` alone was the wrong test: close_out_contract
                          stamps it only for the `archive` outcome (migration 114),
                          so a contract closed out as terminated kept offering a
                          Close-out action that `close_out_contract` then refuses
                          with "Contract is already ended". */}
                      {!isContractEnded(contract) && canCloseOut && contract.state !== "draft" ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link to="/admin/contracts/$id/closeout" params={{ id: contract.id }}>
                            {t("closeout.action")}
                          </Link>
                        </Button>
                      ) : null}
                      {contract.archived_at && canRestore ? (
                        <Button size="sm" variant="outline" onClick={() => onRestore(contract)}>
                          <RotateCcw className="size-4" />
                          {t("archive.restore")}
                        </Button>
                      ) : null}
                      <TableActionButton
                        action="delete"
                        disabled={contract.state !== "draft" || !canDelete}
                        onClick={() => onDelete(contract)}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableState>
    </div>
  );
}
