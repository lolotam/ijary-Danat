import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Tables } from "@/integrations/supabase/database.types";

/**
 * مفاتيح توجيه اتصال واتساب: المالك وطريقة الربط وحالته، دون أي سرّ.
 */
export type WhatsappConnectionOwner = Pick<
  Tables<"whatsapp_connections">,
  "id" | "company_id" | "method" | "is_active" | "status" | "instance_name" | "phone_number_id"
>;

const OWNER_COLUMNS = "id, company_id, method, is_active, status, instance_name, phone_number_id";

/**
 * يجد اتصال واتساب ومالكه من معرّف الاتصال وحده، لمسار ويب هوك Evolution العام.
 *
 * A webhook arrives with no session and no company host, so the connection id
 * in the URL is the only way to learn which company it belongs to. Like the
 * gateway lookup, this is the one platform-client read the path needs: it
 * returns routing keys only, and secrets are read afterwards through
 * `companyClient(companyId)` under that company's own RLS.
 */
export async function lookupWhatsappConnectionById(
  connectionId: string,
): Promise<WhatsappConnectionOwner | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .select(OWNER_COLUMNS)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) {
    throw new Error(`whatsapp connection lookup failed: ${error.message}`);
  }
  return data;
}

/**
 * يجد اتصال Cloud API النشط المطابق لمعرّف رقم الهاتف في Meta، لمسار ويب هوك Meta العام.
 *
 * Meta posts every number of the app to one endpoint, so `phone_number_id` is
 * the only routing key. Only an active Cloud API or coexistence connection
 * qualifies; a QR connection never receives Meta deliveries.
 */
export async function lookupActiveCloudConnectionByPhoneNumberId(
  phoneNumberId: string,
): Promise<WhatsappConnectionOwner | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .select(OWNER_COLUMNS)
    .eq("phone_number_id", phoneNumberId)
    .eq("is_active", true)
    .in("method", ["cloud_api", "cloud_coexistence"])
    .maybeSingle();
  if (error) {
    throw new Error(`whatsapp cloud connection lookup failed: ${error.message}`);
  }
  return data;
}
