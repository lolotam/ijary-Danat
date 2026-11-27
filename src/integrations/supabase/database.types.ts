// HAND-MAINTAINED. Do NOT overwrite this file with `supabase gen types` output.
//
// It is written in a generated *style*, but it is not generated. It exports 73
// named aliases (AppRole, LocaleCode, InvoiceState, PaymentMethod, …) that the
// Supabase generator does not emit — the generator nests everything under
// `Database["public"]["Enums"]`. Around 70 files import those aliases, so a
// wholesale regeneration breaks the build.
//
// To add a table or RPC: run `bun run gen:types`, which writes the generated
// shape to database.types.generated.ts, then copy across just the entry you
// need, matching the surrounding style, and delete the generated file.
// scripts/gen-types.sh refuses to overwrite this file unless given --force.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type AppRole = "admin" | "accountant" | "collector" | "readonly" | "tenant";
export type LocaleCode = "ar" | "en";
export type AuditResult = "success" | "failure" | "error";
/** Historical enum members; column is free text after migration 103. */
export type PropertyType = "compound" | "building_complex" | "tower" | "villa_compound" | "other";
export type ElectricityMeterOwnership = "company_owned" | "tenant_owned";
export type UnitStatus =
  | "available"
  | "reserved"
  | "occupied"
  | "vacant"
  | "under_maintenance"
  | "archived";
/** Historical enum members; column is free text after migration 103. */
export type UnitType =
  | "apartment"
  | "shop"
  | "office"
  | "commercial"
  | "warehouse"
  | "villa"
  | "other";
export type TenantCategory =
  | "vip"
  | "uncommitted"
  | "chronically_distressed"
  | "standard"
  | "custom";
export type TenantLifecycle = "active" | "inactive" | "contract_ended" | "blocked";
export type RefundPostAction = "archive" | "freeze" | "store";
/** Migration 85 — posted refunds may be reversed (mirror row) or voided. */
export type RefundStatus = "draft" | "posted" | "voided" | "reversed";
/** Migration 84 — contract close-out header status. */
export type CloseoutStatus = "draft" | "completed" | "cancelled";
/** Migration 84 — final disposition of the contract after close-out. */
export type CloseoutOutcome = "keep_terminated" | "freeze" | "archive";
/** Migration 84 — per-invoice action taken during close-out. */
export type CloseoutInvoiceActionKind =
  | "leave"
  | "settle_from_deposit"
  | "write_off"
  | "cancel"
  | "mark_disputed";
/** Migration 84 — deduction line kinds on a close-out. */
export type CloseoutDeductionKind = "damages" | "cleaning" | "utilities" | "unpaid_rent" | "other";
/** Migration 84 — operational timeline events rendered on the contract detail page. */
export type ContractOperationalEventType =
  | "closeout_started"
  | "closeout_cancelled"
  | "closeout_completed"
  | "archived"
  | "restored"
  | "refund_reversed"
  | "refund_voided"
  | "invoice_written_off"
  | "invoice_disputed"
  | "dispute_cleared";
export type TenantDocumentType =
  | "civil_id"
  | "commercial_license"
  | "power_of_attorney"
  | "authorized_signature"
  | "contract"
  | "payment_evidence"
  | "other";
export type ContractType = "investment" | "lease";
export type ContractState =
  | "draft"
  | "active"
  | "frozen"
  | "suspended"
  | "expired"
  | "renewed"
  | "terminated";
export type ConcessionType = "free_months" | "percentage_discount" | "fixed_discount";
export type InvoiceState = "due" | "overdue" | "paid" | "partially_paid" | "cancelled" | "waived";
/**
 * حالة الدفعة الجزئية — هل سُدِّدت الفاتورة المرتبطة بها.
 *
 * A `text` column with a check constraint, not a Postgres enum (migration 147),
 * so adding a third state later needs no type migration.
 */
export type PartialPaymentStatus = "incomplete" | "complete";
export type PaymentMethod =
  | "payment_link"
  | "bank_transfer"
  | "cheque"
  | "cash"
  | "knet"
  | "applepay"
  | "googlepay"
  | "card"
  | "audit_adjustment";
export type PaymentAccountType = "commercial_account" | "personal_account";
export type GatewayProvider = "myfatoorah";
export type GatewayPaymentMethod = "knet" | "applepay" | "googlepay" | "card";
export type NotificationChannel = "email" | "whatsapp" | "both";
export type NotificationProvider =
  | "smtp"
  | "resend"
  | "whatsapp_cloud_api"
  | "twilio"
  | "postora"
  | "evolution_api";
export type NotificationAudience = "tenant" | "admin" | "both" | "system";
/**
 * أنواع الإشعارات المتاحة، كمصفوفة قابلة للتكرار وقت التشغيل.
 *
 * The union is derived from this tuple rather than written twice. The template
 * editor could not iterate an erased union, so it kept a hand-written list that
 * had drifted to 11 of the 20 types — rendering a blank dropdown for the rest.
 */
export const NOTIFICATION_TYPES = [
  "due_reminder",
  "overdue_reminder",
  "receipt",
  "contract_expiry",
  "scheduled_report",
  "document_send",
  "manual_message",
  "deposit_confirmation",
  "user_credentials",
  "payment_admin_alert",
  "company_info",
  "contact_inquiry",
  "maintenance_request",
  "refund_recorded",
  "contract_created",
  "contract_ended",
  "contract_closeout",
  "contract_restored",
  "invoice_written_off",
  "invoice_disputed",
  "whatsapp_session_alert",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationState =
  | "queued"
  | "sent"
  | "failed"
  | "skipped"
  | "cancelled"
  | "needs_review";
export type ReportFrequency = "daily" | "weekly" | "monthly" | "yearly";
/** Migration 241 — which SQL builder renders a scheduled report. */
export type ReportKind = "summary" | "overdue_contracts";
export type ExpenseClass =
  | "contractual_monthly"
  | "contractual_annual"
  | "regular_recurring"
  | "sudden_one_time";
export type TariffType = "flat" | "tiered" | "per_unit";
export type ElectricityChargeStatus = "draft" | "issued" | "paid" | "cancelled";
export type MaintenancePriority = "low" | "medium" | "high" | "urgent";
export type MaintenanceStatus = "open" | "in_progress" | "completed" | "cancelled";
/** Migration 254 — حالة الشركة في المنصة. */
export type CompanyStatus = "active" | "suspended";
/** Migration 254 — نوع نطاق الشركة (فرعي أو مخصص). */
export type CompanyDomainKind = "subdomain" | "custom";
/** Migration 254 — حالة التحقق من النطاق. */
export type DomainVerificationStatus = "verified" | "pending" | "failed";

export type CompanyDomainRow = {
  id: string;
  company_id: string;
  host: string;
  kind: CompanyDomainKind;
  is_primary: boolean;
  verification_status: DomainVerificationStatus;
  provider_ref: string | null;
  created_at: string;
  updated_at: string;
};

export type ReservedSlugRow = {
  slug: string;
  created_at: string;
};

/** Migration 284 — أنواع عدّادات الترقيم المعزولة لكل شركة. */
export type CompanyCounterKind =
  | "invoice"
  | "payment"
  | "receipt"
  | "contract"
  | "refund"
  | "property"
  | "building"
  | "unit"
  | "tenant"
  | "payment_request"
  | "expense"
  | "deposit"
  | "electricity_charge"
  | "employee"
  | "maintenance_request";

export type CompanyCounterRow = {
  company_id: string;
  kind: CompanyCounterKind;
  last_value: number;
};

type TableDefinition<Row, RequiredInsert extends keyof Row = never> = {
  Row: Row;
  Insert: Partial<Row> & Pick<Row, RequiredInsert>;
  Update: Partial<Row>;
  Relationships: [];
};

/** Company-wide show/hide for the KPI cards above each list page (migration 126). */
export type CardVisibilityRow = {
  company_id: string;
  card_id: string;
  is_visible: boolean;
  updated_at: string;
};

export type BuildingCategoryRow = {
  company_id: string;
  code: string;
  created_at: string;
  id: string;
  is_system: boolean;
  name_ar: string;
  name_en: string;
  sort_order: number;
};

export type OptionListRow = {
  company_id: string;
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  description_ar: string | null;
  description_en: string | null;
  is_system: boolean;
  created_at: string;
  updated_at: string;
};

export type OptionListItemRow = {
  company_id: string;
  id: string;
  list_id: string;
  value: string;
  label_ar: string;
  label_en: string;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type PropertyRow = {
  address_ar: string | null;
  address_en: string | null;
  area: number | null;
  code: string;
  company_id: string | null;
  created_at: string;
  description_ar: string | null;
  description_en: string | null;
  floor_count: number | null;
  id: string;
  image_url: string | null;
  location_url: string | null;
  name_ar: string;
  name_en: string | null;
  paci_no: string | null;
  status: "active" | "inactive" | "archived";
  /** Free-text type (migration 103); catalogue is Settings → Lists property_types. */
  type: string;
  unit_count: number | null;
  updated_at: string;
};

export type BuildingRow = {
  company_id: string;
  address_ar: string | null;
  address_en: string | null;
  area: number | null;
  category_id: string | null;
  code: string;
  created_at: string;
  description_ar: string | null;
  description_en: string | null;
  floors: number | null;
  id: string;
  image_url: string | null;
  name_ar: string;
  name_en: string | null;
  property_id: string;
  status: "active" | "inactive" | "under_maintenance" | "archived";
  updated_at: string;
};

export type UnitRow = {
  company_id: string;
  area: number | null;
  building_id: string | null;
  code: string;
  created_at: string;
  default_rent: number | null;
  description_ar: string | null;
  description_en: string | null;
  electricity_meter_ownership: ElectricityMeterOwnership;
  /** Free-text floor label (migration 101); catalogue is Settings → Lists unit_floors. */
  floor: string | null;
  id: string;
  name: string;
  name_en: string | null;
  /** Kuwait civil-information unit number (migration 105); free text, nullable. */
  paci_no: string | null;
  property_id: string;
  status: UnitStatus;
  /** Free-text type (migration 103); catalogue is Settings → Lists unit_types. */
  type: string;
  updated_at: string;
};

/** T13a — money returned to a tenant, with what happens to them afterwards. */
export type RefundRow = {
  amount: number;
  building_id: string | null;
  /** Migration 85 — human-readable REF-0000001 style code. */
  code: string;
  company_id: string | null;
  contract_id: string | null;
  created_at: string;
  created_by: string | null;
  currency: string;
  id: string;
  note: string | null;
  post_action: RefundPostAction;
  reason: string | null;
  refund_date: string;
  /** Migration 85 — set only on the positive mirror row from reverse_refund. */
  reversal_of_id: string | null;
  /** Migration 85 — draft | posted | voided | reversed. */
  status: RefundStatus;
  tenant_id: string;
  unit_id: string | null;
  updated_at: string;
  void_reason: string | null;
  voided_at: string | null;
  voided_by: string | null;
};

/**
 * T13b — deliberately inert. These rows create no payment allocation, do not
 * move `invoices.paid`, and are excluded from get_budget_summary and from
 * get_payments_summary `net` (partial card is display-only).
 */
export type PartialPaymentRow = {
  amount: number;
  building_id: string | null;
  company_id: string | null;
  contract_id: string | null;
  created_at: string;
  created_by: string | null;
  currency: string;
  id: string;
  invoice_id: string | null;
  note: string | null;
  paid_date: string;
  /** Migration 147. 'complete' once the linked invoice settles — maintained by
   *  a trigger on `invoices`, in both directions. Rows with no `invoice_id`
   *  carry whatever the admin set. */
  status: PartialPaymentStatus;
  tenant_id: string;
  unit_id: string | null;
  updated_at: string;
};

/** T13c — the tenant's deposit held with us. NOT public.deposits, which is bank deposits. */
export type InsurancePaymentRow = {
  amount: number;
  building_id: string | null;
  collected_date: string;
  company_id: string | null;
  contract_id: string;
  created_at: string;
  created_by: string | null;
  currency: string;
  id: string;
  note: string | null;
  tenant_id: string;
  unit_id: string | null;
  updated_at: string;
};

/** T14a — a member of staff. Staff-only under RLS; salary figures never reach the portal. */
export type EmployeeRow = {
  avatar_path: string | null;
  code: string;
  company_id: string | null;
  created_at: string;
  created_by: string | null;
  email: string | null;
  hired_on: string | null;
  id: string;
  is_active: boolean;
  mobile: string | null;
  name: string;
  name_en: string | null;
  nickname: string | null;
  notes: string | null;
  salary: number;
  updated_at: string;
};

/** Mirrors TenantDocumentRow PLUS `expiry_date`, which tenant_documents lacks. */
export type EmployeeDocumentRow = {
  company_id: string;
  created_at: string;
  display_name: string | null;
  document_type: string;
  employee_id: string;
  expiry_date: string | null;
  id: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string;
  uploaded_by: string | null;
};

/** One row per employee per month. `amount` is copied at generation time. */
export type SalaryRow = {
  company_id: string;
  amount: number;
  created_at: string;
  delivered: boolean;
  delivered_at: string | null;
  delivered_by: string | null;
  employee_id: string;
  id: string;
  month: number;
  note: string | null;
  updated_at: string;
  year: number;
};

/** Who a workflow registry row may notify. See src/lib/workflowCatalog.ts. */
export type WorkflowRecipientTarget = "admin" | "company" | "tenant";

/** T14b — the cron registry. Modelled on report_schedules, plus a pause switch. */
export type CronJobRow = {
  company_id: string;
  created_at: string;
  description_ar: string | null;
  description_en: string | null;
  id: string;
  is_active: boolean;
  key: string;
  kind: "scheduled" | "event";
  /** Migration 229 — written only by `claim_cron_run`. */
  last_claimed_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  last_run_at: string | null;
  last_status: "success" | "error" | "skipped" | null;
  name_ar: string;
  name_en: string;
  recipient_targets: WorkflowRecipientTarget[];
  updated_at: string;
};

export type MaintenanceRequestRow = {
  building_id: string | null;
  code: string;
  company_id: string;
  created_at: string;
  created_by: string | null;
  description: string | null;
  id: string;
  priority: MaintenancePriority;
  property_id: string;
  status: MaintenanceStatus;
  title: string;
  unit_id: string | null;
  updated_at: string;
};

export type TenantRow = {
  archived_at: string | null;
  /** Migration 149 — retired. No longer read or written by the application;
   *  the tenant form collects `commercial_address` instead. */
  alternate_contacts: Json | null;
  authorized_manager: string | null;
  authorized_manager_civil_id: string | null;
  avatar_media_id: string | null;
  category: TenantCategory;
  code: string;
  /** Migration 140 — deprecated. A trigger-maintained mirror of
   *  `commercial_name_ar` / `_en`, kept so pre-140 readers and writers
   *  (bulk_import_phase6, the CSV export) keep working. Read the pair. */
  commercial_name: string | null;
  commercial_address: string | null;
  commercial_name_ar: string | null;
  commercial_name_en: string | null;
  company_id: string | null;
  created_at: string;
  email: string | null;
  id: string;
  lifecycle: TenantLifecycle;
  mobile: string | null;
  name: string;
  name_en: string | null;
  nationality: string | null;
  notes: string | null;
  // Migration 248 — owner decision 2026-10-20.
  notifications_paused: boolean;
  owner_civil_id: string | null;
  /** Migration 149 — retired. No longer read or written by the application;
   *  the tenant form collects `owner_civil_id` instead. */
  owner_name: string | null;
  // Portal tab overrides (migration 46). null = follow the tenant role
  // permission, true = force show, false = force hide.
  portal_tab_dashboard: boolean | null;
  portal_tab_invoices: boolean | null;
  portal_tab_lease: boolean | null;
  portal_tab_payments: boolean | null;
  portal_tab_profile: boolean | null;
  portal_tab_shop: boolean | null;
  preferred_language: LocaleCode;
  receipt_visible_to_tenant: boolean;
  reminders_enabled: boolean;
  tenant_portal_enabled: boolean;
  updated_at: string;
  whatsapp: string | null;
};

export type TenantDocumentRow = {
  company_id: string;
  /** Migration 77 — null means the document applies to the tenant as a whole. */
  contract_id: string | null;
  created_at: string;
  display_name: string | null;
  id: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string;
  tenant_id: string;
  type: TenantDocumentType;
  uploaded_by: string | null;
};

export type ContractRow = {
  company_id: string;
  archived_at: string | null;
  code: string;
  /** App-local commercial activity (migration 99). Free text whose vocabulary
   *  lives in the `commercial_activities` option list, not a foreign key — an
   *  activity deleted from the catalogue leaves a stale label rather than
   *  failing the delete. */
  commercial_activity: string | null;
  created_at: string;
  deposit: number;
  documents: Json | null;
  due_day: number;
  duration_months: number | null;
  end_date: string;
  end_date_override_reason: string | null;
  entry_date: string | null;
  grace_days: number;
  /** Migration 210 — when true, the tenant portal hides this contract entirely:
   *  its invoices, its share of the outstanding balance, and any payment it
   *  could start. Distinct from `suppress_tenant_billing_docs`, which hides
   *  only the printable documents while the invoice stays visible and payable. */
  hide_from_portal: boolean;
  id: string;
  /** Migration 196 — one rent increase per contract, effective from start_date + N years. All three set or all null. */
  increase_after_years: number | null;
  increase_type: "percent" | "fixed" | null;
  increase_value: number | null;
  /** Migration 139 — first day of the furthest month ever generated for this
   *  contract. Ratchets forward only; it is what lets a freed month be restored
   *  after its invoice was deleted. Written by the generation functions, never
   *  by the app. */
  invoices_generated_through: string | null;
  monthly_amount: number;
  notes: string | null;
  start_date: string;
  state: ContractState;
  /** Migration 173 — when true, suppress printable/downloadable billing documents for this contract in the tenant portal. */
  suppress_tenant_billing_docs: boolean;
  tenant_id: string;
  type: ContractType;
  updated_at: string;
};

/** Migration 110 — a contract holds one row per rented unit. */
export type ContractUnitRow = {
  company_id: string;
  contract_id: string;
  created_at: string;
  id: string;
  line_order: number;
  monthly_amount: number;
  /** Trigger-maintained mirror of the uniqueness predicate. Never write it. */
  occupies_unit: boolean;
  unit_id: string;
  updated_at: string;
};

export type ContractExtraChargeRow = {
  company_id: string;
  amount: number;
  category_id: string;
  contract_id: string;
  created_at: string;
  id: string;
  line_order: number;
  updated_at: string;
};

/** صف ربط علامة تجارية بعقد — الجدول الوسيط لعلاقة كثير-إلى-كثير (ترحيل 162). */
export type CommercialBrandContractRow = {
  company_id: string;
  brand_id: string;
  contract_id: string;
  created_at: string;
};

export type ConcessionRow = {
  company_id: string;
  contract_id: string;
  created_at: string;
  discount_amount: number | null;
  discount_percent: number | null;
  end_date: string;
  free_months: number;
  id: string;
  reason: string | null;
  start_date: string;
  status: "active" | "expired" | "cancelled";
  type: ConcessionType;
  updated_at: string;
};

/** Migration 127 — one discount per invoice; unique (invoice_id). */
export type ConcessionInvoiceRow = {
  company_id: string;
  concession_id: string;
  created_at: string;
  invoice_id: string;
};

export type InvoiceRow = {
  balance: number;
  code: string;
  company_id: string | null;
  contract_id: string;
  created_at: string;
  discount: number;
  /** Migration 86 — dispute is a flag, not a state. */
  dispute_reason: string | null;
  disputed_at: string | null;
  disputed_by: string | null;
  due_date: string;
  id: string;
  idempotency_key: string;
  is_visible_to_tenant: boolean;
  issue_date: string;
  /** Migration 108 — option_list_items.value from `manual_payment_reasons`. */
  manual_payment_reason: string | null;
  notes: string | null;
  paid: number;
  /**
   * Migration 108 — derived from the allocated payment by
   * trg_invoice_payment_method. Never write it from application code.
   */
  payment_method: PaymentMethod | null;
  period_month: number;
  period_year: number;
  state: InvoiceState;
  subtotal: number;
  tenant_id: string;
  total: number;
  /** Migration 112 — nullable: a consolidated multi-unit invoice has no single unit. */
  unit_id: string | null;
  updated_at: string;
};

/** Migration 84 — contract close-out header (end-of-tenancy settlement). */
export type ContractCloseoutRow = {
  archive_tenant: boolean;
  balance_due_tenant: number;
  building_id: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  company_id: string | null;
  completed_at: string | null;
  completed_by: string | null;
  contract_id: string;
  contract_updated_at: string | null;
  created_at: string;
  created_by: string | null;
  deductions_total: number;
  deposit_held: number;
  final_contract_state: ContractState;
  id: string;
  idempotency_key: string;
  move_out_date: string;
  note: string | null;
  outcome: CloseoutOutcome;
  refund_id: string | null;
  refund_total: number;
  result: Json | null;
  settled_total: number;
  status: CloseoutStatus;
  tenant_id: string;
  unit_id: string | null;
  updated_at: string;
  written_off_total: number;
};

/** Migration 84 — deduction lines on a close-out. */
export type ContractCloseoutDeductionRow = {
  company_id: string;
  amount: number;
  closeout_id: string;
  created_at: string;
  description_ar: string | null;
  description_en: string | null;
  id: string;
  kind: CloseoutDeductionKind;
  line: number;
};

/** Migration 84 — per-invoice action recorded on a close-out. */
export type ContractCloseoutInvoiceActionRow = {
  company_id: string;
  action: CloseoutInvoiceActionKind;
  amount: number;
  closeout_id: string;
  created_at: string;
  id: string;
  invoice_id: string;
  previous_state: InvoiceState | null;
  resulting_state: InvoiceState | null;
};

/** Migration 84 — contract operational timeline (not audit_logs). */
export type ContractOperationalEventRow = {
  company_id: string;
  actor_id: string | null;
  closeout_id: string | null;
  contract_id: string;
  event_type: ContractOperationalEventType;
  id: string;
  note: string | null;
  occurred_at: string;
  payload: Json | null;
  tenant_id: string | null;
};

export type InvoiceItemRow = {
  company_id: string;
  amount: number;
  created_at: string;
  description_ar: string | null;
  description_en: string | null;
  discount_percent: number;
  id: string;
  invoice_id: string;
  is_concession: boolean;
  /**
   * Migration 169 — this line is a recurring service charge, not rent.
   *
   * Excluded from the base a percentage discount comes off. It exists because
   * the shape cannot be inferred: `unit_id is null` means "extra charge" on a
   * line written since 163 and "rent" on one written before 112 added the
   * column.
   */
  is_extra_charge: boolean;
  line: number;
  quantity: number;
  /** Migration 112 — the unit this line's rent (or contract-level concession) is attributed to. */
  unit_id: string | null;
  unit_price: number;
};

export type PaymentRow = {
  account_type: PaymentAccountType | null;
  amount: number;
  attachment_path: string | null;
  code: string;
  company_id: string | null;
  created_at: string;
  created_by: string | null;
  currency: string;
  id: string;
  method: PaymentMethod;
  note: string | null;
  payment_date: string;
  reference: string | null;
  reversed_by_payment_id: string | null;
  /** Migration 153. Set only by the deposit sync trigger; a client write that
   *  sets or changes it raises `payment_provenance_locked`. Its presence means
   *  this payment exists because a bank deposit was confirmed. Unique. */
  source_deposit_id: string | null;
  /** Migration 160. Set only by the partial-payment settlement trigger; a client
   *  write that sets or changes it raises `payment_provenance_locked`. Its
   *  presence means this payment exists because a partial payment named an
   *  invoice. Unique. */
  source_partial_payment_id: string | null;
  /**
   * Migration 192. The payment_requests row that created this payment, when it
   * came from the gateway. Written by the webhook; null for manual and
   * partial-payment settlements.
   */
  payment_request_id: string | null;
  status: "pending" | "confirmed" | "reversed";
  tenant_id: string;
  unit_id: string | null;
  updated_at: string;
};

export type PaymentAllocationRow = {
  company_id: string;
  amount: number;
  created_at: string;
  id: string;
  invoice_id: string;
  payment_id: string;
};

export type ReceiptRow = {
  company_id: string;
  amount: number;
  code: string;
  created_at: string;
  currency: string;
  html_snapshot: string | null;
  id: string;
  issue_date: string;
  payment_id: string;
  storage_path: string | null;
  tenant_id: string;
  visible_to_tenant: boolean;
};

export type PaymentRequestRow = {
  company_id: string;
  amount: number;
  code: string;
  created_at: string;
  created_by: string | null;
  currency: string;
  gateway: GatewayProvider;
  gateway_response: Json | null;
  id: string;
  idempotency_key: string | null;
  payment_url: string | null;
  provider_invoice_id: string | null;
  provider_payment_id: string | null;
  request_payload: Json | null;
  requested_invoice_ids: string[];
  resulting_payment_id: string | null;
  /** `superseded` (migration 223): its link was replaced by a newer request's. */
  status: "pending" | "completed" | "failed" | "expired" | "cancelled" | "superseded";
  tenant_id: string;
  updated_at: string;
};

export type WebhookEventRow = {
  company_id: string;
  error: string | null;
  event_type: string | null;
  gateway: GatewayProvider;
  id: string;
  processed: boolean;
  provider_event_id: string | null;
  provider_payment_id: string | null;
  raw_payload: Json | null;
  received_at: string;
  result: string | null;
  signature_valid: boolean;
};

/**
 * حدث تسليم بريد وارد من Resend (ترحيل 156).
 *
 * Separate from `WebhookEventRow`, whose `gateway` enum holds payment providers
 * only. `provider_event_id` is the `svix-id` header, which Svix keeps stable
 * across retries and is therefore the replay key.
 */
export type EmailWebhookEventRow = {
  company_id: string;
  error: string | null;
  event_type: string | null;
  id: string;
  notification_id: string | null;
  processed: boolean;
  provider: NotificationProvider;
  provider_event_id: string | null;
  provider_message_id: string | null;
  raw_payload: Json | null;
  received_at: string;
  result: string | null;
  signature_valid: boolean;
};

/**
 * أرشيف نسخة احتياطية واحدة مخزَّن في حاوية `backups` (ترحيل 146).
 *
 * `period_key` is set only for `automatic` archives — `d:YYYY-MM-DD` or
 * `w:YYYY-Www` in Kuwait time — and a partial unique index on
 * `(kind, period_key)` is what makes the nightly job idempotent when two ticks
 * race. `storage_path` carries a uuid rather than the timestamped `file_name`,
 * which would collide for two runs starting in the same minute.
 */
export type BackupRow = {
  company_id: string;
  id: string;
  file_name: string;
  storage_path: string;
  sha256: string;
  size_bytes: number;
  table_count: number;
  row_count: number;
  kind: "manual" | "automatic" | "pre_restore";
  period_key: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

export type NotificationTemplateRow = {
  company_id: string;
  allow_freeform: boolean;
  body_ar: string | null;
  body_en: string | null;
  channel: NotificationChannel;
  code: string;
  created_at: string;
  id: string;
  is_active: boolean;
  provider_language_code: string | null;
  provider_param_keys: string[];
  provider_template_name: string | null;
  subject_ar: string | null;
  subject_en: string | null;
  twilio_content_sid: string | null;
  twilio_variable_keys: string[];
  type: NotificationType;
  updated_at: string;
};

export type ProviderConfigRow = {
  company_id: string;
  config: Json;
  created_at: string;
  from_email: string | null;
  from_whatsapp: string | null;
  id: string;
  is_enabled: boolean;
  /** The default email provider (migration 225); the other enabled email row is the fallback. */
  is_primary: boolean;
  provider: NotificationProvider;
  updated_at: string;
};

export type NotificationRow = {
  company_id: string;
  audience: NotificationAudience;
  body: string | null;
  channel: NotificationChannel;
  contract_id: string | null;
  created_at: string;
  delivery_key: string | null;
  error_code: string | null;
  failure_reason: string | null;
  id: string;
  invoice_id: string | null;
  locale: LocaleCode;
  payload: Json;
  provider: NotificationProvider | null;
  provider_message_id: string | null;
  recipient_address: string | null;
  report_schedule_id: string | null;
  retry_count: number;
  scheduled_at: string | null;
  sender_address: string | null;
  sent_at: string | null;
  state: NotificationState;
  subject: string | null;
  template_code: string | null;
  tenant_id: string | null;
  type: NotificationType;
  updated_at: string;
};

export type ReportScheduleRow = {
  company_id: string;
  code: string;
  created_at: string;
  frequency: ReportFrequency;
  id: string;
  is_active: boolean;
  last_run_at: string | null;
  locale: LocaleCode;
  name_ar: string;
  name_en: string | null;
  next_run_at: string | null;
  recipients: Json;
  report_kind: ReportKind;
  updated_at: string;
};

export type ExpenseCategoryRow = {
  company_id: string;
  code: string;
  created_at: string;
  id: string;
  is_active: boolean;
  is_system: boolean;
  name_ar: string;
  name_en: string | null;
  sort_order: number;
};

export type ExpenseRow = {
  amount: number;
  attachment_path: string | null;
  building_id: string | null;
  category_id: string | null;
  class: ExpenseClass;
  code: string;
  company_id: string | null;
  cost_center: string | null;
  created_at: string;
  created_by: string | null;
  currency: string;
  end_date: string | null;
  expense_date: string;
  id: string;
  note: string | null;
  payee: string | null;
  property_id: string | null;
  recurrence: "monthly" | "quarterly" | "annual" | "one_time" | null;
  start_date: string | null;
  status: "pending" | "approved" | "cancelled";
  unit_id: string | null;
  updated_at: string;
};

export type DepositRow = {
  amount: number;
  attachment_path: string | null;
  bank_name: string;
  code: string;
  company_id: string | null;
  /** Migration 152. Null together with `invoice_id` — an unreconciled deposit
   *  is a normal state, so the link is optional. */
  contract_id: string | null;
  created_at: string;
  created_by: string | null;
  currency: string;
  deposit_date: string;
  /** Instrument: cheque or cash. Copied onto the settlement payment's `method`
   *  by tg_deposits_sync_invoice; no longer ledger-only. */
  deposit_type: "cheque" | "cash";
  id: string;
  /** Migration 152. The one invoice this deposit settles while `status` is
   *  'confirmed'. Paired with `contract_id` by a check constraint. */
  invoice_id: string | null;
  note: string | null;
  status: "pending" | "confirmed" | "cancelled";
  updated_at: string;
};

export type ElectricityTariffRow = {
  company_id: string;
  code: string;
  created_at: string;
  currency: string;
  id: string;
  is_active: boolean;
  name_ar: string;
  name_en: string | null;
  tiers: Json | null;
  type: TariffType;
  unit_price: number;
  updated_at: string;
};

export type ElectricityMeterRow = {
  company_id: string;
  created_at: string;
  id: string;
  installed_at: string | null;
  is_active: boolean;
  meter_number: string | null;
  notes: string | null;
  ownership: ElectricityMeterOwnership;
  tariff_id: string | null;
  unit_id: string;
  updated_at: string;
};

export type MeterReadingRow = {
  company_id: string;
  consumption_kwh: number;
  created_at: string;
  id: string;
  meter_id: string;
  note: string | null;
  period_month: number;
  period_year: number;
  previous_reading: number | null;
  read_by: string | null;
  reading: number;
  reading_date: string;
};

export type ElectricityChargeRow = {
  company_id: string;
  amount: number;
  code: string;
  consumption_kwh: number;
  created_at: string;
  currency: string;
  id: string;
  meter_id: string;
  notes: string | null;
  period_month: number;
  period_year: number;
  reading_id: string | null;
  status: ElectricityChargeStatus;
  tenant_id: string | null;
  unit_id: string;
  updated_at: string;
};

export type GeneratedReportRow = {
  company_id: string;
  created_at: string;
  html_content: string | null;
  id: string;
  locale: LocaleCode | null;
  period_end: string | null;
  period_start: string | null;
  schedule_id: string | null;
  sent: boolean;
  sent_at: string | null;
  storage_path: string | null;
};

export type LandingMediaRow = {
  company_id: string;
  id: string;
  storage_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  alt_ar: string | null;
  alt_en: string | null;
  caption_ar: string | null;
  caption_en: string | null;
  focal_x: number;
  focal_y: number;
  category:
    | "exterior"
    | "interior"
    | "shops"
    | "facilities"
    | "events"
    | "parking"
    | "logo"
    | "tenant_avatar"
    | "gallery";
  /** When true (and is_active), appears on the public landing gallery. */
  show_in_gallery: boolean;
  is_active: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
};

export type LandingPageSettingsRow = {
  id: string;
  company_id: string;
  locale: "ar" | "en";
  hero_title: string;
  hero_subtitle: string;
  hero_primary_cta_label: string | null;
  hero_primary_cta_target: string | null;
  hero_secondary_cta_label: string | null;
  hero_secondary_cta_target: string | null;
  hero_desktop_media_id: string | null;
  hero_mobile_media_id: string | null;
  hero_video_media_id: string | null;
  about_title: string;
  about_body: string;
  about_primary_media_id: string | null;
  about_secondary_media_id: string | null;
  leasing_title: string;
  leasing_body: string;
  is_published: boolean;
  published_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type LandingPageSectionsRow = {
  id: string;
  company_id: string;
  section_key: string;
  enabled: boolean;
  display_order: number;
  theme: "dark" | "light" | "glass" | null;
  settings_json: Json;
  created_at: string;
  updated_at: string;
};

export type CommercialBrandRow = {
  company_id: string;
  id: string;
  property_id: string;
  unit_id: string | null;
  name_original: string;
  name_ar: string;
  name_en: string;
  slug: string;
  description_ar: string | null;
  description_en: string | null;
  category_id: string | null;
  logo_media_id: string | null;
  cover_media_id: string | null;
  phone: string | null;
  website_url: string | null;
  instagram_url: string | null;
  opening_hours_json: Json;
  is_featured: boolean;
  is_active: boolean;
  show_in_brands_marquee: boolean;
  show_in_shop_explorer: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
};

export type LandingCarouselSlideRow = {
  id: string;
  company_id: string;
  carousel_key: string;
  media_id: string;
  mobile_media_id: string | null;
  title_ar: string;
  title_en: string;
  description_ar: string | null;
  description_en: string | null;
  cta_label_ar: string | null;
  cta_label_en: string | null;
  cta_url: string | null;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ContactInquiryRow = {
  company_id: string;
  id: string;
  name: string;
  phone: string | null;
  email: string;
  subject: string | null;
  message: string;
  /** 'new' | 'read' | 'archived' (migration 64). Mirrors tenant_messages.status
   *  so the header bell treats both sources identically. */
  status: string;
  created_at: string;
};

export type GmailMessageRow = {
  id: string;
  company_id: string;
  /** NOT NULL in the DB — the worker substitutes `gmail:<id>` when a message
   *  carries no RFC 822 Message-ID header, so the unique key always holds. */
  message_id: string;
  thread_id: string | null;
  /**
   * Migrations 206 + 208 — Gmail's own message id, GENERATED from
   * `raw_payload`, and only for rows that carry a full `format=full` payload.
   *
   * Read-only by construction: Postgres rejects an INSERT that names a
   * generated column, so it is deliberately absent from this table's
   * `RequiredInsert` list and must never be written by hand. The sync job diffs
   * the ids the list endpoint returns against this column so it fetches only
   * messages whose full body it does not yet hold; `message_id` cannot serve,
   * because it holds the RFC 822 header instead.
   *
   * NULL for rows that did not come from Gmail, and for the thin placeholder
   * rows `gmailSend` writes when a message leaves the app — those carry an id
   * but no MIME tree, and the sync must still fetch their real payload.
   */
  gmail_id: string | null;
  from_address: string;
  to_address: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  received_at: string;
  is_read: boolean;
  /**
   * Migration 100 — 'received' | 'sent'. Nullable on purpose: mid-deploy inserts
   * from older code leave it null, and the list path treats null as received.
   * Classified SENT-wins from raw_payload.labelIds on sync; set explicitly on
   * local rows written by gmailSend.
   */
  direction: string | null;
  /** App-local category (migration 62). Free text whose vocabulary lives in the
   *  `gmail_categories` option list, not a foreign key — a category deleted from
   *  the catalogue leaves a stale chip rather than failing the delete. */
  category: string | null;
  /**
   * Migration 138 — X-Failed-Recipients copied at sync so the inbox list
   * can flag a DSN without selecting raw_payload.
   */
  failed_recipients: string | null;
  /**
   * Migration 158 — 'gmail' | 'resend'. Provenance, not preference: a database
   * trigger rejects any change after insert, because staff hold an unrestricted
   * row UPDATE on this table and a badge that can be edited is a badge that
   * lies. NOT NULL with a 'gmail' default, so every pre-158 row is correct.
   */
  provider: string;
  raw_payload: Json | null;
  created_at: string;
  updated_at: string;
};

/**
 * توقيع بريد إلكتروني لمستخدم إداري واحد (migration 123).
 *
 * `details` holds the structured fields the builder renders from; `content_html`
 * is the rendered result, stored rather than derived so a sent message and a
 * later preview cannot disagree. Editing reads `details` — parsing the HTML back
 * into fields returns wrong data as soon as the markup stops matching.
 */
export type EmailSignatureRow = {
  company_id: string;
  id: string;
  admin_id: string;
  name: string;
  content_html: string;
  details: Json;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type GmailConnectionRow = {
  id: string;
  company_id: string;
  email_address: string;
  /**
   * Long-lived Google credential. NOT in the `authenticated` column grant
   * (db/migrations/53_gmail_connections.sql) — only the service-role client can
   * read it. It is typed here because the server-side worker and the OAuth
   * callback do read it; never select it from a browser client.
   */
  refresh_token: string;
  scope: string | null;
  token_type: string | null;
  connected_by: string | null;
  connected_at: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Migration 179 — the paired Evolution API (WhatsApp QR) session, singleton row. */
export type EvolutionConnectionRow = {
  company_id: string;
  id: number;
  instance_name: string;
  /**
   * Webhook shared secrets and the QR payload. NOT in the `authenticated`
   * column grant (db/migrations/179_evolution_connections.sql) — only the
   * service-role client can read them; never select them from a browser client.
   */
  webhook_secret: string;
  previous_webhook_secret: string | null;
  connected_number: string | null;
  last_connection_state: string | null;
  last_qr: string | null;
  connected_at: string | null;
  /** Migration 253 — episode tracking columns, outside `authenticated` grant. */
  disconnect_alert_armed: boolean;
  disconnected_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Migration 180 — one WhatsApp message (inbound or outbound) in the inbox. */
export type WhatsappMessageRow = {
  company_id: string;
  id: string;
  message_id: string;
  chat_number: string;
  direction: "inbound" | "outbound";
  from_me: boolean;
  body: string | null;
  message_type: string;
  media_type: string | null;
  media_id: string | null;
  media_filename: string | null;
  sent_at: string;
  status: string;
  raw: Json | null;
  created_at: string;
};

/** Migration 180 — chat-list summary row, keyed by bare international digits. */
export type WhatsappChatRow = {
  company_id: string;
  chat_number: string;
  display_name: string | null;
  /** Migration 184 — WhatsApp CDN profile picture; expires, refreshed by Sync history. */
  avatar_url: string | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
};

/** Migration 186 — links a WhatsApp contact to one of a tenant's contracts. */
export type WhatsappContactContractRow = {
  company_id: string;
  contact_id: string;
  contract_id: string;
  created_at: string;
};

/** Migration 180 — saved WhatsApp contact, auto-captured or admin-entered. */
export type WhatsappContactRow = {
  company_id: string;
  id: string;
  phone: string;
  name: string | null;
  /** Migration 185 — the business/project name, distinct from the person's. */
  commercial_name: string | null;
  /** Migration 184 — WhatsApp CDN profile picture; expires, refreshed by Sync history. */
  avatar_url: string | null;
  email: string | null;
  notes: string | null;
  tags: string[];
  tenant_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TenantMessageRow = {
  company_id: string;
  id: string;
  tenant_id: string;
  sender_profile_id: string | null;
  subject: string | null;
  body: string;
  attachment_path: string | null;
  status: "new" | "read" | "archived";
  created_at: string;
};

export type InvoiceYearRow = {
  company_id: string;
  year: number;
  created_at: string;
  created_by: string | null;
};

export type LeasingInquiryRow = {
  id: string;
  company_id: string;
  name: string;
  company_name: string | null;
  business_activity: string | null;
  phone: string;
  email: string;
  preferred_size: string | null;
  preferred_contact_method: string | null;
  message: string | null;
  locale: "ar" | "en";
  status: "new" | "contacted" | "accepted" | "rejected";
  source: string | null;
  created_at: string;
  updated_at: string;
};

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: {
          address_ar: string | null;
          address_en: string | null;
          announcement_ar: string | null;
          announcement_en: string | null;
          announcement_enabled: boolean;
          backup_daily_enabled: boolean;
          backup_weekly_enabled: boolean;
          /** Migration 242 — null keeps everything; change via `set_log_retention`. */
          audit_log_retention_days: number | null;
          notification_log_retention_days: number | null;
          bank_logo_url: string | null;
          bank_name: string | null;
          brand_accent: string | null;
          brand_primary: string | null;
          created_at: string;
          currency: string;
          default_locale: LocaleCode;
          email: string | null;
          facebook_url: string | null;
          iban: string | null;
          id: string;
          instagram_url: string | null;
          favicon_url: string | null;
          invoice_footer_ar: string | null;
          invoice_footer_en: string | null;
          logo_url: string | null;
          email_logo_url: string | null;
          map_url: string | null;
          max_visible_unpaid_invoices: number;
          name_ar: string;
          name_en: string;
          phone: string | null;
          phone_country_code: string;
          portal_apple_pay_enabled: boolean;
          portal_bg_url: string | null;
          portal_google_pay_enabled: boolean;
          slug: string;
          status: CompanyStatus;
          suspended_at: string | null;
          suspended_by: string | null;
          suspended_reason: string | null;
          timezone: string;
          updated_at: string;
          whatsapp: string | null;
        };
        Insert: {
          address_ar?: string | null;
          address_en?: string | null;
          announcement_ar?: string | null;
          announcement_en?: string | null;
          announcement_enabled?: boolean;
          backup_daily_enabled?: boolean;
          backup_weekly_enabled?: boolean;
          audit_log_retention_days?: number | null;
          notification_log_retention_days?: number | null;
          bank_logo_url?: string | null;
          bank_name?: string | null;
          brand_accent?: string | null;
          brand_primary?: string | null;
          created_at?: string;
          currency?: string;
          default_locale?: LocaleCode;
          email?: string | null;
          facebook_url?: string | null;
          iban?: string | null;
          id?: string;
          instagram_url?: string | null;
          favicon_url?: string | null;
          invoice_footer_ar?: string | null;
          invoice_footer_en?: string | null;
          logo_url?: string | null;
          email_logo_url?: string | null;
          map_url?: string | null;
          max_visible_unpaid_invoices?: number;
          name_ar: string;
          name_en: string;
          phone?: string | null;
          phone_country_code?: string;
          portal_apple_pay_enabled?: boolean;
          portal_bg_url?: string | null;
          portal_google_pay_enabled?: boolean;
          slug?: string;
          status?: CompanyStatus;
          suspended_at?: string | null;
          suspended_by?: string | null;
          suspended_reason?: string | null;
          timezone?: string;
          updated_at?: string;
          whatsapp?: string | null;
        };
        Update: {
          address_ar?: string | null;
          address_en?: string | null;
          announcement_ar?: string | null;
          announcement_en?: string | null;
          announcement_enabled?: boolean;
          backup_daily_enabled?: boolean;
          backup_weekly_enabled?: boolean;
          audit_log_retention_days?: number | null;
          notification_log_retention_days?: number | null;
          bank_logo_url?: string | null;
          bank_name?: string | null;
          brand_accent?: string | null;
          brand_primary?: string | null;
          created_at?: string;
          currency?: string;
          default_locale?: LocaleCode;
          email?: string | null;
          facebook_url?: string | null;
          iban?: string | null;
          id?: string;
          instagram_url?: string | null;
          favicon_url?: string | null;
          invoice_footer_ar?: string | null;
          invoice_footer_en?: string | null;
          logo_url?: string | null;
          email_logo_url?: string | null;
          map_url?: string | null;
          max_visible_unpaid_invoices?: number;
          name_ar?: string;
          name_en?: string;
          phone?: string | null;
          phone_country_code?: string;
          portal_apple_pay_enabled?: boolean;
          portal_bg_url?: string | null;
          portal_google_pay_enabled?: boolean;
          slug?: string;
          status?: CompanyStatus;
          suspended_at?: string | null;
          suspended_by?: string | null;
          suspended_reason?: string | null;
          timezone?: string;
          updated_at?: string;
          whatsapp?: string | null;
        };
        Relationships: [];
      };
      company_domains: TableDefinition<CompanyDomainRow, "company_id" | "host" | "kind">;
      reserved_slugs: TableDefinition<ReservedSlugRow, "slug">;
      company_counters: TableDefinition<CompanyCounterRow, "company_id" | "kind">;
      profiles: {
        Row: {
          company_id: string | null;
          created_at: string;
          display_name: string | null;
          email: string | null;
          id: string;
          is_active: boolean;
          phone: string | null;
          preferred_locale: LocaleCode;
          tenant_id: string | null;
          updated_at: string;
          username: string | null;
        };
        Insert: {
          company_id?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id: string;
          is_active?: boolean;
          phone?: string | null;
          preferred_locale?: LocaleCode;
          tenant_id?: string | null;
          updated_at?: string;
          username?: string | null;
        };
        Update: {
          company_id?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id?: string;
          is_active?: boolean;
          phone?: string | null;
          preferred_locale?: LocaleCode;
          tenant_id?: string | null;
          updated_at?: string;
          username?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          company_id: string;
          created_at: string;
          granted_by: string | null;
          id: string;
          role: AppRole;
          user_id: string;
        };
        Insert: {
          company_id?: string;
          created_at?: string;
          granted_by?: string | null;
          id?: string;
          role: AppRole;
          user_id: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          granted_by?: string | null;
          id?: string;
          role?: AppRole;
          user_id?: string;
        };
        Relationships: [];
      };
      /** Migration 306 — صندوق المهام الخلفية؛ يضيفه `company_service` ودوال SQL، ويحدّث العامل (`service_role`) حالته. */
      job_requests: {
        Row: {
          attempts: number;
          company_id: string;
          created_at: string;
          dedupe_key: string | null;
          finished_at: string | null;
          id: string;
          kind: string;
          last_error: string | null;
          payload: Json;
          published_at: string | null;
          requested_by: string | null;
          result: Json | null;
          status: "pending" | "published" | "running" | "succeeded" | "failed" | "skipped";
        };
        Insert: {
          attempts?: number;
          company_id: string;
          created_at?: string;
          dedupe_key?: string | null;
          finished_at?: string | null;
          id?: string;
          kind: string;
          last_error?: string | null;
          payload?: Json;
          published_at?: string | null;
          requested_by?: string | null;
          result?: Json | null;
          status?: "pending" | "published" | "running" | "succeeded" | "failed" | "skipped";
        };
        Update: {
          attempts?: number;
          company_id?: string;
          created_at?: string;
          dedupe_key?: string | null;
          finished_at?: string | null;
          id?: string;
          kind?: string;
          last_error?: string | null;
          payload?: Json;
          published_at?: string | null;
          requested_by?: string | null;
          result?: Json | null;
          status?: "pending" | "published" | "running" | "succeeded" | "failed" | "skipped";
        };
        Relationships: [];
      };
      /** Migration 306 — إشعارات داخل التطبيق لنتيجة مهمة خلفية؛ المستخدم يقرأ إشعاراته ويعلّمها مقروءة فقط. */
      user_notices: {
        Row: {
          body: Json;
          company_id: string;
          created_at: string;
          id: string;
          job_request_id: string | null;
          kind: string;
          level: "success" | "error";
          read_at: string | null;
          title_key: string;
          user_id: string;
        };
        Insert: {
          body?: Json;
          company_id: string;
          created_at?: string;
          id?: string;
          job_request_id?: string | null;
          kind: string;
          level: "success" | "error";
          read_at?: string | null;
          title_key: string;
          user_id: string;
        };
        Update: {
          body?: Json;
          company_id?: string;
          created_at?: string;
          id?: string;
          job_request_id?: string | null;
          kind?: string;
          level?: "success" | "error";
          read_at?: string | null;
          title_key?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      permissions: {
        Row: {
          action: string;
          code: string;
          created_at: string;
          description_ar: string | null;
          description_en: string | null;
          id: string;
          is_system: boolean;
          module: string;
        };
        Insert: {
          action: string;
          code: string;
          created_at?: string;
          description_ar?: string | null;
          description_en?: string | null;
          id?: string;
          is_system?: boolean;
          module: string;
        };
        Update: {
          action?: string;
          code?: string;
          created_at?: string;
          description_ar?: string | null;
          description_en?: string | null;
          id?: string;
          is_system?: boolean;
          module?: string;
        };
        Relationships: [];
      };
      role_permissions: {
        Row: {
          company_id: string;
          created_at: string;
          id: string;
          permission_code: string;
          role: AppRole;
        };
        Insert: {
          company_id?: string;
          created_at?: string;
          id?: string;
          permission_code: string;
          role: AppRole;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          id?: string;
          permission_code?: string;
          role?: AppRole;
        };
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_code_fkey";
            columns: ["permission_code"];
            isOneToOne: false;
            referencedRelation: "permissions";
            referencedColumns: ["code"];
          },
        ];
      };
      custom_roles: {
        Row: {
          company_id: string;
          code: string;
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          is_active: boolean;
          name_ar: string;
          name_en: string;
          updated_at: string;
        };
        Insert: {
          company_id?: string;
          code: string;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          name_ar: string;
          name_en: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          code?: string;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          name_ar?: string;
          name_en?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      custom_role_permissions: {
        Row: {
          company_id: string;
          created_at: string;
          custom_role_id: string;
          id: string;
          permission_code: string;
        };
        Insert: {
          company_id?: string;
          created_at?: string;
          custom_role_id: string;
          id?: string;
          permission_code: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          custom_role_id?: string;
          id?: string;
          permission_code?: string;
        };
        Relationships: [
          {
            foreignKeyName: "custom_role_permissions_custom_role_id_fkey";
            columns: ["custom_role_id"];
            isOneToOne: false;
            referencedRelation: "custom_roles";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_logs: {
        Row: {
          company_id: string;
          action: string;
          actor_id: string | null;
          actor_label: string | null;
          after: Json | null;
          before: Json | null;
          correlation_id: string | null;
          created_at: string;
          entity_id: string | null;
          entity_type: string | null;
          error_code: string | null;
          id: string;
          ip: string | null;
          method: string | null;
          path: string | null;
          result: AuditResult;
          role: string | null;
          user_agent: string | null;
        };
        Insert: {
          company_id?: string;
          action: string;
          actor_id?: string | null;
          actor_label?: string | null;
          after?: Json | null;
          before?: Json | null;
          correlation_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string | null;
          error_code?: string | null;
          id?: string;
          ip?: string | null;
          method?: string | null;
          path?: string | null;
          result?: AuditResult;
          role?: string | null;
          user_agent?: string | null;
        };
        Update: {
          company_id?: string;
          action?: string;
          actor_id?: string | null;
          actor_label?: string | null;
          after?: Json | null;
          before?: Json | null;
          correlation_id?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string | null;
          error_code?: string | null;
          id?: string;
          ip?: string | null;
          method?: string | null;
          path?: string | null;
          result?: AuditResult;
          role?: string | null;
          user_agent?: string | null;
        };
        Relationships: [];
      };
      card_visibility: TableDefinition<CardVisibilityRow, "company_id" | "card_id">;
      building_categories: TableDefinition<BuildingCategoryRow, "code" | "name_ar" | "name_en">;
      option_lists: TableDefinition<OptionListRow, "code" | "name_ar" | "name_en">;
      option_list_items: TableDefinition<
        OptionListItemRow,
        "list_id" | "value" | "label_ar" | "label_en"
      >;
      properties: TableDefinition<PropertyRow, "name_ar">;
      buildings: TableDefinition<BuildingRow, "property_id" | "name_ar">;
      units: TableDefinition<UnitRow, "property_id" | "name">;
      maintenance_requests: TableDefinition<
        MaintenanceRequestRow,
        "company_id" | "property_id" | "title"
      >;
      tenants: TableDefinition<TenantRow, "name">;
      tenant_documents: TableDefinition<TenantDocumentRow, "tenant_id" | "type" | "storage_path">;
      contracts: TableDefinition<ContractRow, "tenant_id" | "start_date" | "end_date">;
      contract_units: TableDefinition<
        ContractUnitRow,
        "contract_id" | "unit_id" | "monthly_amount"
      >;
      contract_extra_charges: TableDefinition<
        ContractExtraChargeRow,
        "contract_id" | "category_id" | "amount"
      >;
      commercial_brand_contracts: TableDefinition<
        CommercialBrandContractRow,
        "brand_id" | "contract_id"
      >;
      concessions: TableDefinition<
        ConcessionRow,
        "contract_id" | "type" | "start_date" | "end_date"
      >;
      concession_invoices: TableDefinition<ConcessionInvoiceRow, "concession_id" | "invoice_id">;
      invoices: TableDefinition<
        InvoiceRow,
        | "contract_id"
        | "tenant_id"
        | "unit_id"
        | "period_year"
        | "period_month"
        | "issue_date"
        | "due_date"
        | "idempotency_key"
      >;
      invoice_items: TableDefinition<InvoiceItemRow, "invoice_id" | "line">;
      payments: TableDefinition<PaymentRow, "tenant_id" | "method" | "amount" | "payment_date">;
      payment_allocations: TableDefinition<
        PaymentAllocationRow,
        "payment_id" | "invoice_id" | "amount"
      >;
      receipts: TableDefinition<ReceiptRow, "payment_id" | "tenant_id" | "amount">;
      payment_requests: TableDefinition<
        PaymentRequestRow,
        "tenant_id" | "amount" | "requested_invoice_ids"
      >;
      webhook_events: TableDefinition<WebhookEventRow, "gateway">;
      email_webhook_events: TableDefinition<EmailWebhookEventRow, "provider">;
      backups: TableDefinition<
        BackupRow,
        | "file_name"
        | "storage_path"
        | "sha256"
        | "size_bytes"
        | "table_count"
        | "row_count"
        | "kind"
      >;
      notification_templates: TableDefinition<NotificationTemplateRow, "code" | "type" | "channel">;
      provider_configs: TableDefinition<ProviderConfigRow, "provider">;
      notifications: TableDefinition<NotificationRow, "type" | "channel">;
      expense_categories: TableDefinition<ExpenseCategoryRow, "code" | "name_ar">;
      expenses: TableDefinition<ExpenseRow, "amount" | "expense_date">;
      refunds: TableDefinition<RefundRow, "tenant_id" | "amount">;
      contract_closeouts: TableDefinition<
        ContractCloseoutRow,
        | "contract_id"
        | "tenant_id"
        | "outcome"
        | "final_contract_state"
        | "move_out_date"
        | "idempotency_key"
      >;
      contract_closeout_deductions: TableDefinition<
        ContractCloseoutDeductionRow,
        "closeout_id" | "line" | "kind" | "amount"
      >;
      contract_closeout_invoice_actions: TableDefinition<
        ContractCloseoutInvoiceActionRow,
        "closeout_id" | "invoice_id" | "action"
      >;
      contract_operational_events: TableDefinition<
        ContractOperationalEventRow,
        "contract_id" | "event_type"
      >;
      employees: TableDefinition<EmployeeRow, "name">;
      cron_jobs: TableDefinition<CronJobRow, "key" | "name_ar" | "name_en">;
      employee_documents: TableDefinition<EmployeeDocumentRow, "employee_id" | "storage_path">;
      salaries: TableDefinition<SalaryRow, "employee_id" | "year" | "month" | "amount">;
      partial_payments: TableDefinition<PartialPaymentRow, "tenant_id" | "amount">;
      insurance_payments: TableDefinition<
        InsurancePaymentRow,
        "tenant_id" | "contract_id" | "amount"
      >;
      deposits: TableDefinition<DepositRow, "deposit_date" | "bank_name" | "amount">;
      electricity_tariffs: TableDefinition<ElectricityTariffRow, "code" | "name_ar">;
      electricity_meters: TableDefinition<ElectricityMeterRow, "unit_id">;
      meter_readings: TableDefinition<
        MeterReadingRow,
        "meter_id" | "reading" | "reading_date" | "period_year" | "period_month"
      >;
      electricity_charges: TableDefinition<
        ElectricityChargeRow,
        "meter_id" | "unit_id" | "period_year" | "period_month"
      >;
      report_schedules: TableDefinition<
        ReportScheduleRow,
        "code" | "name_ar" | "frequency" | "recipients"
      >;
      generated_reports: TableDefinition<GeneratedReportRow>;
      landing_media: TableDefinition<LandingMediaRow, "storage_path" | "mime_type" | "category">;
      landing_page_settings: TableDefinition<
        LandingPageSettingsRow,
        | "company_id"
        | "locale"
        | "hero_title"
        | "hero_subtitle"
        | "about_title"
        | "about_body"
        | "leasing_title"
        | "leasing_body"
      >;
      landing_page_sections: TableDefinition<LandingPageSectionsRow, "company_id" | "section_key">;
      commercial_brands: TableDefinition<
        CommercialBrandRow,
        "property_id" | "name_original" | "name_ar" | "name_en" | "slug"
      >;
      landing_carousel_slides: TableDefinition<
        LandingCarouselSlideRow,
        "company_id" | "media_id" | "title_ar" | "title_en"
      >;
      leasing_inquiries: TableDefinition<
        LeasingInquiryRow,
        "company_id" | "name" | "phone" | "email"
      >;
      tenant_messages: TableDefinition<TenantMessageRow, "tenant_id" | "body">;
      invoice_years: TableDefinition<InvoiceYearRow, "year">;
      contact_inquiries: TableDefinition<ContactInquiryRow, "name" | "email" | "message">;
      gmail_messages: TableDefinition<
        GmailMessageRow,
        "company_id" | "from_address" | "received_at" | "message_id"
      >;
      gmail_connections: TableDefinition<
        GmailConnectionRow,
        "company_id" | "email_address" | "refresh_token"
      >;
      email_signatures: TableDefinition<EmailSignatureRow, "admin_id" | "name">;
      evolution_connections: TableDefinition<EvolutionConnectionRow, "webhook_secret">;
      whatsapp_messages: TableDefinition<
        WhatsappMessageRow,
        "message_id" | "chat_number" | "direction"
      >;
      whatsapp_chats: TableDefinition<WhatsappChatRow, "chat_number">;
      whatsapp_contacts: TableDefinition<WhatsappContactRow, "phone">;
      whatsapp_contact_contracts: TableDefinition<
        WhatsappContactContractRow,
        "contact_id" | "contract_id"
      >;
    };
    Views: { [_ in never]: never };
    Functions: {
      /** Migration 254 — معرّف الشركة النشطة للمستدعي الحالي أو null عند عدم التحقق أو الإيقاف. */
      current_company_id: {
        Args: Record<PropertyKey, never>;
        Returns: string | null;
      };
      current_company_id_strict: {
        Args: Record<PropertyKey, never>;
        Returns: string | null;
      };
      /** Migration 254 — دالة مبدئية للتحقق من مشرف المنصة (تُستبدل لاحقاً في ترحيل 289). */
      is_platform_admin: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      /** Migration 284 — يرفع عدّاد نوع مستند معيّن للشركة الحالية ذرياً ويعيد القيمة التالية. */
      next_company_counter: {
        Args: { p_kind: string };
        Returns: number;
      };
      /** Migration 306 — يسجّل طلب مهمة خلفية للشركة الحالية ويعيد معرّفه (أو الموجود عند تكرار مفتاح منع التكرار).
       *  Execute granted to `company_service` only; `_requested_by` is honoured only for that role. */
      enqueue_job: {
        Args: {
          _kind: string;
          _payload?: Json;
          _dedupe_key?: string | null;
          _requested_by?: string | null;
        };
        Returns: string;
      };
      /** Migration 307 — يحجز حتى `_limit` صفاً من `job_requests` للنشر في BullMQ ويعيد (المعرّف، الشركة، النوع).
       *  Execute granted to `service_role` only; the worker's relay is the only caller. */
      relay_claim_jobs: {
        Args: { _limit?: number };
        Returns: { id: string; company_id: string; kind: string }[];
      };
      /** Migration 308 — يسجّل طلب مهمة خلفية لشركة معيّنة (شركة الصف الذي غيّرته دالة المال).
       *  Execute granted to `service_role` only; the money functions own it. */
      enqueue_job_for_company: {
        Args: {
          _company_id: string;
          _kind: string;
          _payload?: Json;
          _dedupe_key?: string | null;
        };
        Returns: string;
      };
      /** Migration 180 — transactional, idempotent WhatsApp inbox ingestion.
       *  Service-role only; `authenticated` and `anon` have EXECUTE revoked. */
      ingest_whatsapp_messages: {
        Args: { p_rows: Json };
        Returns: number;
      };
      /** Migration 253 — non-sensitive WhatsApp QR session health for all staff. */
      whatsapp_session_health: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      backup_table_names: {
        Args: Record<PropertyKey, never>;
        Returns: { backup_table_names: string }[];
      };
      backup_schema_fingerprint: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      backup_dump_all: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      backup_restore: {
        Args: { _payload: Json; _actor: string };
        Returns: Json;
      };
      /**
       * Migration 123 — switches the default signature in one transaction.
       *
       * Clearing the old default and setting the new one from the client is two
       * round trips with no transaction: a failure between them leaves the admin
       * with no default, and two tabs can both clear then race into the unique
       * partial index.
       */
      set_default_email_signature: {
        Args: { _signature_id: string };
        Returns: undefined;
      };
      compute_electricity_amount: {
        Args: { p_consumption: number; p_tariff_id: string };
        Returns: number;
      };
      /**
       * Migration 150 — deletes a contract's insurance holding and writes its
       * audit row in one transaction.
       *
       * Two browser round-trips would let the audit fail after the row is gone,
       * leaving an untraceable deletion while reporting an error for an
       * operation that succeeded. Returns false when the contract held nothing,
       * which is not a failure.
       */
      delete_contract_insurance: {
        Args: { p_contract_id: string };
        Returns: boolean;
      };
      /** Migration 66 — guards the mobile-number fields on the user forms.
       *  Service-role only; `authenticated` and `anon` have EXECUTE revoked. */
      find_phone_conflicts: {
        Args: { _digits: string; _exclude_profile: string | null; _exclude_tenant: string | null };
        Returns: { kind: string; id: string; label: string | null }[];
      };
      /** Migration 65 — powers signing in with a mobile number. Service-role
       *  only; `authenticated` and `anon` have EXECUTE revoked. */
      find_profiles_by_phone_digits: {
        Args: { _digits: string };
        Returns: { id: string; email: string | null }[];
      };
      generate_electricity_charges: {
        Args: {
          p_period_month: number;
          p_period_year: number;
          p_unit_id?: string | null;
        };
        Returns: {
          amount: number;
          charge_id: string;
          code: string;
          status: string;
          unit_id: string;
        }[];
      };
      bulk_import_phase6: {
        Args: { p_created_by?: string | null; p_entity: string; p_rows: Json };
        Returns: number;
      };
      /** Migration 229 — service_role only; true when this caller won the run. */
      /** Migration 242 — distinct values for the /admin/audit filters (RLS applies). */
      audit_log_filter_options: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** Migration 242 — service_role only; the daily log-retention job. */
      purge_expired_logs: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** Migration 242 — save a retention window and delete older rows now. */
      set_log_retention: {
        Args: { p_log: string; p_days: number | null };
        Returns: Json;
      };
      /** Migration 244 — first active brand's logo/cover per contract (RLS applies). */
      contract_brand_assets: {
        Args: { p_contract_ids: string[] };
        Returns: { contract_id: string; logo_path: string | null; cover_path: string | null }[];
      };
      /** Migration 244 — every relation the contracts list shows, in one request. */
      contract_list_relations: {
        Args: { p_contract_ids: string[] };
        Returns: Json;
      };
      /** Migration 244 — every relation the tenants list shows, in one request. */
      tenant_list_relations: {
        Args: { p_tenant_ids: string[] };
        Returns: Json;
      };
      claim_cron_run: {
        Args: { p_key: string; p_window_seconds?: number };
        Returns: boolean;
      };
      /** Migrations 219/228 — all dashboard KPI figures in one jsonb payload.
       *  `security invoker` so RLS applies; `authenticated`-only execute. */
      get_dashboard_aggregates: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      get_deposit_total: {
        Args: {
          p_bank?: string | null;
          p_from?: string | null;
          p_search?: string | null;
          p_status?: string | null;
          p_to?: string | null;
        };
        Returns: number;
      };
      get_deposits_summary: {
        Args: {
          p_search?: string | null;
          p_bank?: string | null;
          p_status?: string | null;
          p_from?: string | null;
          p_to?: string | null;
        };
        Returns: Json;
      };
      get_budget_summary: {
        Args: {
          p_building_id?: string | null;
          p_from: string;
          p_property_id?: string | null;
          p_to: string;
        };
        Returns: Json;
      };
      get_payments_summary: {
        Args: {
          p_search?: string | null;
          p_method?: string | null;
          p_status?: string | null;
          p_tenant_id?: string | null;
        };
        Returns: Json;
      };
      get_expenses_summary: {
        Args: {
          p_search?: string | null;
          p_class?: string | null;
          p_category_id?: string | null;
          p_property_id?: string | null;
          p_status?: string | null;
          p_from?: string | null;
          p_to?: string | null;
        };
        Returns: Json;
      };
      get_contracts_summary: {
        Args: {
          p_search?: string | null;
          p_state?: string | null;
          p_tenant_id?: string | null;
          /** Migration 90 — 'current' | 'archived' | 'all'; default 'current'. */
          p_archive_mode?: string | null;
        };
        Returns: Json;
      };
      get_tenants_summary: {
        Args: {
          p_search?: string | null;
          p_category?: string | null;
          p_lifecycle?: string | null;
          /** Migration 90 — 'current' | 'archived' | 'all'; default 'current'. */
          p_archive_mode?: string | null;
        };
        Returns: Json;
      };
      // Migration 87 — atomic contract close-out engine. PostgREST resolves by
      // argument NAME; these keys must match the SQL parameter names exactly.
      close_out_contract: {
        Args: {
          p_contract_id: string;
          p_move_out_date: string;
          p_outcome: string;
          p_final_contract_state: string;
          p_archive_tenant: boolean;
          p_deductions: Json;
          p_invoice_actions: Json;
          p_refund_amount: number | null;
          p_note: string | null;
          p_idempotency_key: string;
          p_expected_contract_updated_at: string | null;
        };
        Returns: Json;
      };
      cancel_contract_closeout: {
        Args: { p_closeout_id: string; p_reason: string };
        Returns: Json;
      };
      restore_contract: {
        Args: {
          p_contract_id: string;
          p_target_state: string;
          p_restore_tenant: boolean;
          p_reason: string;
        };
        Returns: Json;
      };
      get_contract_closeout_preview: {
        Args: {
          p_contract_id: string;
          p_deductions: Json;
          p_invoice_actions: Json;
          p_refund_amount: number | null;
        };
        Returns: Json;
      };
      // Migration 85 — refund reverse (mirror) / void (no mirror).
      reverse_refund: {
        Args: { p_refund_id: string; p_reason: string };
        Returns: { reversal_refund_id: string }[];
      };
      void_refund: {
        Args: { p_refund_id: string; p_reason: string };
        Returns: undefined;
      };
      // Migration 86 — write-off (state=waived) and dispute flag.
      write_off_invoice: {
        Args: { p_invoice_id: string; p_reason: string };
        Returns: undefined;
      };
      set_invoice_dispute: {
        Args: { p_invoice_id: string; p_reason: string };
        Returns: undefined;
      };
      clear_invoice_dispute: {
        Args: { p_invoice_id: string };
        Returns: undefined;
      };
      get_units_summary: {
        Args: {
          p_search?: string | null;
          p_property_id?: string | null;
          p_building_id?: string | null;
          p_status?: string | null;
          p_type?: string | null;
          p_meter?: string | null;
        };
        Returns: Json;
      };
      has_permission: {
        Args: { _code: string; _user_id: string };
        Returns: boolean;
      };
      apply_payment_allocation: {
        Args: { p_allocations: Json; p_payment_id: string };
        Returns: { applied: number; invoice_id: string; new_state: string }[];
      };
      /** Migration 191 — locks the contract then updates the ledger row. */
      edit_partial_payment: {
        Args: {
          p_id: string;
          p_amount: number;
          p_paid_date: string;
          p_invoice_id: string | null;
          p_note: string | null;
          p_tenant_id: string | null;
          p_contract_id: string | null;
          p_unit_id: string | null;
          p_building_id: string | null;
          p_status: string | null;
        };
        Returns: Json;
      };
      /** Migration 192 — invoker rights; RLS applies. */
      get_partial_payment_edit_context: {
        Args: { p_id: string };
        Returns: Json;
      };
      /**
       * Migration 192 — invoice-anchored snapshot of confirmed allocations.
       * Returns null when the caller may not see the invoice.
       */
      get_invoice_payment_breakdown: {
        Args: { p_invoice_id: string };
        Returns: Json;
      };
      /**
       * Migration 202 — 12 month rows for a year, optionally pro-rated to one
       * property's rent lines. numeric/bigint columns arrive from PostgREST as
       * strings; `monthlyInvoiceSummaryQuery` maps them to numbers.
       */
      get_invoice_month_summary: {
        Args: { p_year: number; p_property_id?: string | null };
        Returns: Array<{
          month: number;
          count: number;
          total: number;
          paid: number;
          outstanding: number;
          overdue: number;
        }>;
      };
      get_property_monthly_rent_totals: {
        Args: { p_period_start?: string | null };
        Returns: Array<{ property_id: string; monthly_total: number }>;
      };
      evaluate_overdue: {
        Args: { p_as_of?: string | null };
        Returns: { invoice_id: string; new_state: string; old_state: string }[];
      };
      evaluate_portal_payable_invoices: {
        /**
         * Migration 210 — `p_include_hidden` is a request, not a grant: the
         * function downgrades it to false for a tenant caller, so only staff
         * (and `createPayment`, which settles a staff-generated link) ever see
         * an invoice belonging to a `hide_from_portal` contract.
         */
        Args: {
          p_tenant_id: string;
          p_contract_id?: string | null;
          p_include_hidden?: boolean | null;
        };
        Returns: {
          balance: number;
          invoice_id: string;
          is_overdue: boolean;
          is_selectable: boolean;
          lock_reason: string | null;
          paid: number;
          period_month: number;
          period_year: number;
          sequence_order: number;
          state: string;
          total: number;
        }[];
      };
      generate_invoices: {
        Args: { p_contract_id?: string | null; p_through_year?: number | null };
        Returns: {
          code: string;
          contract_id: string;
          id: string;
          period_month: number;
          period_year: number;
          state: string;
          total: number;
        }[];
      };
      backfill_contract_invoices: {
        Args: { p_contract_id: string };
        Returns: {
          code: string;
          contract_id: string;
          id: string;
          period_month: number;
          period_year: number;
          state: string;
          total: number;
        }[];
      };
      // Migration 55 — T15. Unlike reapply_contract_invoices (which deletes and
      // recreates, churning UUIDs that payment_requests.requested_invoice_ids
      // still points at) this reconciles in place. `action` is what lets the UI
      // report cancellations rather than a bare count.
      regenerate_contract_invoices: {
        Args: { p_contract_id: string };
        Returns: {
          id: string;
          code: string;
          period_year: number;
          period_month: number;
          total: number;
          state: string;
          action: string;
        }[];
      };
      // Migration 139 — the same reconciliation as regenerate_contract_invoices,
      // plus a fill pass that restores months a previous configuration removed
      // (reducing free months, above all). Bounded by
      // contracts.invoices_generated_through, so it can never widen a schedule
      // past what has already been generated.
      sync_contract_invoice_schedule: {
        Args: { p_contract_id: string };
        Returns: {
          id: string;
          code: string;
          period_year: number;
          period_month: number;
          total: number;
          state: string;
          action: string;
        }[];
      };
      // Migration 139 — furthest month the contract may be synced through.
      contract_invoice_horizon: {
        Args: { p_contract_id: string };
        Returns: string;
      };
      invoice_has_pending_request: {
        Args: { _invoice: string };
        Returns: boolean;
      };
      reapply_contract_invoices: {
        Args: { p_contract_id: string };
        Returns: {
          code: string;
          contract_id: string;
          id: string;
          period_month: number;
          period_year: number;
          state: string;
          total: number;
        }[];
      };
      // Migration 127 — bind a percentage/fixed concession to chosen invoices.
      apply_concession_to_invoices: {
        Args: { p_concession_id: string; p_invoice_ids: string[] };
        Returns: {
          code: string;
          discount: number;
          invoice_id: string;
          total: number;
        }[];
      };
      // Migration 54 — tenants.lifecycle is derived from contracts. The
      // recompute is exposed because unblocking must land on the *computed*
      // state, not on a hardcoded 'active'.
      // Migration 57 — monthly payroll. Idempotent on
      // unique (employee_id, year, month).
      record_cron_run: {
        Args: {
          _key: string;
          _status: string;
          _duration_ms?: number | null;
          _error?: string | null;
        };
        Returns: undefined;
      };
      generate_salaries_for_month: {
        Args: { p_year?: number | null; p_month?: number | null };
        Returns: SalaryRow[];
      };
      set_tenant_blocked: {
        Args: { _tenant: string; _blocked: boolean };
        Returns: TenantLifecycle;
      };
      sync_tenant_lifecycle_for: {
        Args: { _tenant: string };
        Returns: TenantLifecycle;
      };
      period_in_free_months: {
        Args: { p_contract_id: string; p_period_start: string };
        Returns: boolean;
      };
      // Migration 108 replaced the 2-argument signature outright (drop, not
      // create-or-replace) so PostgREST cannot resolve a caller to an overload
      // that silently discards the reason.
      set_invoice_paid: {
        Args: { p_invoice_id: string; p_manual_payment_reason?: string | null; p_paid: boolean };
        Returns: { invoice_state: string; payment_id: string | null }[];
      };
      // Migration 58 dropped `months_until`: the thresholds are eight mutually
      // exclusive DAY buckets now, and mixing month with day arithmetic is what
      // let the old `1m` and `7d` arms overlap.
      identify_contract_expiry_reminders: {
        Args: { p_as_of?: string | null };
        Returns: {
          contract_id: string;
          days_until: number | null;
          milestone: string;
          template_type: string;
          tenant_id: string;
        }[];
      };
      build_scheduled_report_html: {
        Args: { p_as_of?: string | null; p_schedule_id: string };
        Returns: { html: string; period_end: string; period_start: string }[];
      };
      /** Migration 241 — weekly overdue-by-contract report. */
      build_overdue_contracts_report_html: {
        Args: { p_as_of?: string | null; p_schedule_id: string };
        Returns: { html: string; period_end: string; period_start: string }[];
      };
      /** Migration 239 — rows per referencing column that hold this list value. */
      count_option_list_value_usage: {
        Args: { p_item_id: string };
        Returns: Json;
      };
      /** Migration 239 — atomic cascade rename of a list value. */
      rename_option_list_value: {
        Args: { p_item_id: string; p_new_value: string };
        Returns: Json;
      };
      has_role: {
        Args: { _role: AppRole; _user_id: string };
        Returns: boolean;
      };
      is_staff: {
        Args: { _user_id: string };
        Returns: boolean;
      };
      reverse_payment: {
        Args: { p_payment_id: string; p_reason: string };
        Returns: { reversal_payment_id: string }[];
      };
      /**
       * يسجّل محاولة دخول فاشلة ويُقرّر وحده ما يستحق الكتابة في سجل التدقيق.
       *
       * Migration 215. Counts per (identifier, client IP, quarter-hour window)
       * and calls `write_audit` for bounded identifier samples and exponential
       * IP-budget milestones after the identifier budget is exhausted. Granted to
       * `service_role` only, so it is not reachable from a browser client.
       * Returns the attempt count within the window.
       */
      record_failed_login: {
        Args: {
          p_account_id: string | null;
          p_error_code: string | null;
          p_identifier: string;
        };
        Returns: number;
      };
      write_audit: {
        Args: {
          p_action: string;
          p_after?: Json | null;
          p_before?: Json | null;
          p_entity_id: string | null;
          p_entity_type: string | null;
          p_error_code?: string | null;
          p_result?: string;
          /**
           * Migration 209 — names the actor explicitly, honoured ONLY for a
           * `service_role` caller. `write_audit` is granted to `authenticated`
           * and PostgREST exposes it, so an `authenticated` client passing this
           * is ignored and cannot attribute an action to someone else. The same
           * gate governs the `x-danat-client-ip` / `x-danat-request-path`
           * headers.
           */
          p_actor_id?: string | null;
        };
        Returns: string;
      };
      // Migration 117 — atomic contract + units save. `p_contract_id` null
      // means create; present means update. Raises rather than returning a
      // contract with zero contract_units rows — the invariant this RPC
      // exists to hold, since the invoice generator bills per contract_units
      // row and would otherwise silently bill nothing.
      /**
       * Migration 210 — flips one contract's portal visibility and nothing
       * else. Deliberately not folded into `save_contract_with_units`, whose
       * live body is migration 200's: re-issuing that whole function to add a
       * boolean is how migrations 166 and 173 carried a stale body forward.
       */
      /**
       * Migration 214 — the ids of a tenant's payments whose every allocation
       * settles a `hide_from_portal` contract. Answered on the server because
       * the client cannot tell a hidden lease from an invoice that is merely
       * flagged `is_visible_to_tenant = false`.
       */
      /**
       * يُرجع صافي التأمين الذي ما زال المكتب يحمله للمستأجر، دون العقود المخفية عن البوابة.
       *
       * Migration 216. Live collected minus completed close-out deductions,
       * unreversed settlements, and still-live linked refunds, floored at zero. Voided
       * or reversed close-out refunds drop out; generic refunds never enter.
       * Returns only that number — a SELECT policy on `insurance_payments`
       * would have handed a tenant the staff-entered note, created_by and
       * internal unit/building ids alongside it.
       */
      portal_insurance_total: {
        Args: { p_contract_id?: string | null; p_tenant_id: string };
        Returns: number;
      };
      portal_hidden_payment_ids: {
        Args: { p_tenant_id: string };
        Returns: string[];
      };
      /** Migration 220 — insurance-gated, audited write of contracts.deposit. */
      sync_contract_deposit_from_insurance: {
        Args: { p_insurance_id: string };
        Returns: ContractRow;
      };
      update_contract_portal_visibility: {
        Args: { p_contract_id: string; p_hide_from_portal: boolean };
        Returns: ContractRow;
      };
      save_contract_with_units: {
        Args: {
          /** Also carries `extra_charges` (migration 166) — a fourth argument
           *  would have created an overload PostgREST cannot disambiguate. */
          p_contract: Json;
          p_units: Json;
          p_contract_id?: string | null;
        };
        Returns: ContractRow;
      };
      save_brand_contracts: {
        Args: { p_brand_id: string; p_contract_ids: string[] };
        Returns: CommercialBrandContractRow[];
      };
      contract_extra_charges_total: {
        Args: { p_contract_id: string };
        Returns: number;
      };
      /** Ownership predicate shared by the tenant save RPC and the media upload
       *  server fn: true when the brand has links and every one of them names a
       *  contract belonging to this tenant. */
      _shop_brand_owned_by_tenant: {
        Args: { p_brand_id: string; p_tenant_id: string };
        Returns: boolean;
      };
      shop_details_for_tenant: {
        Args: { p_contract_id?: string | null };
        Returns: {
          id: string;
          name_original: string;
          name_ar: string;
          name_en: string;
          phone: string | null;
          opening_hours: string | null;
          website_url: string | null;
          instagram_url: string | null;
          description_ar: string | null;
          description_en: string | null;
          logo_media_id: string | null;
          cover_media_id: string | null;
          logo_url: string | null;
          cover_url: string | null;
          updated_at: string;
        }[];
      };
      save_shop_details_as_tenant: {
        Args: {
          p_brand_id: string;
          p_name_original: string;
          p_name_ar: string;
          p_name_en: string;
          p_phone: string | null;
          p_opening_hours: string | null;
          p_website_url: string | null;
          p_instagram_url: string | null;
          p_description_ar: string | null;
          p_description_en: string | null;
          p_logo_media_id: string | null;
          p_cover_media_id: string | null;
          p_expected_updated_at: string | null;
        };
        Returns: CommercialBrandRow;
      };
    };
    Enums: {
      app_role: AppRole;
      concession_types: ConcessionType;
      contract_states: ContractState;
      contract_types: ContractType;
      electricity_meter_ownership: ElectricityMeterOwnership;
      expense_classes: ExpenseClass;
      gateway_payment_methods: GatewayPaymentMethod;
      gateway_providers: GatewayProvider;
      invoice_states: InvoiceState;
      locale_code: LocaleCode;
      notification_audience: NotificationAudience;
      notification_channels: NotificationChannel;
      notification_providers: NotificationProvider;
      notification_states: NotificationState;
      notification_types: NotificationType;
      payment_account_types: PaymentAccountType;
      payment_methods: PaymentMethod;
      property_types: PropertyType;
      tenant_categories: TenantCategory;
      tenant_document_types: TenantDocumentType;
      tenant_lifecycle: TenantLifecycle;
      tariff_types: TariffType;
      unit_status: UnitStatus;
      unit_types: UnitType;
    };
    CompositeTypes: { [_ in never]: never };
  };
}

export type Tables<TableName extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][TableName]["Row"];

export type TablesInsert<TableName extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][TableName]["Insert"];

export type TablesUpdate<TableName extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][TableName]["Update"];
