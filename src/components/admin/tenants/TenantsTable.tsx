import type { Dispatch, KeyboardEvent, SetStateAction } from "react";
import { Building } from "lucide-react";

import { EntityLink } from "@/components/admin/EntityLink";
import { TenantPortalValue } from "@/components/admin/tenants/TenantPortalValue";
import { WhatsAppChatLink } from "@/components/admin/whatsapp/WhatsAppChatLink";
import { CardField, MobileCardList } from "@/components/admin/MobileCardList";
import { TableState } from "@/components/admin/Phase2Ui";
import { SortableHead, type SortState } from "@/components/admin/SortableTable";
import {
  ContractShopLogo,
  MultiValueCell,
  TenantLifecycleCell,
  TenantRowActions,
} from "@/components/admin/tenants/TenantsTableCells";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { LtrText } from "@/components/ui/ltr-text";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TenantWithActiveLocation } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { propertyDisplayName } from "@/lib/propertyDisplayName";
import { tenantCategoryTone, tenantLifecycleTone } from "@/lib/statusTone";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

/**
 * يعرض رقم الجوال؛ إذا كان للمستأجر بريد إلكتروني يظهر الرقم بالأزرق
 * مع تلميح يوضح البريد عند التحويم — دون إضافة عمود جديد للجدول.
 */
function TenantMobileValue({ tenant }: { tenant: TenantWithActiveLocation }) {
  if (!tenant.mobile) return <>—</>;
  const hasEmail = Boolean(tenant.email?.trim());
  // The link opens the thread for the number ON SCREEN, not for the tenant's
  // `whatsapp` field: where the two differ, clicking a visible mobile number
  // and landing in a different recipient's thread is how a message goes to the
  // wrong person. WhatsAppChatLink renders the number unlinked when it is not a
  // number the gateway can dial.
  //
  // The row itself navigates to the tenant, so the link stops both the click
  // and the Enter/Space keydown from travelling — the row's key handler calls
  // preventDefault(), which would otherwise cancel the link's own activation.
  const number = (
    <WhatsAppChatLink phone={tenant.mobile} stopRowActivation>
      <LtrText>{tenant.mobile}</LtrText>
    </WhatsAppChatLink>
  );
  if (!hasEmail) return number;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help text-blue-600 dark:text-blue-400">{number}</span>
      </TooltipTrigger>
      <TooltipContent>
        <LtrText>{tenant.email}</LtrText>
      </TooltipContent>
    </Tooltip>
  );
}

export type TenantsTableProps = {
  items: TenantWithActiveLocation[];
  sortedItems: TenantWithActiveLocation[];
  loading: boolean;
  error: boolean;
  layoutMode: "cards" | "table";
  cardsPerLine: number;
  isMobile: boolean;
  selected: string[];
  onSelectedChange: Dispatch<SetStateAction<string[]>>;
  sort: SortState;
  toggle: (key: string) => void;
  onOpen: (tenant: { id: string }) => void;
  onOpenKeyDown: (event: KeyboardEvent, tenant: { id: string }) => void;
  onEdit: (tenant: TenantWithActiveLocation) => void;
  onDocuments: (tenant: TenantWithActiveLocation) => void;
  onToggleBlocked: (tenant: TenantWithActiveLocation) => void;
  onDelete: (tenant: TenantWithActiveLocation) => void;
  canUpdate: boolean;
  canDelete: boolean;
  blockPending: boolean;
  /** معرّفات المستأجرين الذين رفعوا وثيقة واحدة على الأقل. */
  documentTenantIds: Set<string>;
  /**
   * معرّفات المستأجرين الذين لديهم حساب بوابة فعلي.
   *
   * Empty when the viewer lacks `users.read` and the query never ran, which is
   * why the cell below falls back to the plain flag rather than reporting every
   * tenant as uninvited.
   */
  portalAccountTenantIds: Set<string>;
  /** هل تعذّر على المستخدم الحالي قراءة حسابات البوابة أصلاً. */
  portalAccountsUnknown: boolean;
};

/**
 * قائمة المستأجرين: بطاقات سطح المكتب، بطاقات الجوال، والجدول.
 *
 * The three layouts share row actions and lifecycle cells so a permission or
 * badge change cannot land on one surface and miss the others.
 */
export function TenantsTable({
  items,
  sortedItems,
  loading,
  error,
  layoutMode,
  cardsPerLine,
  isMobile,
  selected,
  onSelectedChange,
  sort,
  toggle,
  onOpen,
  onOpenKeyDown,
  onEdit,
  onDocuments,
  onToggleBlocked,
  onDelete,
  canUpdate,
  canDelete,
  blockPending,
  documentTenantIds,
  portalAccountTenantIds,
  portalAccountsUnknown,
}: TenantsTableProps) {
  const { t, locale } = useI18n();
  const actions = {
    canUpdate,
    canDelete,
    blockPending,
    onEdit,
    onDocuments,
    onToggleBlocked,
    onDelete,
  };

  if (layoutMode === "cards" && !isMobile) {
    return (
      <TooltipProvider>
        <TableState loading={loading} error={error} empty={!items.length}>
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(${cardsPerLine}, minmax(0, 1fr))` }}
          >
            {sortedItems.map((tenant) => {
              const lifecycleGradient =
                tenant.lifecycle === "active"
                  ? "from-emerald-500/10 to-emerald-600/5"
                  : tenant.lifecycle === "blocked"
                    ? "from-red-500/10 to-red-600/5"
                    : tenant.lifecycle === "contract_ended"
                      ? "from-amber-500/10 to-amber-600/5"
                      : "from-slate-500/10 to-slate-600/5";
              return (
                <div
                  key={tenant.id}
                  role="link"
                  tabIndex={0}
                  aria-label={tenantDisplayName(tenant, locale)}
                  className={`group cursor-pointer overflow-hidden rounded-xl border bg-gradient-to-br ${lifecycleGradient} transition-all hover:-translate-y-1 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                  onClick={() => onOpen(tenant)}
                  onKeyDown={(event) => onOpenKeyDown(event, tenant)}
                >
                  <div className="space-y-3 bg-card/80 p-4 backdrop-blur-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-3">
                        {tenant.shopCardUrl || tenant.shopLogoUrl ? (
                          <img
                            src={tenant.shopCardUrl ?? tenant.shopLogoUrl ?? ""}
                            alt=""
                            className={
                              tenant.shopCardUrl
                                ? "h-14 w-14 shrink-0 rounded-lg border object-cover"
                                : "h-14 w-14 shrink-0 rounded-lg border object-contain bg-muted/30 p-1"
                            }
                          />
                        ) : (
                          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                            <Building className="size-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="truncate font-semibold">
                            <EntityLink
                              kind="tenant"
                              id={tenant.id}
                              stopRowEvents
                              className="text-foreground no-underline hover:underline"
                            >
                              {tenantDisplayName(tenant, locale)}
                            </EntityLink>
                          </p>
                          <p className="font-mono text-xs text-muted-foreground">{tenant.code}</p>
                        </div>
                      </div>
                      <Badge variant={tenantLifecycleTone(tenant.lifecycle)}>
                        {t(`tenantLifecycle.${tenant.lifecycle}`)}
                      </Badge>
                    </div>
                    {tenant.hasOverdue && (
                      <Badge
                        variant="destructive"
                        className="w-fit animate-pulse ring-2 ring-red-400/60"
                      >
                        {t("invoiceState.overdue")}
                      </Badge>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={tenantCategoryTone(tenant.category)}>
                        {t(`tenantCategory.${tenant.category}`)}
                      </Badge>
                      {tenant.connectedProperties.map((property) => (
                        <Badge key={property.id} variant="outline" className="max-w-32 truncate">
                          <EntityLink
                            kind="property"
                            id={property.id}
                            className="text-inherit"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {propertyDisplayName(property, locale)}
                          </EntityLink>
                        </Badge>
                      ))}
                      {tenant.activeContracts.flatMap((location) =>
                        location.units.map((unit) => (
                          <Badge
                            key={`${location.contract.id}-${unit.id}`}
                            variant="outline"
                            className="max-w-28 truncate"
                          >
                            <EntityLink
                              kind="unit"
                              id={unit.id}
                              className="text-inherit"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {unit.name}
                            </EntityLink>
                          </Badge>
                        )),
                      )}
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      {tenant.mobile ? <TenantMobileValue tenant={tenant} /> : null}
                      <p>
                        {tenant.preferred_language === "ar"
                          ? t("tenants.languageName.ar")
                          : t("tenants.languageName.en")}
                        {" · "}
                        {tenant.reminders_enabled ? t("common.yes") : t("common.no")}
                      </p>
                    </div>
                    <div
                      className="flex justify-end gap-1 border-t pt-2"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <TenantRowActions
                        tenant={tenant}
                        hasDocuments={documentTenantIds.has(tenant.id)}
                        {...actions}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </TableState>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="overflow-hidden rounded-xl border bg-card">
        <TableState loading={loading} error={error} empty={!items.length}>
          {isMobile ? (
            <div className="p-3">
              <MobileCardList
                items={items}
                keyFor={(x) => x.id}
                renderCard={(tenant) => (
                  <div
                    role="link"
                    tabIndex={0}
                    aria-label={tenantDisplayName(tenant, locale)}
                    className="cursor-pointer space-y-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpen(tenant)}
                    onKeyDown={(event) => onOpenKeyDown(event, tenant)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">
                          <EntityLink
                            kind="tenant"
                            id={tenant.id}
                            stopRowEvents
                            className="text-foreground no-underline hover:underline"
                          >
                            {tenantDisplayName(tenant, locale)}
                          </EntityLink>
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">{tenant.code}</p>
                      </div>
                      <div className="flex justify-end">
                        <TenantLifecycleCell tenant={tenant} />
                      </div>
                    </div>
                    <CardField label={t("tenants.connectedProperty")}>
                      <MultiValueCell
                        values={tenant.connectedProperties.map((property) => (
                          <EntityLink
                            key={property.id}
                            kind="property"
                            id={property.id}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {propertyDisplayName(property, locale)}
                          </EntityLink>
                        ))}
                      />
                    </CardField>
                    <CardField label={t("tenants.connectingUnit")}>
                      <MultiValueCell
                        values={tenant.activeContracts.flatMap((location) =>
                          location.units.map((unit) => (
                            <EntityLink
                              key={unit.id}
                              kind="unit"
                              id={unit.id}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {unit.name}
                            </EntityLink>
                          )),
                        )}
                      />
                    </CardField>
                    <CardField label={t("tenants.connectedContracts")}>
                      <MultiValueCell
                        values={tenant.activeContracts.map((location) => location.contract.code)}
                      />
                    </CardField>
                    <CardField label={t("tenants.startDate")}>
                      <MultiValueCell
                        values={tenant.activeContracts.map(
                          (location) => location.contract.start_date,
                        )}
                      />
                    </CardField>
                    <CardField label={t("tenants.endDate")}>
                      <MultiValueCell
                        values={tenant.activeContracts.map(
                          (location) => location.contract.end_date,
                        )}
                      />
                    </CardField>
                    <CardField label={t("tenants.mobile")}>
                      <TenantMobileValue tenant={tenant} />
                    </CardField>
                    <CardField label={t("tenants.category")}>
                      {t(`tenantCategory.${tenant.category}`)}
                    </CardField>
                    <div
                      className="flex justify-end gap-1 border-t pt-2"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <TenantRowActions
                        tenant={tenant}
                        hasDocuments={documentTenantIds.has(tenant.id)}
                        {...actions}
                      />
                    </div>
                  </div>
                )}
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={items.length > 0 && selected.length === items.length}
                      onCheckedChange={(v) => onSelectedChange(v ? items.map((x) => x.id) : [])}
                    />
                  </TableHead>
                  <TableHead>#</TableHead>
                  <TableHead>{t("shops.logo")}</TableHead>
                  <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                    {t("common.code")}
                  </SortableHead>
                  <SortableHead sortKey="name" sort={sort} toggle={toggle}>
                    {t("common.name")}
                  </SortableHead>
                  <SortableHead sortKey="property" sort={sort} toggle={toggle}>
                    {t("tenants.connectedProperty")}
                  </SortableHead>
                  <SortableHead sortKey="unit" sort={sort} toggle={toggle}>
                    {t("tenants.connectingUnit")}
                  </SortableHead>
                  {/* Not sortable: a tenant can hold several contracts and
                    there is no defined order over a list of codes. The
                    sortable columns beside it stay on the primary. */}
                  <TableHead>{t("tenants.connectedContracts")}</TableHead>
                  <SortableHead sortKey="activeContractStartDate" sort={sort} toggle={toggle}>
                    {t("tenants.startDate")}
                  </SortableHead>
                  <SortableHead sortKey="activeContractEndDate" sort={sort} toggle={toggle}>
                    {t("tenants.endDate")}
                  </SortableHead>
                  <SortableHead sortKey="category" sort={sort} toggle={toggle}>
                    {t("tenants.category")}
                  </SortableHead>
                  <SortableHead sortKey="lifecycle" sort={sort} toggle={toggle}>
                    {t("tenants.lifecycle")}
                  </SortableHead>
                  <SortableHead sortKey="mobile" sort={sort} toggle={toggle}>
                    {t("tenants.mobile")}
                  </SortableHead>
                  <SortableHead sortKey="preferred_language" sort={sort} toggle={toggle}>
                    {t("tenants.language")}
                  </SortableHead>
                  <SortableHead sortKey="reminders_enabled" sort={sort} toggle={toggle}>
                    {t("tenants.reminders")}
                  </SortableHead>
                  <SortableHead sortKey="tenant_portal_enabled" sort={sort} toggle={toggle}>
                    {t("tenants.portal")}
                  </SortableHead>
                  <TableHead>{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedItems.map((tenant, index) => (
                  <TableRow
                    key={tenant.id}
                    role="link"
                    tabIndex={0}
                    aria-label={tenantDisplayName(tenant, locale)}
                    className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpen(tenant)}
                    onKeyDown={(event) => onOpenKeyDown(event, tenant)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.includes(tenant.id)}
                        onCheckedChange={(v) =>
                          onSelectedChange((prev) =>
                            v ? [...prev, tenant.id] : prev.filter((x) => x !== tenant.id),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>{index + 1}</TableCell>
                    <TableCell>
                      <MultiValueCell
                        values={
                          tenant.activeContracts.length
                            ? tenant.activeContracts.map((location) => (
                                <ContractShopLogo
                                  key={location.contract.id}
                                  logoUrl={location.logoUrl}
                                />
                              ))
                            : [<ContractShopLogo key={tenant.id} logoUrl={tenant.shopLogoUrl} />]
                        }
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{tenant.code}</TableCell>
                    <TableCell className="font-medium">
                      <EntityLink
                        kind="tenant"
                        id={tenant.id}
                        stopRowEvents
                        className="text-foreground no-underline hover:underline"
                      >
                        {tenantDisplayName(tenant, locale)}
                      </EntityLink>
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <MultiValueCell
                        values={tenant.connectedProperties.map((property) => (
                          <EntityLink key={property.id} kind="property" id={property.id}>
                            {propertyDisplayName(property, locale)}
                          </EntityLink>
                        ))}
                      />
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <MultiValueCell
                        values={tenant.activeContracts.flatMap((location) =>
                          location.units.map((unit) => (
                            <EntityLink key={unit.id} kind="unit" id={unit.id}>
                              {unit.name}
                            </EntityLink>
                          )),
                        )}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <MultiValueCell
                        values={tenant.activeContracts.map((location) => location.contract.code)}
                      />
                    </TableCell>
                    <TableCell>
                      <MultiValueCell
                        values={tenant.activeContracts.map(
                          (location) => location.contract.start_date,
                        )}
                      />
                    </TableCell>
                    <TableCell>
                      <MultiValueCell
                        values={tenant.activeContracts.map(
                          (location) => location.contract.end_date,
                        )}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={tenantCategoryTone(tenant.category)}>
                        {t(`tenantCategory.${tenant.category}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <TenantLifecycleCell tenant={tenant} />
                    </TableCell>
                    <TableCell>
                      <TenantMobileValue tenant={tenant} />
                    </TableCell>
                    <TableCell>
                      {tenant.preferred_language === "ar"
                        ? t("tenants.languageName.ar")
                        : t("tenants.languageName.en")}
                    </TableCell>
                    <TableCell>
                      {tenant.reminders_enabled ? t("common.yes") : t("common.no")}
                    </TableCell>
                    <TableCell>
                      <TenantPortalValue
                        tenant={tenant}
                        hasAccount={portalAccountTenantIds.has(tenant.id)}
                        unknown={portalAccountsUnknown}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1" onClick={(event) => event.stopPropagation()}>
                        <TenantRowActions
                          tenant={tenant}
                          hasDocuments={documentTenantIds.has(tenant.id)}
                          {...actions}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableState>
      </div>
    </TooltipProvider>
  );
}
