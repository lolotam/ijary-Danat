import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { CompanyContextError } from "@/company/errors";
import { getRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { COMPANY_INFO_CHANNELS } from "@/jobs/catalog";
import { enqueueJob } from "@/jobs/enqueue";
import type { QueuedDocumentJob } from "@/jobs/handlers/documents";

/**
 * يرسل معلومات الشركة للمستأجر بالبريد و/أو واتساب، مع إرفاق ملف PDF.
 *
 * "Send Company Information" — the request no longer renders anything: it
 * validates, checks the permission, reads the tenant, and hands one
 * `company.info.send` job to the worker (contracts/jobs.md section 1). The
 * letterhead PDF is rendered and the message delivered there.
 *
 * No dedupe key: an admin may send the company information again on purpose.
 *
 * The channels and the language the staff member chose travel in the payload,
 * so the worker sends what was asked for instead of every channel the renter
 * happens to have. A tenant with no contact on any of the chosen channels is
 * refused here rather than in a job that would find nothing to send.
 */
const schema = z.object({
  tenantId: z.string().uuid(),
  channels: z.array(z.enum(COMPANY_INFO_CHANNELS)).min(1),
  locale: z.enum(["ar", "en"]).optional(),
});

export const sendCompanyInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "notifications.send",
      attempted: "notification.send_company_info",
      refusal: "You do not have permission to send notifications.",
    });

    // The request host resolves the company for every company page, but this
    // dialog is also reachable from a host that carries no company context, so
    // the signed-in profile's own company is the fallback — the same order the
    // sender used before the work moved to the worker.
    let companyId = getRequestCompany()?.id;
    if (!companyId) {
      const profile = await context.supabase
        .from("profiles")
        .select("company_id")
        .eq("id", context.userId)
        .maybeSingle();
      if (profile.error) throw new Error(profile.error.message);
      companyId = profile.data?.company_id ?? undefined;
    }
    if (!companyId) {
      throw new CompanyContextError("COMPANY_REQUIRED");
    }
    const db = companyClient(companyId);

    const tenantRes = await db
      .from("tenants")
      .select("id, email, whatsapp, mobile, preferred_language")
      .eq("id", data.tenantId)
      .single();
    if (tenantRes.error || !tenantRes.data) {
      throw new Error(tenantRes.error?.message ?? "Tenant not found");
    }
    const tenant = tenantRes.data;
    const reachable = data.channels.some((channel) =>
      channel === "email" ? Boolean(tenant.email) : Boolean(tenant.whatsapp ?? tenant.mobile),
    );
    if (!reachable) {
      throw new Error("The tenant has no contact on the selected channels.");
    }

    // The language the dialog resolved: the staff member's own pick, or the
    // renter's preferred language when the dialog left it on "auto".
    const language = data.locale ?? tenant.preferred_language ?? "ar";

    const { jobId } = await enqueueJob(db, "company.info.send", {
      tenantId: tenant.id,
      channels: data.channels,
      language,
    });

    return { queued: true, jobRequestIds: [jobId] } satisfies QueuedDocumentJob;
  });
