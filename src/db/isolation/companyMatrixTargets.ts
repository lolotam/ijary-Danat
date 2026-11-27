import { randomUUID } from "node:crypto";

import { buildGatewayMatrixTargets } from "@/db/isolation/gatewayMatrixTargets";
import { buildModuleMatrixTargets } from "@/db/isolation/moduleMatrixTargets";
import { buildSubscriptionMatrixTargets } from "@/db/isolation/subscriptionMatrixTargets";
import {
  buildScopedInsert,
  makeTarget,
  type ColumnSetMap,
  type CompanyTableTarget,
  type SeededCompanyIds,
} from "@/db/isolation/seedGraphHelpers";
import type { SeededCompany } from "@/db/isolation/twoCompanies";

/**
 * يبني قائمة أهداف الاختبار لجميع الجداول التابعة للشركة في مخطط `public`.
 */
export function buildCompanyMatrixTargets(
  company: SeededCompany,
  ids: SeededCompanyIds,
  colMap: ColumnSetMap,
): CompanyTableTarget[] {
  const cid = company.id;
  const adminId = company.users.admin.id;

  const targets: CompanyTableTarget[] = [
    makeTarget("audit_logs", "id", ids.auditLogId, "actor_label", "mutated", (t) => ({
      values: { action: `cross.${t}`, result: "success" },
    })),
    makeTarget("backups", "id", ids.backupId, "note", "mutated", (t) => ({
      values: {
        file_name: `x-${t}.zip`,
        storage_path: `companies/${cid}/backups/x-${t}.zip`,
        sha256: "b".repeat(64),
        size_bytes: 10,
        table_count: 1,
        row_count: 1,
        kind: "manual",
      },
    })),
    makeTarget("building_categories", "id", ids.buildingCategoryId, "name_en", "mutated", (t) => ({
      values: { code: `bc-x-${t}`, name_ar: t, name_en: t },
    })),
    makeTarget("buildings", "id", ids.buildingId, "name_en", "mutated", (t) => ({
      values: { code: `B-x-${t}`, property_id: ids.propertyId, name_ar: t },
    })),
    {
      table: "card_visibility",
      whereSql: "company_id = $1 and card_id = $2",
      whereParams: [cid, ids.cardId],
      updateSetSql: "is_visible = false",
      updateParams: [cid, ids.cardId],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "card_visibility", foreignCid, {
          company_id: foreignCid,
          card_id: `card-x-${randomUUID().slice(0, 8)}`,
          is_visible: true,
        }),
    },
    {
      table: "commercial_brand_contracts",
      whereSql: "brand_id = $1 and contract_id = $2",
      whereParams: [ids.brandId, ids.contractId],
      updateSetSql: "created_at = now()",
      updateParams: [ids.brandId, ids.contractId],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "commercial_brand_contracts", foreignCid, {
          company_id: foreignCid,
          brand_id: ids.brandId,
          contract_id: ids.contractId,
        }),
    },
    makeTarget("commercial_brands", "id", ids.brandId, "name_en", "mutated", (t) => ({
      values: {
        property_id: ids.propertyId,
        name_original: t,
        name_ar: t,
        name_en: t,
        slug: `br-x-${t}`,
      },
    })),
    makeTarget("company_domains", "id", ids.domainId, "provider_ref", "mutated", (t) => ({
      values: { host: `x-${t}.example.com`, kind: "custom" },
    })),
    {
      table: "concession_invoices",
      whereSql: "concession_id = $1 and invoice_id = $2",
      whereParams: [ids.concessionId, ids.invoiceId],
      updateSetSql: "created_at = now()",
      updateParams: [ids.concessionId, ids.invoiceId],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "concession_invoices", foreignCid, {
          company_id: foreignCid,
          concession_id: ids.concessionId,
          invoice_id: ids.invoiceId,
        }),
    },
    makeTarget("concessions", "id", ids.concessionId, "reason", "mutated", () => ({
      values: {
        contract_id: ids.contractId,
        type: "fixed_discount",
        discount_amount: 10,
        start_date: "2026-01-01",
        end_date: "2026-02-01",
      },
      casts: { type: "public.concession_types" },
    })),
    makeTarget("contact_inquiries", "id", ids.contactInquiryId, "subject", "mutated", (t) => ({
      values: { name: t, email: `${t}@example.com`, message: "hi" },
    })),
    makeTarget(
      "contract_closeout_deductions",
      "id",
      ids.closeoutDedId,
      "description_en",
      "mutated",
      () => ({
        values: { closeout_id: ids.closeoutId, line: 99, kind: "other", amount: 5 },
      }),
    ),
    makeTarget(
      "contract_closeout_invoice_actions",
      "id",
      ids.closeoutInvActId,
      "amount",
      1,
      () => ({
        values: {
          closeout_id: ids.closeoutId,
          invoice_id: ids.invoiceId,
          action: "leave",
          amount: 0,
        },
      }),
    ),
    makeTarget("contract_closeouts", "id", ids.closeoutId, "note", "mutated", (t) => ({
      values: {
        contract_id: ids.contractId,
        tenant_id: ids.tenantId,
        outcome: "keep_terminated",
        final_contract_state: "terminated",
        move_out_date: "2026-12-31",
        deposit_held: 0,
        deductions_total: 0,
        settled_total: 0,
        written_off_total: 0,
        refund_total: 0,
        balance_due_tenant: 0,
        idempotency_key: `co-x-${t}`,
      },
      casts: { final_contract_state: "public.contract_states" },
    })),
    makeTarget("contract_extra_charges", "id", ids.contractExtraId, "amount", 30, () => ({
      values: { contract_id: ids.contractId, category_id: ids.expenseCategoryId, amount: 15 },
    })),
    makeTarget("contract_operational_events", "id", ids.opEventId, "note", "mutated", () => ({
      values: { contract_id: ids.contractId, event_type: "closeout_started" },
    })),
    makeTarget("contract_units", "id", ids.contractUnitId, "monthly_amount", 600, () => ({
      values: { contract_id: ids.contractId, unit_id: ids.unitId, monthly_amount: 100 },
    })),
    makeTarget("contracts", "id", ids.contractId, "notes", "mutated", (t) => ({
      values: {
        code: `C-x-${t}`,
        tenant_id: ids.tenantId,
        start_date: "2026-01-01",
        end_date: "2026-12-31",
      },
    })),
    makeTarget("cron_jobs", "id", ids.cronJobId, "description_en", "mutated", (t) => ({
      values: { key: `cj_x_${t}`, name_ar: t, name_en: t },
    })),
    makeTarget(
      "custom_role_permissions",
      "id",
      ids.crPermId,
      "permission_code",
      ids.permCode,
      () => ({
        values: { custom_role_id: ids.customRoleId, permission_code: ids.permCode },
      }),
    ),
    makeTarget("custom_roles", "id", ids.customRoleId, "description", "mutated", (t) => ({
      values: { code: `cr-x-${t}`, name_ar: t, name_en: t },
    })),
    makeTarget("deposits", "id", ids.depositId, "note", "mutated", (t) => ({
      values: { code: `DEP-x-${t}`, deposit_date: "2026-01-02", bank_name: "NBK", amount: 10 },
    })),
    makeTarget("electricity_charges", "id", ids.elecChargeId, "notes", "mutated", (t) => ({
      values: {
        code: `ELC-x-${t}`,
        meter_id: ids.meterId,
        unit_id: ids.unitId,
        period_year: 2027,
        period_month: 2,
        consumption_kwh: 10,
        amount: 1,
      },
    })),
    makeTarget("electricity_meters", "id", ids.meterId, "notes", "mutated", (t) => ({
      values: { unit_id: ids.unitId, meter_number: `MTR-x-${t}`, is_active: false },
    })),
    makeTarget("electricity_tariffs", "id", ids.tariffId, "name_en", "mutated", (t) => ({
      values: { code: `TAR-x-${t}`, name_ar: t, unit_price: 0.01 },
    })),
    makeTarget("email_signatures", "id", ids.emailSigId, "name", "mutated", (t) => ({
      values: { admin_id: adminId, name: `Sig-x-${t}` },
    })),
    makeTarget("email_webhook_events", "id", ids.emailWebhookId, "event_type", "mutated", () => ({
      values: { provider: "resend", event_type: "bounced" },
      casts: { provider: "public.notification_providers" },
    })),
    makeTarget("employee_documents", "id", ids.empDocId, "display_name", "mutated", (t) => ({
      values: {
        employee_id: ids.employeeId,
        storage_path: `companies/${cid}/employees/x-${t}.pdf`,
      },
    })),
    makeTarget("employees", "id", ids.employeeId, "notes", "mutated", (t) => ({
      values: { code: `EMP-x-${t}`, name: t, salary: 100 },
    })),
    makeTarget("expense_categories", "id", ids.expenseCategoryId, "name_en", "mutated", (t) => ({
      values: { code: `ec-x-${t}`, name_ar: t },
    })),
    makeTarget("expenses", "id", ids.expenseId, "note", "mutated", (t) => ({
      values: { code: `EXP-x-${t}`, amount: 10 },
    })),
    {
      table: "failed_login_attempts",
      whereSql: "scope = 'identifier' and identifier_key = $1",
      whereParams: [ids.failedAttemptKey],
      updateSetSql: "attempts = 99",
      updateParams: [ids.failedAttemptKey],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "failed_login_attempts", foreignCid, {
          company_id: foreignCid,
          scope: "identifier",
          identifier_key: `fail-x-${randomUUID().slice(0, 8)}`,
          client_ip: "127.0.0.1",
          window_start: ids.failedAttemptWindow,
        }),
    },
    makeTarget(
      "generated_reports",
      "id",
      ids.generatedReportId,
      "html_content",
      "<p>x</p>",
      () => ({
        values: { html_content: "<p>cross</p>" },
      }),
    ),
    makeTarget("gmail_connections", "id", ids.gmailConnectionId, "scope", "mutated", (t) => ({
      values: { email_address: `gx-${t}@example.com`, refresh_token: "enc" },
    })),
    makeTarget("gmail_messages", "id", ids.gmailMessageId, "subject", "mutated", (t) => ({
      values: {
        message_id: `gmx-${t}`,
        from_address: "a@example.com",
        received_at: "2026-01-01T00:00:00Z",
      },
    })),
    makeTarget("insurance_payments", "id", ids.insurancePaymentId, "note", "mutated", () => ({
      values: { contract_id: ids.contractId, tenant_id: ids.tenantId, amount: 10 },
    })),
    makeTarget("invoice_items", "id", ids.invoiceItemId, "description_en", "mutated", () => ({
      values: { invoice_id: ids.invoiceId, line: 99, quantity: 1, unit_price: 10, amount: 10 },
    })),
    {
      table: "invoice_years",
      whereSql: "year = $1",
      whereParams: [ids.yearNum],
      updateSetSql: "created_at = now()",
      updateParams: [ids.yearNum],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "invoice_years", foreignCid, {
          company_id: foreignCid,
          year: 2900 + Math.floor(Math.random() * 900),
        }),
    },
    makeTarget("invoices", "id", ids.invoiceId, "notes", "mutated", (t) => ({
      values: {
        code: `INV-x-${t}`,
        contract_id: ids.contractId,
        tenant_id: ids.tenantId,
        period_year: 2027,
        period_month: 2,
        issue_date: "2027-02-01",
        due_date: "2027-02-05",
        idempotency_key: `inv-x-${t}`,
      },
    })),
    makeTarget("landing_carousel_slides", "id", ids.landingSlideId, "title_en", "mutated", (t) => ({
      values: { media_id: ids.mediaId, title_ar: t, title_en: t },
    })),
    makeTarget("landing_media", "id", ids.mediaId, "alt_en", "mutated", (t) => ({
      values: {
        storage_path: `companies/${cid}/landing/x-${t}.jpg`,
        mime_type: "image/jpeg",
        category: "gallery",
      },
    })),
    makeTarget("landing_page_sections", "id", ids.landingSectionId, "enabled", false, (t) => ({
      values: { section_key: `sec-x-${t}`, enabled: false },
    })),
    makeTarget(
      "landing_page_settings",
      "id",
      ids.landingSettingsId,
      "hero_title",
      "mutated",
      () => ({
        values: {
          locale: "en",
          hero_title: "x",
          hero_subtitle: "x",
          about_title: "x",
          about_body: "x",
          leasing_title: "x",
          leasing_body: "x",
        },
      }),
    ),
    makeTarget("leasing_inquiries", "id", ids.leasingInquiryId, "status", "contacted", (t) => ({
      values: { name: t, phone: "50000001", email: `${t}@example.com` },
    })),
    makeTarget("maintenance_requests", "id", ids.maintenanceId, "description", "mutated", (t) => ({
      values: { code: `M-x-${t}`, property_id: ids.propertyId, title: t },
    })),
    makeTarget("meter_readings", "id", ids.readingId, "note", "mutated", () => ({
      values: {
        meter_id: ids.meterId,
        reading: 200,
        consumption_kwh: 100,
        reading_date: "2026-02-28",
        period_year: 2026,
        period_month: 2,
      },
    })),
    makeTarget("notification_templates", "id", ids.templateId, "subject_en", "mutated", (t) => ({
      values: { code: `tpl_x_${t}`, type: "manual_message", channel: "email" },
      casts: { type: "public.notification_types", channel: "public.notification_channels" },
    })),
    makeTarget("notifications", "id", ids.notificationId, "subject", "mutated", () => ({
      values: { type: "manual_message", channel: "email" },
      casts: { type: "public.notification_types", channel: "public.notification_channels" },
    })),
    makeTarget("option_list_items", "id", ids.optionItemId, "label_en", "mutated", (t) => ({
      values: { list_id: ids.optionListId, value: `val-x-${t}`, label_ar: t, label_en: t },
    })),
    makeTarget("option_lists", "id", ids.optionListId, "name_en", "mutated", (t) => ({
      values: { code: `ol-x-${t}`, name_ar: t, name_en: t },
    })),
    makeTarget("partial_payments", "id", ids.partialPaymentId, "note", "mutated", () => ({
      values: { tenant_id: ids.tenantId, amount: 10 },
    })),
    makeTarget("payment_allocations", "id", ids.allocationId, "amount", 50, () => ({
      values: { payment_id: ids.paymentId, invoice_id: ids.invoiceId, amount: 10 },
    })),
    makeTarget(
      "payment_requests",
      "id",
      ids.paymentRequestId,
      "payment_url",
      "https://example.com",
      (t) => ({
        values: {
          code: `PR-x-${t}`,
          tenant_id: ids.tenantId,
          amount: 10,
          requested_invoice_ids: [ids.invoiceId],
        },
      }),
    ),
    makeTarget("payments", "id", ids.paymentId, "note", "mutated", (t) => ({
      values: {
        code: `PAY-x-${t}`,
        tenant_id: ids.tenantId,
        method: "cash",
        amount: 10,
        payment_date: "2026-01-03",
      },
      casts: { method: "public.payment_methods" },
    })),
    makeTarget("profiles", "id", adminId, "display_name", "mutated", (t) => ({
      values: { id: randomUUID(), username: `prof_x_${t}`, display_name: t },
    })),
    makeTarget("properties", "id", ids.propertyId, "name_en", "mutated", (t) => ({
      values: { code: `P-x-${t}`, name_ar: t },
    })),
    makeTarget(
      "provider_configs",
      "id",
      ids.providerConfigId,
      "from_email",
      "x@example.com",
      () => ({
        values: { provider: "smtp", is_enabled: false, config: {} },
        casts: { provider: "public.notification_providers", config: "jsonb" },
      }),
    ),
    makeTarget("receipts", "id", ids.receiptId, "visible_to_tenant", false, (t) => ({
      values: {
        code: `RCP-x-${t}`,
        payment_id: ids.paymentId,
        tenant_id: ids.tenantId,
        amount: 10,
      },
    })),
    makeTarget("refunds", "id", ids.refundId, "note", "mutated", (t) => ({
      values: { code: `REF-x-${t}`, tenant_id: ids.tenantId, amount: 10 },
    })),
    makeTarget("report_schedules", "id", ids.reportScheduleId, "name_en", "mutated", (t) => ({
      values: {
        code: `RS-x-${t}`,
        name_ar: t,
        frequency: "daily",
        recipients: JSON.stringify(["a@example.com"]),
      },
      casts: { recipients: "jsonb" },
    })),
    makeTarget("role_permissions", "id", ids.rolePermId, "permission_code", ids.rpPermCode, () => ({
      values: { role: "tenant", permission_code: ids.permCode },
      casts: { role: "public.app_role" },
    })),
    makeTarget("salaries", "id", ids.salaryId, "note", "mutated", () => ({
      values: { employee_id: ids.employeeId, year: 2026, month: 2, amount: 100 },
    })),
    makeTarget("tenant_documents", "id", ids.tenantDocId, "display_name", "mutated", (t) => ({
      values: {
        tenant_id: ids.tenantId,
        type: "other",
        storage_path: `companies/${cid}/tenants/x-${t}.pdf`,
      },
      casts: { type: "public.tenant_document_types" },
    })),
    makeTarget("tenant_messages", "id", ids.tenantMsgId, "subject", "mutated", (t) => ({
      values: { tenant_id: ids.tenantId, body: t },
    })),
    makeTarget("tenants", "id", ids.tenantId, "notes", "mutated", (t) => ({
      values: { code: `T-x-${t}`, name: t },
    })),
    makeTarget("units", "id", ids.unitId, "name_en", "mutated", (t) => ({
      values: { code: `U-x-${t}`, property_id: ids.propertyId, name: t },
    })),
    makeTarget(
      "user_custom_roles",
      "id",
      ids.userCustomRoleId,
      "created_at",
      "2026-01-01T00:00:00Z",
      () => ({
        values: { user_id: adminId, custom_role_id: ids.customRoleId },
      }),
    ),
    makeTarget("user_roles", "id", ids.userRoleId, "created_at", "2026-01-01T00:00:00Z", () => ({
      values: { user_id: adminId, role: "collector" },
      casts: { role: "public.app_role" },
    })),
    makeTarget(
      "user_tenants",
      "id",
      ids.userTenantId,
      "created_at",
      "2026-01-01T00:00:00Z",
      () => ({
        values: { user_id: adminId, tenant_id: ids.tenantId },
      }),
    ),
    makeTarget("webhook_events", "id", ids.webhookEventId, "error", "mutated", (t) => ({
      values: { gateway: "myfatoorah", provider_event_id: `wex-${t}` },
      casts: { gateway: "public.gateway_providers" },
    })),
    {
      table: "whatsapp_chats",
      whereSql: "chat_number = $1",
      whereParams: [ids.chatNumber],
      updateSetSql: "display_name = 'mutated'",
      updateParams: [ids.chatNumber],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "whatsapp_chats", foreignCid, {
          company_id: foreignCid,
          chat_number: `9655999${randomUUID().slice(0, 4)}@s.whatsapp.net`,
        }),
    },
    {
      table: "whatsapp_contact_contracts",
      whereSql: "contact_id = $1 and contract_id = $2",
      whereParams: [ids.whatsappContactId, ids.contractId],
      updateSetSql: "created_at = now()",
      updateParams: [ids.whatsappContactId, ids.contractId],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "whatsapp_contact_contracts", foreignCid, {
          company_id: foreignCid,
          contact_id: ids.whatsappContactId,
          contract_id: ids.contractId,
        }),
    },
    makeTarget("whatsapp_contacts", "id", ids.whatsappContactId, "name", "mutated", () => ({
      values: { phone: `9655888${randomUUID().slice(0, 4)}` },
    })),
    makeTarget("whatsapp_messages", "id", ids.whatsappMsgId, "body", "mutated", (t) => ({
      values: { message_id: `wmx-${t}`, chat_number: ids.chatNumber, direction: "inbound" },
    })),
  ];

  targets.push(...buildGatewayMatrixTargets(cid, colMap));
  targets.push(...buildModuleMatrixTargets(cid, colMap));
  targets.push(...buildSubscriptionMatrixTargets(cid, colMap));

  if (colMap.has("evolution_connections")) {
    targets.push({
      table: "evolution_connections",
      whereSql: "id = 1",
      whereParams: [],
      updateSetSql: "instance_name = 'mutated'",
      updateParams: [],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "evolution_connections", foreignCid, {
          id: 1,
          company_id: foreignCid,
          instance_name: `inst-x-${randomUUID().slice(0, 6)}`,
          webhook_secret: "sec-x",
        }),
    });
  }

  if (colMap.has("company_counters")) {
    targets.push({
      table: "company_counters",
      whereSql: "company_id = $1 and kind = 'invoice'",
      whereParams: [cid],
      updateSetSql: "last_value = 99",
      updateParams: [cid],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "company_counters", foreignCid, {
          company_id: foreignCid,
          kind: "receipt",
          last_value: 1,
        }),
    });
  }

  if (colMap.has("job_requests")) {
    targets.push(
      {
        table: "job_requests",
        whereSql: "company_id = $1",
        whereParams: [cid],
        updateSetSql: "status = 'failed'",
        updateParams: [cid],
        buildCrossCompanyInsert: (foreignCid, cm) =>
          buildScopedInsert(cm, "job_requests", foreignCid, {
            company_id: foreignCid,
            kind: "company.restore",
          }),
      },
      {
        table: "user_notices",
        whereSql: "company_id = $1",
        whereParams: [cid],
        updateSetSql: "read_at = now()",
        updateParams: [cid],
        buildCrossCompanyInsert: (foreignCid, cm) =>
          buildScopedInsert(cm, "user_notices", foreignCid, {
            company_id: foreignCid,
            user_id: adminId,
            kind: "notification.bulk",
            title_key: "notices.bulk.done",
            level: "success",
          }),
      },
    );
  }

  if (colMap.has("password_reset_tokens")) {
    targets.push({
      table: "password_reset_tokens",
      whereSql: "company_id = $1",
      whereParams: [cid],
      updateSetSql: "used_at = now()",
      updateParams: [cid],
      buildCrossCompanyInsert: (foreignCid, cm) =>
        buildScopedInsert(cm, "password_reset_tokens", foreignCid, {
          company_id: foreignCid,
          user_id: adminId,
          token_hash: `x-${randomUUID().replace(/-/g, "")}`,
          expires_at: "2027-01-01T00:00:00Z",
        }),
    });
  }

  return targets;
}
