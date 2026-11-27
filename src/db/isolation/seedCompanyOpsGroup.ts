import type { PoolClient } from "pg";

import {
  buildScopedInsert,
  insertRow,
  type ColumnSetMap,
  type SeededCompanyIds,
} from "@/db/isolation/seedGraphHelpers";

export interface CoreSeedRefs {
  cid: string;
  tag: string;
  adminId: string;
  tenantId: string;
  propertyId: string;
  buildingId: string;
  unitId: string;
  contractId: string;
  concessionId: string;
  expenseCategoryId: string;
}

/**
 * يبذر مجموعات الفوترة والمدفوعات والإغلاق والكهرباء والموارد البشرية والرسائل لشركة واحدة.
 */
export async function seedCompanyOpsGroup(
  client: PoolClient,
  colMap: ColumnSetMap,
  refs: CoreSeedRefs,
): Promise<
  Pick<
    SeededCompanyIds,
    | "invoiceId"
    | "invoiceItemId"
    | "paymentRequestId"
    | "paymentId"
    | "allocationId"
    | "receiptId"
    | "webhookEventId"
    | "depositId"
    | "partialPaymentId"
    | "insurancePaymentId"
    | "refundId"
    | "expenseId"
    | "closeoutId"
    | "closeoutDedId"
    | "closeoutInvActId"
    | "opEventId"
    | "tariffId"
    | "meterId"
    | "readingId"
    | "elecChargeId"
    | "employeeId"
    | "empDocId"
    | "salaryId"
    | "templateId"
    | "templateCode"
    | "reportScheduleId"
    | "generatedReportId"
    | "notificationId"
    | "emailWebhookId"
    | "cronJobId"
    | "backupId"
    | "providerConfigId"
    | "gmailConnectionId"
    | "gmailMessageId"
    | "emailSigId"
    | "chatNumber"
    | "whatsappContactId"
    | "whatsappMsgId"
    | "tenantMsgId"
    | "contactInquiryId"
  >
> {
  const { cid, tag, adminId, tenantId, propertyId, buildingId, unitId, contractId, concessionId } =
    refs;

  // 6. Billing, payments, ledgers, closeout
  const invoiceId = await insertRow(client, colMap, "invoices", cid, {
    code: `INV-${tag}`,
    contract_id: contractId,
    tenant_id: tenantId,
    unit_id: unitId,
    period_year: 2026,
    period_month: 1,
    issue_date: "2026-01-01",
    due_date: "2026-01-05",
    subtotal: 500,
    discount: 0,
    total: 500,
    paid: 0,
    idempotency_key: `inv-idem-${tag}`,
  });
  const invoiceItemId = await insertRow(client, colMap, "invoice_items", cid, {
    invoice_id: invoiceId,
    line: 1,
    unit_id: unitId,
    quantity: 1,
    unit_price: 500,
    amount: 500,
  });
  const ciStmt = buildScopedInsert(colMap, "concession_invoices", cid, {
    concession_id: concessionId,
    invoice_id: invoiceId,
  });
  await client.query(ciStmt.sql, ciStmt.params);
  const paymentRequestId = await insertRow(client, colMap, "payment_requests", cid, {
    code: `PR-${tag}`,
    tenant_id: tenantId,
    amount: 500,
    requested_invoice_ids: [invoiceId],
    idempotency_key: `pr-idem-${tag}`,
  });
  const paymentId = await insertRow(
    client,
    colMap,
    "payments",
    cid,
    {
      code: `PAY-${tag}`,
      tenant_id: tenantId,
      unit_id: unitId,
      method: "cash",
      status: "pending",
      amount: 100,
      payment_date: "2026-01-02",
      payment_request_id: paymentRequestId,
    },
    "id",
    { method: "public.payment_methods" },
  );
  const allocationId = await insertRow(client, colMap, "payment_allocations", cid, {
    payment_id: paymentId,
    invoice_id: invoiceId,
    amount: 100,
  });
  // `sync_payment_receipt` auto-creates the receipt for a confirmed payment.
  const {
    rows: [receiptRow],
  } = await client.query<{ id: string }>(`select id from public.receipts where payment_id = $1`, [
    paymentId,
  ]);
  const receiptId =
    receiptRow?.id ??
    (await insertRow(client, colMap, "receipts", cid, {
      code: `RCP-${tag}`,
      payment_id: paymentId,
      tenant_id: tenantId,
      amount: 100,
    }));
  const webhookEventId = await insertRow(
    client,
    colMap,
    "webhook_events",
    cid,
    { gateway: "myfatoorah", event_type: "payment", provider_event_id: `we-${tag}` },
    "id",
    { gateway: "public.gateway_providers" },
  );
  const depositId = await insertRow(client, colMap, "deposits", cid, {
    code: `DEP-${tag}`,
    deposit_date: "2026-01-02",
    bank_name: "NBK",
    amount: 200,
    status: "pending",
    contract_id: contractId,
    invoice_id: invoiceId,
  });
  const partialPaymentId = await insertRow(client, colMap, "partial_payments", cid, {
    contract_id: contractId,
    tenant_id: tenantId,
    invoice_id: invoiceId,
    unit_id: unitId,
    building_id: buildingId,
    amount: 50,
  });
  const insurancePaymentId = await insertRow(client, colMap, "insurance_payments", cid, {
    contract_id: contractId,
    tenant_id: tenantId,
    unit_id: unitId,
    building_id: buildingId,
    amount: 150,
  });
  const refundId = await insertRow(client, colMap, "refunds", cid, {
    code: `REF-${tag}`,
    contract_id: contractId,
    tenant_id: tenantId,
    unit_id: unitId,
    building_id: buildingId,
    amount: 40,
  });
  const expenseId = await insertRow(client, colMap, "expenses", cid, {
    code: `EXP-${tag}`,
    category_id: refs.expenseCategoryId,
    property_id: propertyId,
    building_id: buildingId,
    unit_id: unitId,
    amount: 75,
  });
  const closeoutId = await insertRow(
    client,
    colMap,
    "contract_closeouts",
    cid,
    {
      contract_id: contractId,
      tenant_id: tenantId,
      unit_id: unitId,
      building_id: buildingId,
      outcome: "keep_terminated",
      final_contract_state: "terminated",
      move_out_date: "2026-12-31",
      deposit_held: 0,
      deductions_total: 0,
      settled_total: 0,
      written_off_total: 0,
      refund_total: 0,
      balance_due_tenant: 0,
      idempotency_key: `co-idem-${tag}`,
    },
    "id",
    { final_contract_state: "public.contract_states" },
  );
  const closeoutDedId = await insertRow(client, colMap, "contract_closeout_deductions", cid, {
    closeout_id: closeoutId,
    line: 1,
    kind: "cleaning",
    amount: 10,
  });
  const closeoutInvActId = await insertRow(
    client,
    colMap,
    "contract_closeout_invoice_actions",
    cid,
    {
      closeout_id: closeoutId,
      invoice_id: invoiceId,
      action: "leave",
      amount: 0,
    },
  );
  const opEventId = await insertRow(client, colMap, "contract_operational_events", cid, {
    contract_id: contractId,
    tenant_id: tenantId,
    closeout_id: closeoutId,
    event_type: "closeout_started",
  });

  // 7. Electricity & HR
  const tariffId = await insertRow(client, colMap, "electricity_tariffs", cid, {
    code: `TAR-${tag}`,
    name_ar: `تعرفة ${tag}`,
    unit_price: 0.005,
  });
  const meterId = await insertRow(client, colMap, "electricity_meters", cid, {
    unit_id: unitId,
    tariff_id: tariffId,
    meter_number: `MTR-${tag}`,
  });
  const readingId = await insertRow(client, colMap, "meter_readings", cid, {
    meter_id: meterId,
    reading: 100,
    consumption_kwh: 100,
    reading_date: "2026-01-31",
    period_year: 2026,
    period_month: 1,
  });
  const elecChargeId = await insertRow(client, colMap, "electricity_charges", cid, {
    code: `ELC-${tag}`,
    meter_id: meterId,
    unit_id: unitId,
    tenant_id: tenantId,
    reading_id: readingId,
    period_year: 2026,
    period_month: 1,
    consumption_kwh: 100,
    amount: 0.5,
  });
  const employeeId = await insertRow(client, colMap, "employees", cid, {
    code: `EMP-${tag}`,
    name: `موظف ${tag}`,
    salary: 350,
  });
  const empDocId = await insertRow(client, colMap, "employee_documents", cid, {
    employee_id: employeeId,
    storage_path: `companies/${cid}/employees/${tag}.pdf`,
  });
  const salaryId = await insertRow(client, colMap, "salaries", cid, {
    employee_id: employeeId,
    year: 2026,
    month: 1,
    amount: 350,
  });

  // 8. Notifications, reports, cron, backups, messaging
  const templateCode = `tpl_${tag}`;
  const templateId = await insertRow(
    client,
    colMap,
    "notification_templates",
    cid,
    { code: templateCode, type: "manual_message", channel: "email", subject_ar: "س", body_ar: "ب" },
    "id",
    { type: "public.notification_types", channel: "public.notification_channels" },
  );
  const reportScheduleId = await insertRow(
    client,
    colMap,
    "report_schedules",
    cid,
    {
      code: `RS-${tag}`,
      name_ar: `تقرير ${tag}`,
      frequency: "monthly",
      recipients: JSON.stringify(["admin@example.com"]),
    },
    "id",
    { recipients: "jsonb" },
  );
  const generatedReportId = await insertRow(client, colMap, "generated_reports", cid, {
    schedule_id: reportScheduleId,
    html_content: "<p>test</p>",
  });
  const notificationId = await insertRow(
    client,
    colMap,
    "notifications",
    cid,
    {
      tenant_id: tenantId,
      invoice_id: invoiceId,
      contract_id: contractId,
      report_schedule_id: reportScheduleId,
      template_code: templateCode,
      type: "manual_message",
      channel: "email",
    },
    "id",
    { type: "public.notification_types", channel: "public.notification_channels" },
  );
  const emailWebhookId = await insertRow(
    client,
    colMap,
    "email_webhook_events",
    cid,
    { provider: "resend", event_type: "delivered", notification_id: notificationId },
    "id",
    { provider: "public.notification_providers" },
  );
  const cronJobId = await insertRow(client, colMap, "cron_jobs", cid, {
    key: `cj_${tag}`,
    name_ar: `مهمة ${tag}`,
    name_en: `Job ${tag}`,
  });
  const backupId = await insertRow(client, colMap, "backups", cid, {
    file_name: `b-${tag}.zip`,
    storage_path: `companies/${cid}/backups/${tag}.zip`,
    sha256: "a".repeat(64),
    size_bytes: 100,
    table_count: 1,
    row_count: 1,
    kind: "manual",
  });
  let providerConfigId: string;
  if (colMap.get("provider_configs")?.has("company_id")) {
    providerConfigId = await insertRow(
      client,
      colMap,
      "provider_configs",
      cid,
      { provider: "smtp", is_enabled: false, config: {} },
      "id",
      { provider: "public.notification_providers", config: "jsonb" },
    );
  } else {
    const {
      rows: [pcRow],
    } = await client.query<{ id: string }>(`select id from public.provider_configs limit 1`);
    providerConfigId = pcRow.id;
  }

  const gmailConnectionId = await insertRow(client, colMap, "gmail_connections", cid, {
    email_address: `gmail-${tag}@example.com`,
    refresh_token: "enc-ref",
  });
  const gmailMessageId = await insertRow(client, colMap, "gmail_messages", cid, {
    message_id: `gm-${tag}`,
    from_address: `sender-${tag}@example.com`,
    received_at: "2026-01-01T00:00:00Z",
  });
  const emailSigId = await insertRow(client, colMap, "email_signatures", cid, {
    admin_id: adminId,
    name: `Sig ${tag}`,
  });
  if (colMap.has("evolution_connections")) {
    const evoStmt = buildScopedInsert(colMap, "evolution_connections", cid, {
      id: 1,
      instance_name: `inst-${tag}`,
      webhook_secret: `sec-${tag}`,
    });
    await client.query(
      `${evoStmt.sql} on conflict (id) do update set instance_name = excluded.instance_name`,
      evoStmt.params,
    );
  }
  if (colMap.has("whatsapp_connections")) {
    // Inactive on purpose: an active row would make the insert trigger stamp
    // connection_id on the chats below and tie this seed to migration 333.
    await insertRow(client, colMap, "whatsapp_connections", cid, {
      method: "evolution_qr",
      is_active: false,
      status: "disconnected",
    });
  }
  const chatNumber = `9655000${tag.slice(0, 4)}@s.whatsapp.net`;
  const chatStmt = buildScopedInsert(colMap, "whatsapp_chats", cid, {
    chat_number: chatNumber,
    display_name: tag,
  });
  await client.query(chatStmt.sql, chatStmt.params);
  const whatsappContactId = await insertRow(client, colMap, "whatsapp_contacts", cid, {
    phone: `9655111${tag.slice(0, 4)}`,
    tenant_id: tenantId,
  });
  const wccStmt = buildScopedInsert(colMap, "whatsapp_contact_contracts", cid, {
    contact_id: whatsappContactId,
    contract_id: contractId,
  });
  await client.query(wccStmt.sql, wccStmt.params);
  const whatsappMsgId = await insertRow(client, colMap, "whatsapp_messages", cid, {
    message_id: `wm-${tag}`,
    chat_number: chatNumber,
    direction: "inbound",
  });
  const tenantMsgId = await insertRow(client, colMap, "tenant_messages", cid, {
    tenant_id: tenantId,
    sender_profile_id: adminId,
    body: `Msg ${tag}`,
  });
  const contactInquiryId = await insertRow(client, colMap, "contact_inquiries", cid, {
    name: `Contact ${tag}`,
    email: `c-${tag}@example.com`,
    message: "Hello",
  });
  if (colMap.has("company_counters")) {
    await client.query(
      `insert into public.company_counters (company_id, kind, last_value)
       values ($1, 'invoice', 1)
       on conflict (company_id, kind) do nothing`,
      [cid],
    );
  }
  // بوابة دفع واحدة وسرها المشفّر لكل شركة: تغطي مصفوفة العزل هذين الجدولين.
  if (colMap.has("gateway_connections")) {
    const gatewayConnectionId = await insertRow(client, colMap, "gateway_connections", cid, {
      provider: "myfatoorah",
      mode: "test",
      is_active: false,
      last_test_ok: false,
      credentials_version: 1,
    });
    if (colMap.has("company_secrets")) {
      await client.query(
        `insert into public.company_secrets (
           company_id, owner_kind, owner_id, name, ciphertext, iv, auth_tag, key_version, last4
         ) values (
           $1, 'gateway', $2, 'api_key',
           decode(repeat('00', 32), 'hex'),
           decode(repeat('00', 12), 'hex'),
           decode(repeat('00', 16), 'hex'),
           1, 'abcd'
         )`,
        [cid, gatewayConnectionId],
      );
    }
  }
  // One explicit section switch per company, so the matrix has a row to aim at.
  if (colMap.has("company_modules")) {
    await client.query(
      `insert into public.company_modules (company_id, module_key, enabled)
       values ($1, 'electricity', true)
       on conflict (company_id, module_key) do nothing`,
      [cid],
    );
  }
  // One recorded subscription per company, so the matrix has a row to aim at.
  if (colMap.has("company_subscriptions")) {
    await client.query(
      `insert into public.company_subscriptions (company_id, plan_name, price, period_start, renewal_date)
       values ($1, 'seed plan', 10, current_date, current_date + 30)`,
      [cid],
    );
  }
  if (colMap.has("company_limits")) {
    await client.query(
      `insert into public.company_limits (company_id, max_units, max_staff_users, max_whatsapp_per_month, max_storage_bytes)
       values ($1, 100, 50, 1000, 104857600)
       on conflict (company_id) do nothing`,
      [cid],
    );
  }
  if (colMap.has("company_usage_monthly")) {
    await client.query(
      `insert into public.company_usage_monthly (company_id, month, whatsapp_sent)
       values ($1, date_trunc('month', current_date)::date, 0)
       on conflict (company_id, month) do nothing`,
      [cid],
    );
  }
  if (colMap.has("company_storage_usage")) {
    await client.query(
      `insert into public.company_storage_usage (company_id, bytes)
       values ($1, 0)
       on conflict (company_id) do nothing`,
      [cid],
    );
  }
  if (colMap.has("job_requests")) {
    await client.query(
      `with j as (
         insert into public.job_requests (company_id, kind, payload)
         values ($1, 'notification.bulk', '{}') returning id)
       insert into public.user_notices (company_id, user_id, job_request_id, kind, title_key, level)
       select $1, $2, j.id, 'notification.bulk', 'notices.bulk.done', 'success' from j`,
      [cid, adminId],
    );
  }

  return {
    invoiceId,
    invoiceItemId,
    paymentRequestId,
    paymentId,
    allocationId,
    receiptId,
    webhookEventId,
    depositId,
    partialPaymentId,
    insurancePaymentId,
    refundId,
    expenseId,
    closeoutId,
    closeoutDedId,
    closeoutInvActId,
    opEventId,
    tariffId,
    meterId,
    readingId,
    elecChargeId,
    employeeId,
    empDocId,
    salaryId,
    templateId,
    templateCode,
    reportScheduleId,
    generatedReportId,
    notificationId,
    emailWebhookId,
    cronJobId,
    backupId,
    providerConfigId,
    gmailConnectionId,
    gmailMessageId,
    emailSigId,
    chatNumber,
    whatsappContactId,
    whatsappMsgId,
    tenantMsgId,
    contactInquiryId,
  };
}
