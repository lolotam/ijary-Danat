import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import type {
  Database,
  Tables,
  WhatsappConnectionStatus,
} from "@/integrations/supabase/database.types";

/**
 * حالة جلسة Evolution لكل شركة: إعداد المزوّد وصفّ اتصال واتساب النشط.
 *
 * The QR session lives in `whatsapp_connections` (migration 333): one row per
 * company and method, the `evolution_qr` row carrying the instance name and the
 * live status. The legacy `evolution_connections` singleton is gone from this
 * path — it was one row for the whole deployment, so a second company paired
 * its number on top of the first one's.
 */

/**
 * الرسالة التي تصف الإجراء المطلوب من المدير حين لا توجد جلسة QR مقترنة.
 *
 * One sentence for every path that refuses to send: the delivery layer, the
 * inbox composer and the "delete for everyone" action all park on the same
 * human fix, and the admin reads one wording wherever the refusal appears.
 */
export const NO_QR_SESSION_MESSAGE =
  "No WhatsApp QR session has been paired. Scan the QR code in Settings → Integrations.";

/**
 * الرسالة التي تصف الإجراء المطلوب حين تكون الجلسة موجودة لكنها مغلقة.
 */
export const NO_OPEN_SESSION_MESSAGE =
  "No open WhatsApp session. Scan the QR code in Settings → Integrations first.";

/** صفّ اتصال واتساب بعموداته المستعملة في مسارات الإرسال والمزامنة. */
export interface EvolutionQrConnection {
  id: string;
  instance_name: string | null;
  status: WhatsappConnectionStatus;
}

/**
 * يقرأ إعداد مزوّد evolution_api (سواء كان مفعّلاً أم لا).
 *
 * The QR card must work BEFORE the provider is enabled — pairing first, then
 * flipping the toggle is the natural admin order — so this reads the seeded
 * row regardless of is_enabled.
 */
export async function loadEvolutionProviderConfig(
  explicitCompanyId?: string,
): Promise<Tables<"provider_configs">> {
  const companyId = explicitCompanyId ?? requireRequestCompany().id;
  const result = await companyClient(companyId)
    .from("provider_configs")
    .select("*")
    .eq("provider", "evolution_api")
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) {
    throw new Error("The evolution_api provider row is missing. Apply migrations 177-178 first.");
  }
  return result.data;
}

/**
 * يقرأ اتصال واتساب الخاص بالشركة من `whatsapp_connections`، أو null إن لم يوجد.
 *
 * The company filter is written out on top of the RLS scope, and `method`
 * pins the QR link, so neither a Cloud API row nor another company's row can
 * be read through this path. Without `connectionId` the company's ACTIVE
 * connection is read; with it, that one connection — still scoped to the
 * company.
 */
export async function loadQrConnection(
  client: SupabaseClient<Database>,
  companyId: string,
  options?: { connectionId?: string },
): Promise<EvolutionQrConnection | null> {
  let query = client
    .from("whatsapp_connections")
    .select("id, instance_name, status")
    .eq("company_id", companyId)
    .eq("method", "evolution_qr")
    .eq("is_active", true);

  if (options?.connectionId) {
    query = query.eq("id", options.connectionId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to load WhatsApp connection: ${error.message}`);
  return data;
}
