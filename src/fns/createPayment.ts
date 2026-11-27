import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { companyOrigin } from "@/company/companyUrl.server";
import { CompanyContextError } from "@/company/errors";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { loadActiveGatewayConnection } from "@/gateways/connectionStore.server";
import { gatewayRegistry } from "@/gateways/registry";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  Database,
  GatewayPaymentMethod,
  Json,
  Tables,
} from "@/integrations/supabase/database.types";
import { enabledPaymentMethods } from "@/lib/paymentHandoff";

import { roundToFils } from "@/lib/fils";
import { requirePermission } from "@/fns/requirePermission";
import { reservePaymentRequest, type InvoiceSelection } from "./paymentRequestReservation";

/**
 * طرق الدفع الثلاث المعتمدة على صفحة الدفع المستضافة.
 *
 * MyFatoorah v3 also accepts `CARD`, which is deliberately excluded: the tenant
 * portal offers these three only. Note the underscores — the gateway expects
 * `APPLE_PAY` / `GOOGLE_PAY`, not `APPLEPAY` / `GOOGLEPAY`, and a wrong spelling
 * fails at the gateway rather than at this boundary. Each value must also be
 * enabled on the MyFatoorah account; a pinned-but-disabled method fails there
 * too, which is why this enum stays a closed list rather than a free string.
 */
export const hostedPaymentMethods = ["KNET", "GOOGLE_PAY", "APPLE_PAY"] as const;

export type HostedPaymentMethod = (typeof hostedPaymentMethods)[number];

/**
 * Exported so the method restriction is testable on its own. The `createServerFn`
 * mock used across these tests never runs `.validator()`, so a schema left
 * unexported is asserted by nothing — the enum would silently accept anything.
 */
export const inputSchema = z.object({
  invoiceIds: z.array(z.string().uuid()).min(1).max(100),
  /**
   * Pins the hosted page to a single method, so choosing KNET lands on the KNET
   * page rather than on MyFatoorah's own method chooser.
   *
   * Stays optional: omitted means "show every enabled method", which is what the
   * admin-side callers still rely on.
   */
  paymentMethod: z.enum(hostedPaymentMethods).optional(),
  /**
   * Optional contract scope for pay-oldest-first validation.
   *
   * When set, evaluate_portal_payable_invoices renumbers within that contract so
   * a tenant can pay contract B while contract A still has older arrears.
   * Omitted keeps today's tenant-wide prefix rule.
   */
  contractId: z.string().uuid().nullable().optional(),
});
export const NO_ACTIVE_GATEWAY = "NO_ACTIVE_GATEWAY";

const HOSTED_TO_GATEWAY_METHOD: Record<HostedPaymentMethod, GatewayPaymentMethod> = {
  APPLE_PAY: "applepay",
  GOOGLE_PAY: "googlepay",
  KNET: "knet",
};

type AuthenticatedSupabase = SupabaseClient<Database>;

export interface PortalInvoice {
  balance: number;
  invoice_id: string;
  is_selectable: boolean;
  period_month: number;
  period_year: number;
}

interface TenantPaymentContext {
  /**
   * Staff taking a payment on a tenant's behalf, rather than the tenant paying
   * for themselves. Already decided by `tenantPaymentContext`; carried on the
   * context because two separate rules exempt staff — the portal switch and the
   * admin's payment-method settings.
   */
  actingAsStaff: boolean;
  tenant: Tables<"tenants">;
}

interface GatewayExecution {
  gatewayResponse: Json;
  paymentUrl: string;
  providerInvoiceId: string | null;
  providerPaymentId: string | null;
  requestPayload: Json;
}

/**
 * يستخرج معرّف المستأجر الدافع من الفواتير المختارة فقط، ويرفض أي خلط بين أكثر من مستأجر.
 *
 * The paying tenant is derived from the selected invoices, never from client
 * input — a caller cannot name a tenant they do not have invoices for. All
 * selected invoices must belong to the same tenant.
 */
async function tenantIdFromInvoices(
  supabase: AuthenticatedSupabase,
  invoiceIds: string[],
): Promise<string> {
  const invoiceQuery = await supabase.from("invoices").select("tenant_id").in("id", invoiceIds);
  if (invoiceQuery.error) throw new Error(invoiceQuery.error.message);
  // A short read also covers the RLS case: rows the caller cannot see are absent.
  // Error (not Response): TanStack Start marks a thrown Response as x-tss-raw and
  // the client resolves the await as success, so permission/validation failures
  // never hit catch. A plain Error rejects and reaches the UI toast. See also
  // notifyRefundRecorded.ts / deleteAppUser.ts.
  if (invoiceQuery.data.length !== invoiceIds.length) {
    throw new Error("Invalid invoice selection.");
  }
  const tenantIds = new Set(invoiceQuery.data.map((row) => row.tenant_id));
  if (tenantIds.size !== 1) {
    throw new Error("Invoices must belong to a single tenant.");
  }
  return [...tenantIds][0];
}

/**
 * يتحقق من صلاحية المستخدم لدفع فواتير المستأجر: إمّا المستأجر نفسه أو موظف يملك `payment_links.create`.
 *
 * Authorizes payment for `tenantId`, which is either the caller's own tenant or
 * — for staff holding `payment_links.create` — any tenant. The staff path is
 * what lets an admin complete a payment while previewing a tenant's portal;
 * staff profiles have `tenant_id = null`, so keying off that column alone
 * (as this did before) made the admin path impossible.
 */
async function tenantPaymentContext(
  supabase: AuthenticatedSupabase,
  userId: string,
  tenantId: string,
): Promise<TenantPaymentContext> {
  const profileQuery = await supabase
    .from("profiles")
    .select("tenant_id")
    .eq("id", userId)
    .single();
  if (profileQuery.error) throw new Error(profileQuery.error.message);

  const isOwnTenant = profileQuery.data.tenant_id === tenantId;
  if (!isOwnTenant) {
    await requirePermission(
      { supabase, userId },
      {
        code: "payment_links.create",
        attempted: "payment.create_link",
        // Staff profiles have tenant_id = null; another tenant's profile does not.
        // Distinct messages so the admin toast can name the actual refusal.
        refusal:
          profileQuery.data.tenant_id === null
            ? "You do not have permission to create payment links."
            : "You are not authorized to pay invoices for this tenant.",
        entityType: "tenant",
        entityId: tenantId,
      },
    );
  }
  return enabledTenantContext(supabase, tenantId, { actingAsStaff: !isOwnTenant });
}

/** يقرأ سجل المستأجر ويتحقق من تفعيل بوابته ما لم يكن الدافع موظفاً. */
async function enabledTenantContext(
  supabase: AuthenticatedSupabase,
  tenantId: string,
  options: { actingAsStaff: boolean } = { actingAsStaff: false },
): Promise<TenantPaymentContext> {
  const tenantQuery = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (tenantQuery.error) throw new Error(tenantQuery.error.message);
  // The portal switch gates the tenant's own self-service access. Staff taking
  // a payment on the tenant's behalf are not bound by it, matching the portal
  // layout, which already lets staff preview a disabled portal.
  if (!tenantQuery.data.tenant_portal_enabled && !options.actingAsStaff) {
    throw new Error("Tenant portal is disabled.");
  }
  return { tenant: tenantQuery.data, actingAsStaff: options.actingAsStaff };
}

/**
 * نص الرفض الموحّد لوسيلة دفع غير متاحة.
 *
 * Deliberately says nothing about *why*. A tenant learning which rails exist but
 * are switched off gains nothing, and the two reasons — disabled by the admin,
 * or a tenant with no company row — are an operator's concern, not theirs.
 */
const METHOD_NOT_AVAILABLE = "This payment method is not available.";

/**
 * يرفض وسيلة دفع لم يفعّلها المشرف لبوابة المستأجر.
 *
 * Exported so the rule is assertable without standing up the gateway. It cannot
 * live in `inputSchema`: the enabled set is a database read, and the
 * `createServerFn` mock these tests use never runs `.validator()`, so a rule
 * placed there would be asserted by nothing.
 *
 * Throws an `Error` rather than a `Response`. A thrown `Response` is delivered
 * to the client as a *resolved* value via `x-tss-raw`, so the caller would read
 * a refusal as a successful payment.
 */
export function assertPortalMethodEnabled(input: {
  enabled: readonly HostedPaymentMethod[];
  method: HostedPaymentMethod;
}): void {
  if (!input.enabled.includes(input.method)) {
    throw new Error(METHOD_NOT_AVAILABLE);
  }
}

/**
 * يقرأ وسائل الدفع التي فعّلها المشرف لشركة المستأجر.
 *
 * Deliberately the caller's own client rather than `supabaseAdmin`: only the
 * paying tenant ever reaches this read (staff are exempt from the rule), and
 * `companies_select_tenant` already grants them that row. Reaching for the
 * service-role key in a money path buys nothing here and gives up the
 * user-scoped posture the rest of the admin-triggered paths keep.
 *
 * Fails closed throughout — no company link, no row, or a denied read all
 * refuse. A permissive fallback would reopen exactly the hole this lookup
 * exists to close.
 */
async function enabledMethodsForTenant(supabase: AuthenticatedSupabase, tenant: Tables<"tenants">) {
  // `tenants.company_id` is nullable in the schema. A tenant with no company has
  // no settings row to consult, and guessing "all methods" would let that one
  // broken record bypass the rule.
  if (!tenant.company_id) {
    throw new Error(METHOD_NOT_AVAILABLE);
  }
  const companyQuery = await supabase
    .from("companies")
    .select("portal_apple_pay_enabled, portal_google_pay_enabled")
    .eq("id", tenant.company_id)
    .single();
  if (companyQuery.error) throw new Error(companyQuery.error.message);
  return enabledPaymentMethods({
    applePay: companyQuery.data.portal_apple_pay_enabled,
    googlePay: companyQuery.data.portal_google_pay_enabled,
  });
}

/**
 * يتحقق من أن الفواتير المختارة بادئة صحيحة لقائمة القابل للدفع (أقدم أولاً).
 *
 * When `contractId` is set the RPC returns that contract's rows renumbered from
 * 1, so the prefix check is per-contract (decision D1). Without it the list is
 * tenant-wide — same as before migration 121.
 */
async function invoiceSelection(input: {
  invoiceIds: string[];
  supabase: AuthenticatedSupabase;
  tenantId: string;
  contractId?: string | null;
}): Promise<InvoiceSelection> {
  // Migration 210 — asked for unconditionally, granted only to staff: the RPC
  // downgrades the flag for a tenant caller. That is what keeps an admin's
  // manually generated KNET link working for a roof invoice while a tenant
  // crafting the same request against their own hidden contract still cannot
  // pay it from the portal.
  const payableQuery = await input.supabase.rpc("evaluate_portal_payable_invoices", {
    p_tenant_id: input.tenantId,
    p_include_hidden: true,
    ...(input.contractId ? { p_contract_id: input.contractId } : {}),
  });
  if (payableQuery.error) throw new Error(payableQuery.error.message);
  const requestedIds = new Set(input.invoiceIds);
  if (
    requestedIds.size !== input.invoiceIds.length ||
    input.invoiceIds.length > payableQuery.data.length
  ) {
    throw new Error("Invalid invoice selection.");
  }
  const selectedInvoices = payableQuery.data.slice(0, input.invoiceIds.length);
  if (
    payableQuery.data[0]?.is_selectable !== true ||
    !selectedInvoices.every((invoice) => requestedIds.has(invoice.invoice_id))
  ) {
    // Error (not Response): useServerFn drops Response.status/body on the client,
    // so a Response here used to surface as the generic "Could not load the data"
    // toast. A plain Error keeps the chronological-order wording for the UI.
    throw new Error("Invoices must be paid in chronological order.");
  }
  const total = roundToFils(selectedInvoices.reduce((sum, invoice) => sum + invoice.balance, 0));
  if (total <= 0) throw new Error("No payable balance remains.");
  return {
    invoices: selectedInvoices,
    invoiceIds: selectedInvoices.map((invoice) => invoice.invoice_id),
    total,
  };
}

/** يكتب سجل التدقيق لإنشاء طلب الدفع، ويعلّم الطلب فاشلاً إن تعذّر التدقيق. */
async function auditPaymentRequest(
  supabase: AuthenticatedSupabase,
  db: AuthenticatedSupabase,
  paymentRequest: Tables<"payment_requests">,
) {
  const auditQuery = await supabase.rpc("write_audit", {
    p_action: "payment_request.create",
    p_entity_type: "payment_request",
    p_entity_id: paymentRequest.id,
    p_before: null,
    p_after: {
      code: paymentRequest.code,
      amount: paymentRequest.amount,
      invoice_ids: paymentRequest.requested_invoice_ids,
      gateway: paymentRequest.gateway,
    },
    p_result: "success",
    p_error_code: null,
  });
  if (!auditQuery.error) return;
  await failPaymentRequest(db, paymentRequest.id, auditQuery.error.message);
  throw new Error(`Audit log write failed: ${auditQuery.error.message}`);
}

/**
 * يبني جسم طلب الدفع المستضاف لـ MyFatoorah v3 (`/v3/payments`).
 *
 * Exported so the method-restriction rule is testable without standing up the
 * whole gateway path: whether `PaymentMethod` is present at all is the entire
 * difference between "KNET only" and "show every enabled method", and that is
 * exactly the kind of thing that silently regresses.
 */
export function buildHostedPaymentPayload(input: {
  amount: number;
  paymentRequestCode: string;
  redirectUrl: string;
  tenantName: string;
  tenantId: string;
  paymentMethod?: HostedPaymentMethod;
}) {
  return {
    NotificationOption: "LINK",
    Order: { Amount: input.amount, Currency: "KWD" },
    Customer: { Name: input.tenantName, Reference: input.paymentRequestCode },
    IntegrationUrls: { Redirection: input.redirectUrl },
    UserDefinedField: input.tenantId,
    // Spread rather than a plain key. MyFatoorah treats an ABSENT
    // PaymentMethod as "show every enabled method" — which is the behaviour
    // every existing caller relies on — so the key must not appear at all when
    // no method was requested.
    ...(input.paymentMethod ? { PaymentMethod: input.paymentMethod } : {}),
  };
}

/** يعلّم طلب الدفع فاشلاً ويحفظ رسالة الخطأ عبر عميل الشركة. */
async function failPaymentRequest(
  db: AuthenticatedSupabase,
  paymentRequestId: string,
  message: string,
) {
  await db
    .from("payment_requests")
    .update({ status: "failed", gateway_response: { error: message } })
    .eq("id", paymentRequestId);
}

/** يحفظ رابط البوابة ومعرّف الفاتورة الناتج وربط الاتصال على طلب الدفع عبر عميل الشركة. */
async function saveGatewayExecution(
  db: AuthenticatedSupabase,
  paymentRequestId: string,
  execution: GatewayExecution,
  binding: {
    gateway: "myfatoorah" | "tap" | "upayments";
    gatewayConnectionId: string;
    credentialsVersion: number;
  },
) {
  const updateQuery = await db
    .from("payment_requests")
    .update({
      gateway:
        binding.gateway as Database["public"]["Tables"]["payment_requests"]["Insert"]["gateway"],
      gateway_connection_id: binding.gatewayConnectionId,
      credentials_version: binding.credentialsVersion,
      provider_invoice_id: execution.providerInvoiceId,
      provider_payment_id: execution.providerPaymentId,
      payment_url: execution.paymentUrl,
      request_payload: execution.requestPayload,
      gateway_response: execution.gatewayResponse,
    })
    .eq("id", paymentRequestId)
    .select("code,payment_url")
    .single();
  if (updateQuery.error) throw new Error(updateQuery.error.message);
  return { paymentUrl: updateQuery.data.payment_url!, paymentRequestCode: updateQuery.data.code };
}

export type CreatePaymentInput = z.infer<typeof inputSchema>;

/** ينشئ طلب دفع ورابط بوابة مرتبطين باتصال البوابة النشط للشركة. */
export const createPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(inputSchema)
  .handler(async ({ data: requestInput, context }) => {
    const company = requireRequestCompany();
    // A suspended company gets no new payment link. The refusal comes first:
    // an in-flight payment still settles (the settlement path is exempt from
    // the suspension), but nothing may start, and no gateway is contacted.
    if (company.status === "suspended") {
      throw new CompanyContextError("COMPANY_SUSPENDED");
    }
    const payingTenantId = await tenantIdFromInvoices(context.supabase, requestInput.invoiceIds);
    const tenantContext = await tenantPaymentContext(
      context.supabase,
      context.userId,
      payingTenantId,
    );
    if (tenantContext.tenant.company_id !== company.id) {
      throw new Error("Invalid invoice selection.");
    }
    const db = companyClient(company.id);
    // Before `reservePaymentRequest`, deliberately: a refusal that ran after it
    // would still have minted or reset a payment_requests row for a payment
    // that can never happen. Staff are exempt for the same reason they are
    // exempt from the portal switch — an admin issuing a link is not the tenant
    // self-serving, and `admin.invoices.tsx` pins KNET explicitly.
    if (requestInput.paymentMethod && !tenantContext.actingAsStaff) {
      assertPortalMethodEnabled({
        enabled: await enabledMethodsForTenant(context.supabase, tenantContext.tenant),
        method: requestInput.paymentMethod,
      });
    }
    const activeConnection = await loadActiveGatewayConnection(db);
    if (!activeConnection) {
      throw new Error(
        `${NO_ACTIVE_GATEWAY}: No active payment gateway is configured for this company.`,
      );
    }
    const gateway = gatewayRegistry.create(activeConnection.connection);
    const selection = await invoiceSelection({
      supabase: context.supabase,
      tenantId: tenantContext.tenant.id,
      invoiceIds: requestInput.invoiceIds,
      contractId: requestInput.contractId,
    });
    // The renter returns to the host they paid from, so the callback stays on
    // this company's address and its session cookie.
    const appBaseUrl = companyOrigin(company.host);
    const reservation = await reservePaymentRequest({
      companyId: company.id,
      tenantId: tenantContext.tenant.id,
      userId: context.userId,
      selection,
      paymentMethod: requestInput.paymentMethod,
      gateway: activeConnection.provider,
      gatewayConnectionId: activeConnection.id,
      credentialsVersion: activeConnection.credentialsVersion,
    });
    if (reservation.reused) {
      return {
        paymentUrl: reservation.request.payment_url!,
        paymentRequestCode: reservation.request.code,
      };
    }
    await auditPaymentRequest(context.supabase, db, reservation.request);
    try {
      // MyFatoorah replaces callback query strings, so keep the fallback code in the path.
      const redirectUrl = `${appBaseUrl.replace(/\/$/, "")}/portal/payments/callback/${encodeURIComponent(reservation.request.code)}`;
      const execution = await gateway.createPayment({
        amount: selection.total,
        paymentRequestCode: reservation.request.code,
        redirectUrl,
        customerName: tenantContext.tenant.name,
        customerReference: tenantContext.tenant.id,
        method: requestInput.paymentMethod
          ? HOSTED_TO_GATEWAY_METHOD[requestInput.paymentMethod]
          : undefined,
      });
      return await saveGatewayExecution(db, reservation.request.id, execution, {
        gateway: activeConnection.provider,
        gatewayConnectionId: activeConnection.id,
        credentialsVersion: activeConnection.credentialsVersion,
      });
    } catch (gatewayError) {
      const message =
        gatewayError instanceof Error ? gatewayError.message : "Payment gateway request failed.";
      await failPaymentRequest(db, reservation.request.id, message);
      throw new Error(message, { cause: gatewayError });
    }
  });
