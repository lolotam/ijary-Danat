import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Building, ExternalLink } from "lucide-react";

import { TableActionButton } from "@/components/admin/TableActionButton";
import { PreviewableImage } from "@/components/admin/ImagePreviewDialog";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n/provider";
import type { TenantWithActiveLocation } from "@/hooks/useTenants";
import { OVERDUE_BADGE_CLASS, contractStateTone, tenantLifecycleTone } from "@/lib/statusTone";
import { summarizeContractLifecycles } from "@/lib/tenantLifecycleSummary";

/**
 * خلية تعرض قيمة واحدة لكل عقد ساري.
 *
 * A tenant can rent a second shop, so these columns hold a list rather than a
 * value. Buildings arrive already deduped — two contracts in one building is
 * one building — while units and contract codes do not, because two contracts
 * really are two units.
 */
export function MultiValueCell({ values }: { values: Array<ReactNode | null | undefined> }) {
  const present = values.filter((value) => value != null && value !== "");
  if (!present.length) return <>—</>;
  return (
    <div className="space-y-0.5">
      {present.map((value, index) => (
        <div key={index} className="truncate">
          {value}
        </div>
      ))}
    </div>
  );
}

/**
 * شعار عقد واحد في عمود المحل، أو المكان المحجوز إن لم تُربَط علامة.
 *
 * The placeholder is a real cell, not a skip: MultiValueCell drops nulls, and
 * dropping a row would desync the shop column from the contract column. The
 * thumbnail is `PreviewableImage` — the same eye overlay the landing shops
 * table uses — so clicking it opens the bigger preview instead of the tenant.
 */
export function ContractShopLogo({ logoUrl }: { logoUrl: string | null }) {
  const { t } = useI18n();
  if (logoUrl) {
    return (
      <PreviewableImage
        url={logoUrl}
        className="h-10 w-16"
        imageClassName="h-10 w-16 object-contain p-0.5"
      />
    );
  }
  return (
    <div
      className="flex h-10 w-16 items-center justify-center rounded border bg-muted/30"
      aria-label={t("common.logoPlaceholder")}
    >
      <Building className="size-4 text-muted-foreground" />
    </div>
  );
}

/**
 * خلية دورة حياة المستأجر: حالته، ومع أكثر من عقد عدد كل حالة وكم منها متأخر.
 *
 * A single-contract tenant renders exactly as before. Counts only earn their
 * place once there is something to count; below that they would read
 * "1 active" where "active" said the same thing.
 */
export function TenantLifecycleCell({ tenant }: { tenant: TenantWithActiveLocation }) {
  const { t } = useI18n();
  const summary = summarizeContractLifecycles(tenant.contractStatuses);

  if (tenant.contractStatuses.length < 2) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant={tenantLifecycleTone(tenant.lifecycle)}>
          {t(`tenantLifecycle.${tenant.lifecycle}`)}
        </Badge>
        {tenant.hasOverdue && (
          <Badge variant="destructive" className={OVERDUE_BADGE_CLASS}>
            {t("invoiceState.overdue")}
          </Badge>
        )}
        {tenant.archived_at ? <Badge variant="violet">{t("archive.badge")}</Badge> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {/* Kept only when it says something the counts cannot. `blocked` is the
          one lifecycle value an admin sets by hand and has no contract-level
          equivalent, so it must not disappear behind them — while an `active`
          tenant badge sitting beside "2 active" is the same fact twice. */}
      {tenant.lifecycle !== "active" && (
        <Badge variant={tenantLifecycleTone(tenant.lifecycle)}>
          {t(`tenantLifecycle.${tenant.lifecycle}`)}
        </Badge>
      )}
      {summary.states.map(({ state, count }) => (
        <Badge key={state} variant={contractStateTone(state)}>
          {count} {t(`contractState.${state}`)}
        </Badge>
      ))}
      {/* Counted separately, not as a state: a contract is `active` *and* in
          arrears, and folding them together would hide one of the two. */}
      {summary.overdueCount > 0 && (
        <Badge variant="destructive" className={OVERDUE_BADGE_CLASS}>
          {summary.overdueCount} {t("invoiceState.overdue")}
        </Badge>
      )}
      {tenant.archived_at ? <Badge variant="violet">{t("archive.badge")}</Badge> : null}
    </div>
  );
}

export type TenantRowActionsProps = {
  tenant: TenantWithActiveLocation;
  canUpdate: boolean;
  canDelete: boolean;
  blockPending: boolean;
  /** هل رفع المستأجر وثيقة واحدة على الأقل — يرسم حلقة حمراء حول أيقونة الوثائق. */
  hasDocuments: boolean;
  onEdit: (tenant: TenantWithActiveLocation) => void;
  onDocuments: (tenant: TenantWithActiveLocation) => void;
  onToggleBlocked: (tenant: TenantWithActiveLocation) => void;
  onDelete: (tenant: TenantWithActiveLocation) => void;
};

/**
 * أزرار صف المستأجر المشتركة بين الجدول والبطاقات والجوال حتى لا تنحرف الإجراءات.
 */
export function TenantRowActions({
  tenant,
  canUpdate,
  canDelete,
  blockPending,
  hasDocuments,
  onEdit,
  onDocuments,
  onToggleBlocked,
  onDelete,
}: TenantRowActionsProps) {
  const { t } = useI18n();
  return (
    <>
      <TableActionButton action="view" asChild>
        <Link
          to="/portal"
          search={{ tenant: tenant.id }}
          title={t("portal.openPortal")}
          aria-label={t("portal.openPortal")}
        >
          <ExternalLink className="size-4" />
        </Link>
      </TableActionButton>
      <TableActionButton action="edit" disabled={!canUpdate} onClick={() => onEdit(tenant)} />
      <TableActionButton
        action="documents"
        indicator={hasDocuments}
        onClick={() => onDocuments(tenant)}
      />
      <TableActionButton
        action={tenant.lifecycle === "blocked" ? "unblock" : "block"}
        disabled={!canUpdate || blockPending}
        onClick={() => onToggleBlocked(tenant)}
      />
      <TableActionButton action="delete" disabled={!canDelete} onClick={() => onDelete(tenant)} />
    </>
  );
}
