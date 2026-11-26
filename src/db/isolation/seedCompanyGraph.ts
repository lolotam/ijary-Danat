import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { buildCompanyMatrixTargets } from "@/db/isolation/companyMatrixTargets";
import { seedCompanyOpsGroup } from "@/db/isolation/seedCompanyOpsGroup";
import {
  buildScopedInsert,
  insertRow,
  loadPublicColumnMap,
  type SeededCompanyGraph,
  type SeededCompanyIds,
} from "@/db/isolation/seedGraphHelpers";
import type { SeededCompany } from "@/db/isolation/twoCompanies";

export { NON_COMPANY_TABLES, buildScopedInsert } from "@/db/isolation/seedGraphHelpers";
export type {
  ColumnSetMap,
  CompanyTableTarget,
  SeededCompanyGraph,
  SeededCompanyIds,
} from "@/db/isolation/seedGraphHelpers";

/**
 * يبذر بيانات شركة كاملة عبر جميع جداول `public` التابعة للشركة لإجراء اختبارات العزل.
 *
 * Sets a temporary `company_service` JWT claim for `postgres` so DB triggers
 * calling `next_*_code()` or `current_company_id()` resolve the seeded company.
 */
export async function seedCompanyGraph(
  client: PoolClient,
  company: SeededCompany,
): Promise<SeededCompanyGraph> {
  const {
    rows: [prevClaimsRow],
  } = await client.query<{ claims: string | null }>(
    `select nullif(current_setting('request.jwt.claims', true), '') as claims`,
  );
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ role: "company_service", company_id: company.id }),
  ]);
  try {
    return await runSeedCompanyGraph(client, company);
  } finally {
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      prevClaimsRow?.claims ?? "",
    ]);
  }
}

/**
 * ينفّذ خطوات بذر جداول الشركة ضمن سياق ادعاءات الشركة المحددة.
 */
async function runSeedCompanyGraph(
  client: PoolClient,
  company: SeededCompany,
): Promise<SeededCompanyGraph> {
  const colMap = await loadPublicColumnMap(client);
  const cid = company.id;
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const adminId = company.users.admin.id;
  const tenantUserId = company.users.tenant.id;
  const tenantId = company.users.tenant.tenantId!;

  // 1. Identity & permissions
  const {
    rows: [permRow],
  } = await client.query<{ code: string }>(
    `select code from public.permissions order by code limit 1`,
  );
  const permCode = permRow.code;
  const {
    rows: [unusedPerm],
  } = await client.query<{ code: string }>(
    `select p.code from public.permissions p
      where not exists (
        select 1 from public.role_permissions rp
         where rp.role = 'tenant'::public.app_role and rp.permission_code = p.code
      ) order by p.code limit 1`,
  );
  const rpPermCode = unusedPerm?.code ?? permCode;

  const customRoleId = await insertRow(client, colMap, "custom_roles", cid, {
    code: `cr-${tag}`,
    name_ar: `دور ${tag}`,
    name_en: `Role ${tag}`,
  });
  const crPermId = await insertRow(client, colMap, "custom_role_permissions", cid, {
    custom_role_id: customRoleId,
    permission_code: permCode,
  });
  const userCustomRoleId = await insertRow(client, colMap, "user_custom_roles", cid, {
    user_id: adminId,
    custom_role_id: customRoleId,
  });
  const {
    rows: [userRoleRow],
  } = await client.query<{ id: string }>(
    `select id from public.user_roles where user_id = $1 limit 1`,
    [adminId],
  );
  const {
    rows: [existingRp],
  } = await client.query<{ id: string }>(
    `select id from public.role_permissions where role = 'tenant'::public.app_role and permission_code = $1`,
    [rpPermCode],
  );
  const rolePermId =
    existingRp?.id ??
    (await insertRow(
      client,
      colMap,
      "role_permissions",
      cid,
      { role: "tenant", permission_code: rpPermCode },
      "id",
      { role: "public.app_role" },
    ));
  const userTenantId = await insertRow(client, colMap, "user_tenants", cid, {
    user_id: tenantUserId,
    tenant_id: tenantId,
  });
  const auditLogId = await insertRow(client, colMap, "audit_logs", cid, {
    actor_id: adminId,
    action: `test.seed.${tag}`,
    entity_type: "tenants",
    entity_id: tenantId,
    result: "success",
  });
  const failedAttemptKey = `fail-${tag}`;
  const failedAttemptWindow = "2026-11-26T00:00:00Z";
  const failStmt = buildScopedInsert(colMap, "failed_login_attempts", cid, {
    scope: "identifier",
    identifier_key: failedAttemptKey,
    client_ip: "127.0.0.1",
    window_start: failedAttemptWindow,
  });
  await client.query(failStmt.sql, failStmt.params);
  const {
    rows: [domainRow],
  } = await client.query<{ id: string }>(
    `select id from public.company_domains where company_id = $1 limit 1`,
    [cid],
  );

  // 2. Lists & categories
  const optionListId = await insertRow(client, colMap, "option_lists", cid, {
    code: `ol-${tag}`,
    name_ar: `قائمة ${tag}`,
    name_en: `List ${tag}`,
  });
  const optionItemId = await insertRow(client, colMap, "option_list_items", cid, {
    list_id: optionListId,
    value: `val-${tag}`,
    label_ar: "قيمة",
    label_en: "Value",
  });
  const buildingCategoryId = await insertRow(client, colMap, "building_categories", cid, {
    code: `bc-${tag}`,
    name_ar: `تصنيف ${tag}`,
    name_en: `Cat ${tag}`,
  });
  const expenseCategoryId = await insertRow(client, colMap, "expense_categories", cid, {
    code: `ec-${tag}`,
    name_ar: `مصروف ${tag}`,
    name_en: `Exp ${tag}`,
  });
  const yearNum = 2100 + (parseInt(tag.slice(0, 3), 16) % 900);
  const yearStmt = buildScopedInsert(colMap, "invoice_years", cid, { year: yearNum });
  await client.query(`${yearStmt.sql} on conflict do nothing`, yearStmt.params);
  const cardId = `card-${tag}`;
  const cardStmt = buildScopedInsert(colMap, "card_visibility", cid, {
    card_id: cardId,
    is_visible: true,
  });
  await client.query(cardStmt.sql, cardStmt.params);

  // 3. Properties, buildings, units, maintenance
  const propertyId = await insertRow(client, colMap, "properties", cid, {
    code: `P-${tag}`,
    name_ar: `عقار ${tag}`,
  });
  const buildingId = await insertRow(client, colMap, "buildings", cid, {
    code: `B-${tag}`,
    property_id: propertyId,
    category_id: buildingCategoryId,
    name_ar: `مبنى ${tag}`,
  });
  const unitId = await insertRow(client, colMap, "units", cid, {
    code: `U-${tag}`,
    property_id: propertyId,
    building_id: buildingId,
    name: `وحدة ${tag}`,
  });
  const maintenanceId = await insertRow(client, colMap, "maintenance_requests", cid, {
    code: `M-${tag}`,
    property_id: propertyId,
    building_id: buildingId,
    unit_id: unitId,
    title: `صيانة ${tag}`,
  });

  // 4. Landing & media
  const mediaId = await insertRow(client, colMap, "landing_media", cid, {
    storage_path: `companies/${cid}/landing/${tag}.jpg`,
    mime_type: "image/jpeg",
    category: "gallery",
  });
  const landingSettingsId = await insertRow(client, colMap, "landing_page_settings", cid, {
    locale: "ar",
    hero_title: `عنوان ${tag}`,
    hero_subtitle: "وصف",
    about_title: "عن الشركة",
    about_body: "تفاصيل",
    leasing_title: "التأجير",
    leasing_body: "تفاصيل",
  });
  const landingSectionId = await insertRow(client, colMap, "landing_page_sections", cid, {
    section_key: `sec-${tag}`,
    enabled: true,
  });
  const landingSlideId = await insertRow(client, colMap, "landing_carousel_slides", cid, {
    media_id: mediaId,
    title_ar: `شريحة ${tag}`,
    title_en: `Slide ${tag}`,
  });
  const leasingInquiryId = await insertRow(client, colMap, "leasing_inquiries", cid, {
    name: `مستفسر ${tag}`,
    phone: `5000${tag.slice(0, 4)}`,
    email: `lead-${tag}@example.com`,
  });

  // 5. Contracts, concessions, brands, tenant_documents
  const contractId = await insertRow(client, colMap, "contracts", cid, {
    code: `C-${tag}`,
    tenant_id: tenantId,
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    monthly_amount: 500,
  });
  const contractUnitId = await insertRow(client, colMap, "contract_units", cid, {
    contract_id: contractId,
    unit_id: unitId,
    monthly_amount: 500,
  });
  const contractExtraId = await insertRow(client, colMap, "contract_extra_charges", cid, {
    contract_id: contractId,
    category_id: expenseCategoryId,
    amount: 25,
  });
  const concessionId = await insertRow(
    client,
    colMap,
    "concessions",
    cid,
    {
      contract_id: contractId,
      type: "fixed_discount",
      discount_amount: 50,
      start_date: "2026-01-01",
      end_date: "2026-03-01",
    },
    "id",
    { type: "public.concession_types" },
  );
  const brandId = await insertRow(client, colMap, "commercial_brands", cid, {
    property_id: propertyId,
    unit_id: unitId,
    name_original: `Brand ${tag}`,
    name_ar: `علامة ${tag}`,
    name_en: `Brand ${tag}`,
    slug: `brand-${tag}`,
  });
  const cbcStmt = buildScopedInsert(colMap, "commercial_brand_contracts", cid, {
    brand_id: brandId,
    contract_id: contractId,
  });
  await client.query(cbcStmt.sql, cbcStmt.params);
  const tenantDocId = await insertRow(
    client,
    colMap,
    "tenant_documents",
    cid,
    {
      tenant_id: tenantId,
      contract_id: contractId,
      type: "civil_id",
      storage_path: `companies/${cid}/tenants/${tag}.pdf`,
    },
    "id",
    { type: "public.tenant_document_types" },
  );

  const ops = await seedCompanyOpsGroup(client, colMap, {
    cid,
    tag,
    adminId,
    tenantId,
    propertyId,
    buildingId,
    unitId,
    contractId,
    concessionId,
    expenseCategoryId,
  });

  const ids: SeededCompanyIds = {
    propertyId,
    buildingId,
    unitId,
    tenantId,
    contractId,
    contractUnitId,
    contractExtraId,
    customRoleId,
    crPermId,
    userCustomRoleId,
    userRoleId: userRoleRow.id,
    rolePermId,
    rpPermCode,
    permCode,
    userTenantId,
    auditLogId,
    failedAttemptKey,
    failedAttemptWindow,
    optionListId,
    optionItemId,
    buildingCategoryId,
    expenseCategoryId,
    yearNum,
    cardId,
    maintenanceId,
    mediaId,
    landingSettingsId,
    landingSectionId,
    landingSlideId,
    leasingInquiryId,
    brandId,
    concessionId,
    tenantDocId,
    domainId: domainRow.id,
    ...ops,
  };

  return {
    company,
    colMap,
    ids,
    targets: buildCompanyMatrixTargets(company, ids, colMap),
  };
}
