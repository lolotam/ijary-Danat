import type { NotificationProvider } from "@/integrations/supabase/database.types";

/**
 * القناة التي يسلّم عبرها كل مزوّد.
 *
 * The enable switches are exclusive *within* a channel — turning Resend on turns
 * SMTP off, and the same for the three WhatsApp providers — so grouping by
 * channel is what makes that rule visible rather than something an admin
 * discovers from a toast after the fact.
 */
export function providerChannel(provider: NotificationProvider): "email" | "whatsapp" {
  return provider === "resend" || provider === "smtp" ? "email" : "whatsapp";
}
