import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { enqueueNotification } from "@/fns/enqueueNotification";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildTenantCredentialMessage } from "@/fns/notifyUserCredentials";
import { type EmailLocale } from "@/lib/emailTemplates";
import { requireRole } from "@/fns/requirePermission";

/**
 * Queue a "tenant portal credentials" message via Email and/or WhatsApp.
 * Inserts into notifications and dispatches through the provider pipeline.
 */

const schema = z.object({
  tenantId: z.string().uuid(),
  username: z.string().min(1),
  password: z.string().min(1),
  channels: z.array(z.enum(["email", "whatsapp"])).min(1),
  locale: z.enum(["ar", "en"]).optional(),
});

export const sendTenantCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    await requireRole(context, "admin", {
      attempted: "tenant.send_credentials",
      refusal: "Only an admin may send a tenant their portal credentials.",
    });

    const tenantRes = await supabaseAdmin
      .from("tenants")
      .select("id, name, email, whatsapp, mobile, preferred_language")
      .eq("id", data.tenantId)
      .single();
    if (tenantRes.error || !tenantRes.data) {
      throw new Error(tenantRes.error?.message ?? "Tenant not found");
    }
    const tenant = tenantRes.data;
    const locale: EmailLocale = (data.locale ?? tenant.preferred_language ?? "ar") as EmailLocale;

    const portalUrl = process.env.PUBLIC_APP_URL
      ? `${process.env.PUBLIC_APP_URL.replace(/\/$/, "")}/portal`
      : "/portal";

    // The same builder the automatic path uses, so a resend shows exactly what
    // the original mail showed and both honour the editable template.
    const template = await buildTenantCredentialMessage({
      locale,
      tenantName: tenant.name,
      portalUrl,
      fields: {
        displayName: tenant.name,
        username: data.username,
        password: data.password,
        email: tenant.email,
        mobile: tenant.whatsapp ?? tenant.mobile,
      },
    });

    const inserted: string[] = [];

    for (const channel of data.channels) {
      const recipient = channel === "email" ? tenant.email : (tenant.whatsapp ?? tenant.mobile);
      if (!recipient) continue;

      const row = await enqueueNotification({
        type: "user_credentials",
        channel,
        audience: "tenant",
        locale,
        tenantId: tenant.id,
        subject: channel === "email" ? template.subject : null,
        body: channel === "email" ? template.html : template.whatsapp,
        recipientAddress: recipient,
        templateCode: "user-credentials",
        payload: { recipient, template_key: "tenant_credentials", username: data.username },
      });
      // Same rule as the invoice dialog: the template's channel overrides the
      // admin's checkbox. This manual resend is gated, unlike the automatic
      // provisioning mail in notifyUserCredentials — here an admin is present
      // to see a shorter `queued` list and adjust the template.
      if (row) inserted.push(row.id);
    }

    return { queued: inserted };
  });
