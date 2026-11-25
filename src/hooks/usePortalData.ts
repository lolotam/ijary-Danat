import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";

import { useAuth } from "@/auth/AuthProvider";
import { roundToFils } from "@/lib/fils";
import { supabase } from "@/integrations/supabase/client";
import { fetchInChunks } from "@/lib/idChunks";
import { foldPortalPaymentAllocations } from "@/lib/portalPaymentFold";
import type { AppRole, Tables } from "@/integrations/supabase/database.types";

export interface PortalIdentity {
  isStaff: boolean;
  isTenant: boolean;
  profile: Tables<"profiles">;
  roles: AppRole[];
  tenant: Tables<"tenants"> | null;
  /** True when a staff user is previewing another tenant's portal. */
  viewingAsStaff: boolean;
  /** Tenants explicitly linked to this account, for the portal switcher. */
  assignedTenants: { id: string; name: string; name_en: string | null }[];
}

/**
 * Portal identity for the signed-in user.
 *
 * A `?tenant=<id>` search param lets a staff user preview any tenant's portal;
 * it is read from the router so every portal page picks it up. For non-staff
 * users the parameter is ignored, so it cannot be used to read another
 * tenant's data (RLS enforces the same boundary server-side).
 *
 * Staff may also be linked to tenants through `user_tenants`. Those links are
 * a convenience — they decide which tenants the portal switcher offers and
 * which one loads by default, not what the account is allowed to read.
 */
export function usePortalIdentity(overrideTenantId?: string | null) {
  const { user } = useAuth();
  const search = useSearch({ strict: false }) as { tenant?: string };
  const viewTenantId = overrideTenantId ?? search?.tenant ?? null;
  return useQuery({
    queryKey: ["portal-identity", user?.id, viewTenantId ?? null],
    enabled: Boolean(user),
    queryFn: async (): Promise<PortalIdentity> => {
      const [profileResult, rolesResult] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", user!.id).single(),
        supabase.from("user_roles").select("role").eq("user_id", user!.id),
      ]);
      if (profileResult.error) throw profileResult.error;
      if (rolesResult.error) throw rolesResult.error;
      const roles = rolesResult.data.map((entry) => entry.role);
      const isStaff = roles.some((role) => role !== "tenant");

      // RLS on user_tenants returns the caller's own links without any extra
      // permission, so this is safe for tenant users too (they get none).
      const linksResult = await (supabase.from("user_tenants" as never) as any)
        .select("tenant_id")
        .eq("user_id", user!.id);
      if (linksResult.error) throw linksResult.error;
      const assignedIds = ((linksResult.data ?? []) as { tenant_id: string }[]).map(
        (link) => link.tenant_id,
      );
      let assignedTenants: PortalIdentity["assignedTenants"] = [];
      if (assignedIds.length) {
        const assignedResult = await supabase
          .from("tenants")
          .select("id, name, name_en")
          .in("id", assignedIds);
        if (assignedResult.error) throw assignedResult.error;
        assignedTenants = assignedResult.data ?? [];
      }

      // An assigned staff user landing on /portal with no explicit target
      // opens their first linked tenant instead of bouncing back to /admin.
      const fallbackTenantId =
        profileResult.data.tenant_id ?? (isStaff ? (assignedTenants[0]?.id ?? null) : null);
      const tenantId = isStaff && viewTenantId ? viewTenantId : fallbackTenantId;
      // Only a *foreign* tenant counts as previewing. A staff account that is
      // itself linked to this tenant keeps the normal tenant experience
      // (language sync, portal-disabled screen) rather than the preview banner.
      const viewingAsStaff =
        isStaff && Boolean(tenantId) && tenantId !== profileResult.data.tenant_id;
      let tenant: Tables<"tenants"> | null = null;
      if (tenantId) {
        const tenantResult = await supabase
          .from("tenants")
          .select("*")
          .eq("id", tenantId)
          .maybeSingle();
        if (tenantResult.error) throw tenantResult.error;
        tenant = tenantResult.data;
      }
      return {
        profile: profileResult.data,
        roles,
        tenant,
        // A user is a tenant portal user if they have the tenant role OR
        // simply have no managerial roles but are linked to a tenant record.
        // Staff previewing a tenant portal are treated as tenants for layout.
        isTenant: Boolean(tenant) && (viewingAsStaff || roles.includes("tenant") || !isStaff),
        isStaff,
        viewingAsStaff,
        assignedTenants,
      };
    },
  });
}

/**
 * تفاصيل عقد واحد للمستأجر في البوابة (وحدات، عقارات، تخفيضات).
 *
 * When `contractId` is set the named contract is loaded regardless of state so
 * an ended lease still shows its history. When it is null the dashboard falls
 * back to the newest active contract — that is why the home page renders before
 * any selection is made.
 */
export function usePortalLease(tenantId: string | null, contractId?: string | null) {
  return useQuery({
    queryKey: ["portal-lease", tenantId, contractId ?? null],
    enabled: Boolean(tenantId),
    queryFn: async () => {
      // Applied for the named contract too, not only the fallback: without it a
      // tenant who typed `?contract=<roof id>` would read the lease the portal
      // is meant not to show them.
      let contractQuery = supabase
        .from("contracts")
        .select("*")
        .eq("tenant_id", tenantId!)
        .eq("hide_from_portal", false);
      if (contractId) {
        contractQuery = contractQuery.eq("id", contractId);
      } else {
        contractQuery = contractQuery
          .eq("state", "active")
          .order("start_date", { ascending: false })
          .limit(1);
      }
      const { data: contract, error: contractError } = await contractQuery.maybeSingle();
      if (contractError) throw contractError;
      if (!contract) {
        return { contract: null, units: [], properties: [], concessions: [] };
      }
      // Units live on contract_units (migration 110), not contracts.unit_id
      // (dropped in migration 118). This used to take only the primary
      // (lowest line_order) unit and let it stand in for the contract, so a
      // tenant renting three units saw one of them on their own lease page —
      // with no indication the other two existed.
      const [unitLinkResult, concessionsResult] = await Promise.all([
        supabase
          .from("contract_units")
          .select("unit_id")
          .eq("contract_id", contract.id)
          .order("line_order"),
        supabase.from("concessions").select("*").eq("contract_id", contract.id).order("start_date"),
      ]);
      if (unitLinkResult.error) throw unitLinkResult.error;
      if (concessionsResult.error) throw concessionsResult.error;

      const unitIds = unitLinkResult.data.map((link) => link.unit_id);
      const unitsResult = unitIds.length
        ? await supabase.from("units").select("*").in("id", unitIds).order("code")
        : { data: [] as Tables<"units">[], error: null };
      if (unitsResult.error) throw unitsResult.error;
      const units = unitsResult.data;

      const propertyIds = [...new Set(units.map((unit) => unit.property_id))];
      const propertiesResult = propertyIds.length
        ? await supabase.from("properties").select("*").in("id", propertyIds).order("name_ar")
        : { data: [] as Tables<"properties">[], error: null };
      if (propertiesResult.error) throw propertiesResult.error;

      return {
        contract,
        units,
        properties: propertiesResult.data,
        concessions: concessionsResult.data,
      };
    },
  });
}

/**
 * ملخّص فواتير البوابة: أقرب موعد، عدد الفواتير المتأخرة، وإجمالي أرصدتها،
 * مقصورًا على العقد المختار.
 *
 * The contract argument is what keeps the dashboard internally consistent. The
 * hero block above these cards shows one contract's units and rent; leaving the
 * KPIs tenant-wide put that contract's rent beside every contract's outstanding
 * balance, and a tenant reading the two together would conclude their own
 * arithmetic was wrong.
 */
export function usePortalInvoiceSummary(
  tenantId: string | null,
  contractId?: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["portal-invoice-summary", tenantId, contractId ?? null],
    enabled: Boolean(tenantId) && enabled,
    queryFn: async () => {
      // `contracts!inner` rather than a second round trip: `invoices.contract_id`
      // is NOT NULL, so the inner join drops no invoice on its own — it only
      // drops the ones whose contract is hidden. Without this a roof arrear
      // still inflated the outstanding card for a contract the tenant cannot
      // see, let alone pay.
      let query = supabase
        .from("invoices")
        .select("balance,due_date,state,contracts!inner(hide_from_portal)")
        .eq("tenant_id", tenantId!)
        .eq("is_visible_to_tenant", true)
        .eq("contracts.hide_from_portal", false)
        .in("state", ["due", "overdue", "partially_paid"])
        .gt("balance", 0);
      if (contractId) query = query.eq("contract_id", contractId);
      const { data, error } = await query.order("due_date");
      if (error) throw error;
      // `overdueTotal` is read by the Total-overdue card. It sums only
      // `overdue` invoices — the set the count card uses — so the two never
      // disagree about what is in arrears; due and partially-paid rows that
      // are not yet overdue only feed `nextDue`.
      const overdueRows = data.filter((invoice) => invoice.state === "overdue");
      return {
        overdueCount: overdueRows.length,
        nextDue: data[0]?.due_date ?? null,
        overdueTotal: roundToFils(overdueRows.reduce((sum, row) => sum + Number(row.balance), 0)),
      };
    },
  });
}

/**
 * صافي التأمين الذي ما زال المكتب يحمله للمستأجر، مقصورًا على العقود الظاهرة له.
 *
 * تأمين is the deposit, and `insurance_payments` (migration 56, fed from
 * `contracts.deposit` by migration 103) is what was actually COLLECTED rather
 * than what the contract says is owed — the two can disagree, and what the
 * office is holding is the number the tenant is entitled to see.
 *
 * Through an RPC rather than a table read: `portal_insurance_total`
 * (migration 216) hands back one number, where a SELECT policy on
 * `insurance_payments` would have authorised every column of every matching
 * row — the staff-entered `note`, `created_by`, and internal unit and building
 * ids — to any tenant calling PostgREST directly. The screen needs a total, so
 * a total is all that leaves the database. It excludes `hide_from_portal`
 * contracts itself, which is also what makes the RLS-exempt staff preview at
 * `/portal?tenant=` agree with what the tenant sees. It also excludes drafts
 * even when a deposit was already collected: `ContractFormDialog` mirrors on
 * save, and the Insurance tab plus the budget KPI keep counting that row.
 *
 * Scoped to the selected contract like the lease and invoice KPIs beside it:
 * a tenant-wide total sitting next to one contract's rent attributed every
 * lease's deposit to that one.
 *
 * Net of completed `contract_closeouts` disposals (`deductions_total`,
 * `settled_total`, and `refund_total` while the linked refund is still live)
 * against live collected, not the close-out `deposit_held` snapshot.
 * Reversed settlements are restored through result.settlement_payment_id,
 * which stays stable after payment references or contract codes change.
 * `void_refund` / `reverse_refund` leave `refund_total` unchanged, so a
 * `refund_id` whose status is `voided` or `reversed` drops out of the net.
 * Generic `public.refunds` stay out: that table has no column saying what a
 * refund is for.
 */
export function usePortalInsurancePaid(
  tenantId: string | null,
  contractId?: string | null,
  enabled = true,
) {
  return useQuery({
    // Keyed UNDER `insurance_payments` rather than beside it as a standalone
    // `portal-…` key. Every mutation that changes this number already calls
    // `invalidateQueries({ queryKey: ["insurance_payments"] })` — the Insurance
    // tab's create/update/delete, `useSyncContractInsurance`, bulk import, and
    // close-out/refund lifecycle actions and payment reversals. React Query matches by key prefix,
    // so the portal entry is swept with those mutations. A standalone key
    // went stale for the shared thirty seconds with focus refetching off, which
    // on a staff preview means showing a total the office has just changed.
    // Review round 1 on PR #212.
    queryKey: ["insurance_payments", "portal-total", tenantId, contractId ?? null],
    enabled: Boolean(tenantId) && enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("portal_insurance_total", {
        p_contract_id: contractId ?? null,
        p_tenant_id: tenantId!,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
  });
}

/** Invoice billing months a payment covered, derived via allocations. */
export type PortalPaymentPeriod = { month: number; year: number };

export type PortalPayment = Tables<"payments"> & {
  /**
   * مجموع ما خُصّص من الدفعة، سواء أمكن حلّ فاتورته أم لا.
   *
   * `payment.amount - allocatedAmount` is the tenant's unapplied remainder, and
   * it is the only figure that can honestly be shown for a payment partly
   * settled onto a lease the portal hides.
   */
  allocatedAmount: number;
  periods: PortalPaymentPeriod[];
  /** عقود الفواتير المخصّصة لهذه الدفعة (قد تكون أكثر من عقد). */
  contractIds: string[];
  /**
   * حصة كل عقد من هذه الدفعة، بالمبلغ والفترات الخاصة به.
   *
   * A payment can settle invoices from two contracts, and the portal shows it
   * under both. Reporting the whole `payment.amount` under each would
   * double-count the transaction, and listing all its periods under each would
   * attach one contract to months belonging to the other. So a contract-scoped
   * view reads from here; only the receipt stays transaction-wide, because a
   * receipt documents what was actually paid in one go.
   */
  byContract: Record<string, { amount: number; periods: PortalPaymentPeriod[] }>;
};

/** خيار عقد واحد في قائمة اختيار العقود بالبوابة. */
export interface PortalContractOption {
  id: string;
  code: string;
  type: Tables<"contracts">["type"];
  state: Tables<"contracts">["state"];
  start_date: string;
  end_date: string;
  monthly_amount: number;
}

/**
 * عقود المستأجر غير المؤرشفة، الأحدث أولاً.
 *
 * Every state, not active-only: an ended contract still owns invoices and
 * payments, and hiding it would hide the tenant's own history from them.
 * Archived contracts are excluded, matching every other path since migration 82.
 *
 * The order is what the switcher numbers 1..n and what an absent `?contract=`
 * resolves against, so "most recent first" is the default a tenant lands on.
 * It used to join `contract_units` and `units` to carry each contract's unit
 * codes; the label dropped them, which left two queries per page load feeding
 * a field nobody read.
 */
export function usePortalContracts(tenantId: string | null) {
  return useQuery({
    queryKey: ["portal-contracts", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<PortalContractOption[]> => {
      const { data, error } = await supabase
        .from("contracts")
        .select("id, code, type, state, start_date, end_date, monthly_amount")
        .eq("tenant_id", tenantId!)
        .is("archived_at", null)
        // Migration 210 — a roof contract the office collects by hand never
        // appears here, so it is absent from the switcher and from every count
        // derived from it.
        .eq("hide_from_portal", false)
        .order("start_date", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Confirmed/reversed payments for the portal history table.
 *
 * Periods come from allocated invoices (not payment_date): a payment in May can
 * settle April rent, and multi-invoice payments need every month listed.
 * contractIds are derived the same way — payments have no contract_id column.
 */
export function usePortalPayments(tenantId: string | null) {
  return useQuery({
    queryKey: ["portal-payments", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<PortalPayment[]> => {
      const { data: payments, error } = await supabase
        .from("payments")
        .select("*")
        .eq("tenant_id", tenantId!)
        .in("status", ["confirmed", "reversed"])
        .order("payment_date", { ascending: false });
      if (error) throw error;
      if (!payments.length) return [];

      // Chunked, here and below: a long-lease tenant holds hundreds of invoices,
      // and one `in()` filter that wide is a 414 rather than a slow query.
      const paymentIds = payments.map((payment) => payment.id);
      const allocations = await fetchInChunks(paymentIds, (chunk) =>
        supabase
          .from("payment_allocations")
          .select("payment_id, invoice_id, amount")
          .in("payment_id", chunk),
      );

      // Two different questions, two different sources.
      //
      // `hiddenContractIds` strips the hidden *slice* from a payment that
      // settled a visible and a hidden lease together — that payment survives,
      // showing only what it put on the visible one. Read as the caller, so it
      // is empty in a tenant session (migration 212 hides those rows) and
      // populated in the RLS-exempt staff preview, which is where it is needed.
      //
      // `hiddenPaymentIds` decides which payments disappear entirely, and that
      // cannot be inferred client-side: an invoice may also be unreadable
      // because an admin set `is_visible_to_tenant = false`, and those payments
      // must stay in the tenant's history. `portal_hidden_payment_ids`
      // (migration 214) answers it on the server.
      const [hiddenContractsResult, hiddenPaymentsResult] = await Promise.all([
        supabase
          .from("contracts")
          .select("id")
          .eq("tenant_id", tenantId!)
          .eq("hide_from_portal", true),
        supabase.rpc("portal_hidden_payment_ids", { p_tenant_id: tenantId! }),
      ]);
      if (hiddenContractsResult.error) throw hiddenContractsResult.error;
      if (hiddenPaymentsResult.error) throw hiddenPaymentsResult.error;
      const hiddenContractIds = new Set(hiddenContractsResult.data.map((row) => row.id));
      const hiddenPaymentIds = new Set(hiddenPaymentsResult.data ?? []);

      const invoiceIds = [...new Set(allocations.map((row) => row.invoice_id))];
      const invoicesById = new Map<string, PortalPaymentPeriod & { contract_id: string }>();
      if (invoiceIds.length) {
        const invoices = await fetchInChunks(invoiceIds, (chunk) =>
          supabase
            .from("invoices")
            .select("id, period_month, period_year, contract_id")
            .in("id", chunk),
        );
        for (const invoice of invoices) {
          invoicesById.set(invoice.id, {
            month: invoice.period_month,
            year: invoice.period_year,
            contract_id: invoice.contract_id,
          });
        }
      }

      // The fold itself lives in `foldPortalPaymentAllocations` so the one rule
      // that is easy to get backwards — a payment counts as allocated before
      // its invoice resolves, not after — is covered by a test instead of by
      // this query function's shape.
      const folded = foldPortalPaymentAllocations({
        allocations,
        hiddenContractIds,
        hiddenPaymentIds,
        invoicesById,
        paymentIds,
      });

      return payments.flatMap((payment) => {
        const result = folded.get(payment.id);
        // null means every allocation this payment had pointed at a contract
        // the tenant cannot see, so the payment belongs to a lease the portal
        // denies exists.
        if (!result) return [];
        return [{ ...payment, ...result }];
      });
    },
  });
}
