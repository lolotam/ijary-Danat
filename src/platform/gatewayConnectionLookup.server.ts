import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { GATEWAY_PROVIDERS, type GatewayProvider } from "@/gateways/types";

/**
 * يجد الشركة المالكة لاتصال بوابة دفع من معرّفه وحده، لمسار الويب هوك العام.
 *
 * A gateway webhook arrives with no session and no company host, so the
 * connection id in the URL is the only way to learn which company it belongs
 * to. This lookup is the one platform-client read that path needs: it returns
 * the owner and provider and nothing else — the secrets are read afterwards
 * through `companyClient(companyId)`, under the company's own RLS.
 */
export async function lookupGatewayConnectionOwner(
  connectionId: string,
): Promise<{ companyId: string; provider: GatewayProvider } | null> {
  const { data, error } = await supabaseAdmin
    .from("gateway_connections")
    .select("company_id, provider")
    .eq("id", connectionId)
    .maybeSingle();

  if (error) {
    throw new Error(`gateway connection lookup failed: ${error.message}`);
  }
  if (!data || !(GATEWAY_PROVIDERS as readonly string[]).includes(data.provider)) {
    return null;
  }
  return { companyId: data.company_id, provider: data.provider as GatewayProvider };
}
