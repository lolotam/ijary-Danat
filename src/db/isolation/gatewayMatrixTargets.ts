import { randomUUID } from "node:crypto";

import {
  makeTarget,
  type ColumnSetMap,
  type CompanyTableTarget,
} from "@/db/isolation/seedGraphHelpers";

/**
 * نص مشفّر وهمي بصيغة hex التي يقبلها `bytea` — لا يحمل أي مفتاح حقيقي.
 * طوله 32 بايت (كتلة AES-256-GCM)، ولا تُقرأ منه سوى قيمة `last4`.
 */
const MATRIX_SECRET_CIPHERTEXT_HEX = `\\x${"00".repeat(32)}`;

/** متجه ابتدائي AES-256-GCM: 12 بايت كما يفرض القيد `octet_length(iv) = 12`. */
const MATRIX_SECRET_IV_HEX = `\\x${"00".repeat(12)}`;

/** وسم مصادقة AES-256-GCM: 16 بايت كما يفرض القيد `octet_length(auth_tag) = 16`. */
const MATRIX_SECRET_AUTH_TAG_HEX = `\\x${"00".repeat(16)}`;

/**
 * يبني أهداف مصفوفة العزل لجدولي `gateway_connections` و`company_secrets`.
 *
 * `authenticated` لا يملك أي منحة على `company_secrets` ولا منحة كتابة على
 * `gateway_connections`، فرفض PostgreSQL كل محاولة بخطأ `42501` قبل أن تصل
 * إلى سياسة RLS — تماماً كما يحدث مع جداول الخدمة مثل `job_requests`.
 * ويكفي أن يثبت الاختبار أن المستخدم لا يقرأ صف الشركة الأخرى ولا يعدّله ولا
 * يحذفه ولا يُدرج صفاً لشركة أخرى.
 */
export function buildGatewayMatrixTargets(
  companyId: string,
  colMap: ColumnSetMap,
): CompanyTableTarget[] {
  const targets: CompanyTableTarget[] = [];

  if (colMap.has("gateway_connections")) {
    targets.push(
      makeTarget(
        "gateway_connections",
        "company_id",
        companyId,
        "last_test_message",
        "mutated",
        () => ({
          values: {
            // مزوّد مختلف عن المزروع في البذر حتى لا يتصادم القيد
            // `unique (company_id, provider)` لو سمحت الصلاحيات بالإدراج يوماً.
            provider: "tap",
            mode: "test",
            is_active: false,
            last_test_ok: false,
            credentials_version: 1,
          },
        }),
      ),
    );
  }

  // السر المملوك لبوابة الدفع لا يوجد إلا بوجود صف بوابة، لذا يحتاج الجدولين معاً.
  if (colMap.has("gateway_connections") && colMap.has("company_secrets")) {
    targets.push(
      makeTarget("company_secrets", "company_id", companyId, "last4", "wxyz", () => ({
        values: {
          owner_kind: "gateway",
          // `owner_id` بلا مفتاح أجنبي في قاعدة البيانات، ومعرّف عشوائي يكفي:
          // الإدراج يُرفض عند فحص الصلاحيات قبل أي قيد أو سياسة.
          owner_id: randomUUID(),
          name: "api_key",
          ciphertext: MATRIX_SECRET_CIPHERTEXT_HEX,
          iv: MATRIX_SECRET_IV_HEX,
          auth_tag: MATRIX_SECRET_AUTH_TAG_HEX,
          key_version: 1,
          last4: "abcd",
        },
        casts: { ciphertext: "bytea", iv: "bytea", auth_tag: "bytea" },
      })),
    );
  }

  return targets;
}
