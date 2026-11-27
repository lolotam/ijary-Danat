import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { GATEWAY_PROVIDERS, type GatewayProvider } from "@/gateways/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/database.types";

/*
 * قراءة جاهزية الدفع الإلكتروني لشركة الطلب من بوابة المستأجر، ومعرّفات
 * اتصالاتها لعرض عنوان الويب هوك في شاشة إعدادات شركة واحدة.
 *
 * كل قراءة تمرّ عبر `companyClient(company.id)`؛ لا تخرج من الخادم إلا إجابة
 * منطقية أو معرّفات الاتصال، ولا يُعرض أي سرّ أو تفاصيل مزوّد أخرى.
 */

/** مفتاح استعلام بوابة المستأجر لجاهزية الدفع الإلكتروني. */
export const PORTAL_PAYMENT_AVAILABILITY_KEY = ["portal-payment-availability"] as const;

/** معرّف اتصال كل مزوّد مهيّأ للشركة الحالية. */
export type GatewayConnectionIdMap = Partial<Record<GatewayProvider, string>>;

/**
 * يبني عميل الشركة المضيفة للقراءة دون السماح بتمرير معرّف شركة من المتصفح.
 */
async function requestCompanyDb(): Promise<SupabaseClient<Database>> {
  const company = requireRequestCompany();
  return companyClient(company.id);
}

/**
 * يخبر بوابة المستأجر إن كان للشركة اتصال دفع إلكتروني نشط واحد على الأقل.
 *
 * A failed read is an error, not `false`: silently reporting "no gateway"
 * would hide the real failure and send the renter to pay at the office for a
 * gateway the company has already activated.
 */
export const portalPaymentAvailability = createServerFn({ method: "GET" }).handler(
  async (): Promise<boolean> => {
    const db = await requestCompanyDb();
    const { data, error } = await db
      .from("gateway_connections")
      .select("id")
      .eq("is_active", true)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read active payment gateway: ${error.message}`);
    }
    return data !== null;
  },
);

/**
 * يعيد معرّفات اتصالات البوابات المهيّأة لعرض عناوين الويب هوك في الإعدادات.
 *
 * `gatewayList` exposes previews only, so the settings card needs this one
 * non-secret id to build the provider's webhook URL after a save. It carries
 * the same integrations permission as the settings page.
 */
export const gatewayConnectionIds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<GatewayConnectionIdMap> => {
    await requirePermission(context as never, {
      code: "settings.integrations",
      attempted: "gateway.list_connection_ids",
      refusal: "You do not have permission to view payment gateway settings.",
    });
    const db = await requestCompanyDb();
    const { data, error } = await db.from("gateway_connections").select("id, provider");
    if (error) {
      throw new Error(`Failed to read gateway connection ids: ${error.message}`);
    }

    const ids: GatewayConnectionIdMap = {};
    for (const row of data ?? []) {
      if (GATEWAY_PROVIDERS.includes(row.provider)) {
        ids[row.provider] = row.id;
      }
    }
    return ids;
  });
