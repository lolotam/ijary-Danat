/**
 * قيم الترتيب للجداول الإدارية التي تستخدم useTableSort.
 *
 * Each getter returns the underlying value — a number for money/counts, an ISO
 * string for dates — because the primitive's string path is localeCompare. A
 * formatted "10 KWD" or a Date object's weekday-prefixed string would order
 * rows by text, not by the amount or the calendar.
 */

export type PropertyUnitSortRow = {
  code: string;
  default_rent: number | string | null;
  floor: string | null;
  name: string;
  occupant: { name: string } | null;
  paci_no: string | null;
  status: string;
  type: string;
};

export type UnitContractSortRow = {
  code: string;
  end_date: string | null;
  monthly_amount: number | string | null;
  start_date: string | null;
  state: string;
  tenant: { name: string } | null;
};

export type UnitInvoiceSortRow = {
  balance: number | string | null;
  code: string;
  period_month: number;
  period_year: number;
  state: string;
  total: number | string | null;
};

export type UnitPaymentSortRow = {
  amount: number | string | null;
  code: string;
  method: string;
  payment_date: string | null;
  status: string;
};

export type ReportPreviewSortRow = Record<string, number | string>;

export type ReportScheduleSortRow = {
  code: string;
  frequency: string;
  is_active: boolean;
  last_run_at: string | null;
  locale: string;
  name_ar: string;
  name_en: string | null;
  next_run_at: string | null;
  recipients: unknown;
};

export type GeneratedReportSortRow = {
  created_at: string;
  locale: string | null;
  period_end: string | null;
  period_start: string | null;
  schedule: { code: string; name_ar: string; name_en: string | null } | null;
  sent: boolean;
};

export type NotificationLogSortRow = {
  audience: string | null;
  channel: string;
  contract: { code: string } | null;
  failure_reason: string | null;
  invoice: { code: string } | null;
  locale: string;
  provider: string | null;
  provider_message_id: string | null;
  recipient_address: string | null;
  retry_count: number;
  scheduled_at: string | null;
  sender_address: string | null;
  sent_at: string | null;
  state: string;
  template_code: string | null;
  tenant: { name: string } | null;
  type: string;
};

export type NotificationTemplateSortRow = {
  channel: string;
  code: string;
  is_active: boolean;
  type: string;
};

export type TenantInvoiceSortRow = {
  balance: number | string | null;
  code: string;
  discount: number | string | null;
  due_date: string | null;
  period_month: number;
  period_year: number;
  properties: Array<{ name_ar: string; name_en: string | null }> | null;
  state: string;
  total: number | string | null;
  units: Array<{ code: string; name: string | null }> | null;
};

export type TenantWidePaymentSortRow = {
  amount: number | string | null;
  code: string;
  method: string;
  payment_date: string | null;
  status: string;
};

export type ContractPaymentSortRow = {
  allocated: number | string;
  amount: number | string | null;
  code: string;
  method: string;
  payment_date: string | null;
  status: string;
};

export type MoneyRecordSortRow = {
  amount: number | string | null;
  note: string | null;
} & Record<string, unknown>;

export type MoneyRecordSortContext = {
  contract?: {
    code?: string | null;
    complexName?: string | null;
    tenantName?: string | null;
    unitName?: string | null;
  } | null;
  dateColumn: string;
};

/**
 * يحوّل قيمة نقدية أو عددية إلى رقم حتى لا يُرتَّب النص المنسّق.
 */
function asNumber(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

/**
 * قيمة ترتيب صف وحدة في جدول وحدات العقار.
 */
export function propertyUnitSortValue(unit: PropertyUnitSortRow, key: string): unknown {
  switch (key) {
    case "code":
      return unit.code;
    case "paci_no":
      return unit.paci_no;
    case "name":
      return unit.name;
    case "type":
      return unit.type;
    case "floor":
      return unit.floor;
    case "status":
      return unit.status;
    case "rent":
      return asNumber(unit.default_rent);
    case "occupant":
      return unit.occupant?.name ?? null;
    default:
      return (unit as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف عقد في تبويب عقود الوحدة.
 */
export function unitContractSortValue(contract: UnitContractSortRow, key: string): unknown {
  switch (key) {
    case "code":
      return contract.code;
    case "tenant":
      return contract.tenant?.name ?? null;
    case "state":
      return contract.state;
    case "start_date":
      return contract.start_date;
    case "end_date":
      return contract.end_date;
    case "monthly_amount":
      return asNumber(contract.monthly_amount);
    default:
      return (contract as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف فاتورة شهرية في تبويب فواتير الوحدة.
 *
 * Period is year*100+month so October 2026 (202610) sorts after September
 * (202609). The cell renders `2026-10`; that string is chronological too, but
 * a later formatter that swapped in a month name would silently break it.
 */
export function unitInvoiceSortValue(invoice: UnitInvoiceSortRow, key: string): unknown {
  switch (key) {
    case "code":
      return invoice.code;
    case "period":
      return invoice.period_year * 100 + invoice.period_month;
    case "state":
      return invoice.state;
    case "total":
      return asNumber(invoice.total);
    case "balance":
      return asNumber(invoice.balance);
    default:
      return (invoice as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف دفعة يدوية في تبويب دفعات الوحدة.
 */
export function unitPaymentSortValue(payment: UnitPaymentSortRow, key: string): unknown {
  switch (key) {
    case "code":
      return payment.code;
    case "method":
      return payment.method;
    case "status":
      return payment.status;
    case "amount":
      return asNumber(payment.amount);
    case "payment_date":
      return payment.payment_date;
    default:
      return (payment as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب خلية في معاينة التقرير — الأعمدة ديناميكية بحسب نوع التقرير.
 *
 * Numbers stay numbers. A numeric-looking string is coerced so an amount that
 * arrived as "10" does not sort as text. ISO dates stay strings: their
 * lexicographic order is chronological.
 */
export function reportPreviewSortValue(row: ReportPreviewSortRow, key: string): unknown {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return value;
}

/**
 * قيمة ترتيب صف جدول التقارير المجدولة.
 */
export function reportScheduleSortValue(
  schedule: ReportScheduleSortRow,
  key: string,
  locale: "ar" | "en",
): unknown {
  switch (key) {
    case "code":
      return schedule.code;
    case "name":
      return locale === "ar" ? schedule.name_ar : (schedule.name_en ?? schedule.name_ar);
    case "frequency":
      return schedule.frequency;
    case "recipients":
      return Array.isArray(schedule.recipients) ? schedule.recipients.join(", ") : null;
    case "locale":
      return schedule.locale;
    case "last_run_at":
      return schedule.last_run_at;
    case "next_run_at":
      return schedule.next_run_at;
    case "is_active":
      return schedule.is_active;
    default:
      return (schedule as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف جدول التقارير المُنشأة.
 */
export function generatedReportSortValue(
  report: GeneratedReportSortRow,
  key: string,
  locale: "ar" | "en",
): unknown {
  switch (key) {
    case "code":
      return report.schedule?.code ?? null;
    case "name":
      return report.schedule
        ? locale === "ar"
          ? report.schedule.name_ar
          : (report.schedule.name_en ?? report.schedule.name_ar)
        : null;
    case "period":
      return report.period_start;
    case "locale":
      return report.locale;
    case "delivery":
      return report.sent;
    case "created_at":
      return report.created_at;
    default:
      return (report as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف سجل الإشعارات (حوض الأتمتة).
 */
export function notificationLogSortValue(item: NotificationLogSortRow, key: string): unknown {
  switch (key) {
    case "tenant":
      return item.tenant?.name ?? null;
    case "audience":
      return item.audience;
    case "to":
      return item.recipient_address;
    case "from":
      return item.sender_address;
    case "type":
      return item.type;
    case "related":
      return item.invoice?.code ?? item.contract?.code ?? null;
    case "language":
      return item.locale;
    case "channel":
      return item.channel;
    case "template":
      return item.template_code;
    case "scheduledAt":
      return item.scheduled_at;
    case "sentAt":
      return item.sent_at;
    case "provider":
      return item.provider;
    case "providerId":
      return item.provider_message_id;
    case "status":
      return item.state;
    case "failure":
      return item.failure_reason;
    case "retries":
      return item.retry_count;
    default:
      return (item as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف قالب إشعار. النشاط منطقي لا نص نعم/لا.
 */
export function notificationTemplateSortValue(
  template: NotificationTemplateSortRow,
  key: string,
): unknown {
  switch (key) {
    case "code":
      return template.code;
    case "type":
      return template.type;
    case "channel":
      return template.channel;
    case "is_active":
      return template.is_active;
    default:
      return (template as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف فاتورة في جدول فواتير المستأجر (تفاصيل المستأجر).
 *
 * Period is year*100+month so October 2026 (202610) sorts after September
 * (202609), matching `unitInvoiceSortValue`. Properties and units are arrays
 * on a consolidated multi-unit invoice — sort by the first one's name/code so
 * there is a defined order; rows with no properties/units fall to the end.
 * Discount is the raw KWD amount, not the months count shown in the badge, so
 * "10 KWD off" sorts above "9 KWD off".
 */
export function tenantInvoiceSortValue(invoice: TenantInvoiceSortRow, key: string): unknown {
  switch (key) {
    case "code":
      return invoice.code;
    case "properties":
      return invoice.properties?.[0]?.name_ar ?? null;
    case "units":
      return invoice.units?.[0]?.code ?? null;
    case "period":
      return invoice.period_year * 100 + invoice.period_month;
    case "due_date":
      return invoice.due_date;
    case "state":
      return invoice.state;
    case "discount":
      return asNumber(invoice.discount);
    case "total":
      return asNumber(invoice.total);
    case "balance":
      return asNumber(invoice.balance);
    default:
      return (invoice as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف دفعة في جدول دفعات المستأجر الشامل (تفاصيل المستأجر).
 */
export function tenantWidePaymentSortValue(
  payment: TenantWidePaymentSortRow,
  key: string,
): unknown {
  switch (key) {
    case "code":
      return payment.code;
    case "date":
      return payment.payment_date;
    case "method":
      return payment.method;
    case "amount":
      return asNumber(payment.amount);
    case "state":
      return payment.status;
    default:
      return (payment as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف دفعة في جدول دفعات العقد (تفاصيل المستأجر).
 *
 * `allocated` is the share of the payment that landed on this contract's
 * invoices, already a number from `attributePaymentsToContract`. Sorting by it
 * answers "which payment paid down this contract the most" — the question the
 * allocated-to-contract column exists to surface.
 */
export function contractPaymentSortValue(payment: ContractPaymentSortRow, key: string): unknown {
  switch (key) {
    case "code":
      return payment.code;
    case "date":
      return payment.payment_date;
    case "method":
      return payment.method;
    case "amount":
      return asNumber(payment.amount);
    case "allocated":
      return asNumber(payment.allocated);
    case "state":
      return payment.status;
    default:
      return (payment as Record<string, unknown>)[key];
  }
}

/**
 * قيمة ترتيب صف استرداد / دفعة جزئية / تأمين.
 *
 * The three panels share one table; only the date column name differs.
 */
export function moneyRecordSortValue(
  row: MoneyRecordSortRow,
  key: string,
  context: MoneyRecordSortContext,
): unknown {
  switch (key) {
    case "date":
      return row[context.dateColumn] ?? null;
    case "contract":
      return context.contract?.code ?? null;
    case "tenant":
      return context.contract?.tenantName ?? null;
    case "unit":
      return context.contract?.unitName ?? null;
    case "complex":
      return context.contract?.complexName ?? null;
    case "amount":
      return asNumber(row.amount);
    case "note":
      return row.note;
    case "invoice": {
      const invoice = row.invoice as { code?: string } | null | undefined;
      return invoice?.code ?? null;
    }
    case "status":
      return row.status ?? null;
    default:
      return row[key];
  }
}
