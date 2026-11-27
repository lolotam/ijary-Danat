import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { SeededCompany } from "@/db/isolation/twoCompanies";

/** الجداول العالمية أو جداول المنصة المستثناة من مصفوفة عزل الشركات. */
export const NON_COMPANY_TABLES = new Set([
  "companies",
  "permissions",
  "reserved_slugs",
  "platform_admins",
  "platform_audit_log",
  "platform_gateway_launch",
  "impersonation_sessions",
]);

export type ColumnSetMap = Map<string, Set<string>>;

export interface SqlStatement {
  sql: string;
  params: unknown[];
}

export interface CompanyTableTarget {
  table: string;
  whereSql: string;
  whereParams: unknown[];
  updateSetSql: string;
  updateParams: unknown[];
  buildCrossCompanyInsert: (foreignCompanyId: string, colMap: ColumnSetMap) => SqlStatement;
}

export interface SeededCompanyIds {
  propertyId: string;
  buildingId: string;
  unitId: string;
  tenantId: string;
  contractId: string;
  contractUnitId: string;
  contractExtraId: string;
  invoiceId: string;
  invoiceItemId: string;
  paymentId: string;
  allocationId: string;
  receiptId: string;
  depositId: string;
  partialPaymentId: string;
  insurancePaymentId: string;
  refundId: string;
  expenseId: string;
  closeoutId: string;
  closeoutDedId: string;
  closeoutInvActId: string;
  opEventId: string;
  tariffId: string;
  meterId: string;
  readingId: string;
  elecChargeId: string;
  employeeId: string;
  empDocId: string;
  salaryId: string;
  customRoleId: string;
  crPermId: string;
  userCustomRoleId: string;
  userRoleId: string;
  rolePermId: string;
  rpPermCode: string;
  permCode: string;
  userTenantId: string;
  auditLogId: string;
  failedAttemptKey: string;
  failedAttemptWindow: string;
  optionListId: string;
  optionItemId: string;
  buildingCategoryId: string;
  expenseCategoryId: string;
  yearNum: number;
  cardId: string;
  maintenanceId: string;
  mediaId: string;
  landingSettingsId: string;
  landingSectionId: string;
  landingSlideId: string;
  leasingInquiryId: string;
  brandId: string;
  concessionId: string;
  tenantDocId: string;
  paymentRequestId: string;
  webhookEventId: string;
  templateId: string;
  templateCode: string;
  reportScheduleId: string;
  generatedReportId: string;
  notificationId: string;
  emailWebhookId: string;
  cronJobId: string;
  backupId: string;
  providerConfigId: string;
  gmailConnectionId: string;
  gmailMessageId: string;
  emailSigId: string;
  chatNumber: string;
  whatsappContactId: string;
  whatsappMsgId: string;
  tenantMsgId: string;
  contactInquiryId: string;
  domainId: string;
}

export interface SeededCompanyGraph {
  company: SeededCompany;
  ids: SeededCompanyIds;
  targets: CompanyTableTarget[];
  colMap: ColumnSetMap;
}

/**
 * يقرأ أعمدة كل جدول في مخطط `public` مرة واحدة لدعم البذر قبل وبعد ترحيل `company_id`.
 */
export async function loadPublicColumnMap(client: PoolClient): Promise<ColumnSetMap> {
  const { rows } = await client.query<{ tbl: string; col: string }>(
    `select c.relname as tbl, a.attname as col
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and a.attnum > 0
        and not a.attisdropped`,
  );
  const map: ColumnSetMap = new Map();
  for (const row of rows) {
    let set = map.get(row.tbl);
    if (!set) {
      set = new Set<string>();
      map.set(row.tbl, set);
    }
    set.add(row.col);
  }
  return map;
}

/**
 * يبني عبارة INSERT مع حقن `company_id` تلقائياً عندما يكون العمود موجوداً في الجدول.
 */
export function buildScopedInsert(
  colMap: ColumnSetMap,
  table: string,
  companyId: string,
  values: Record<string, unknown>,
  casts: Record<string, string> = {},
): SqlStatement {
  const cols = colMap.get(table);
  const payload: Record<string, unknown> = { ...values };
  if (cols?.has("company_id") && !("company_id" in payload)) {
    payload.company_id = companyId;
  }
  const keys = Object.keys(payload);
  const placeholders = keys.map((k, idx) =>
    casts[k] ? `$${idx + 1}::${casts[k]}` : `$${idx + 1}`,
  );
  return {
    sql: `insert into public.${table} (${keys.join(", ")}) values (${placeholders.join(", ")})`,
    params: keys.map((k) => payload[k]),
  };
}

/**
 * يُدرج صفاً في الجدول ويعيد قيمة العمود المطلوب عند الحاجة.
 */
export async function insertRow(
  client: PoolClient,
  colMap: ColumnSetMap,
  table: string,
  companyId: string,
  values: Record<string, unknown>,
  returningCol = "id",
  casts: Record<string, string> = {},
): Promise<string> {
  const stmt = buildScopedInsert(colMap, table, companyId, values, casts);
  const { rows } = await client.query<Record<string, string>>(
    `${stmt.sql} returning ${returningCol}::text as val`,
    stmt.params,
  );
  return rows[0].val;
}

/**
 * ينشئ هدف اختبار قياسي لجدول بمفتاح أساسي وحيد وتحديث آمن للعمود المحدد.
 */
export function makeTarget(
  table: string,
  whereCol: string,
  whereVal: unknown,
  updateCol: string,
  updateVal: unknown,
  buildInsertValues: (tag: string) => {
    values: Record<string, unknown>;
    casts?: Record<string, string>;
  },
): CompanyTableTarget {
  return {
    table,
    whereSql: `${whereCol} = $1`,
    whereParams: [whereVal],
    updateSetSql: `${updateCol} = $2`,
    updateParams: [whereVal, updateVal],
    buildCrossCompanyInsert: (foreignCompanyId, colMap) => {
      const tag = randomUUID().slice(0, 8);
      const { values, casts } = buildInsertValues(tag);
      return buildScopedInsert(
        colMap,
        table,
        foreignCompanyId,
        { ...values, company_id: foreignCompanyId },
        casts,
      );
    },
  };
}
