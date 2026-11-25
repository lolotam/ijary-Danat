import type { NotificationProvider } from "@/integrations/supabase/database.types";

/**
 * مزوّدو واتساب بترتيب الأفضلية، والأول منهم هو المسار المُفضّل حالياً.
 *
 * Only one may be enabled at a time — a database trigger enforces it — so the
 * order declares intent rather than resolving a conflict. Exported so the
 * dispatcher's selector and the admin screens' availability hint read the same
 * list: a provider added to one and not the other is a screen that lies about
 * whether a message can be sent.
 */
export const WHATSAPP_PROVIDERS: readonly NotificationProvider[] = [
  "evolution_api",
  "postora",
  "whatsapp_cloud_api",
  "twilio",
];
