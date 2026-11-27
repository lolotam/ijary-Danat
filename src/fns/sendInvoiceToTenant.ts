import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { enqueueJob } from "@/jobs/enqueue";
import type { QueuedDocumentJob } from "@/jobs/handlers/documents";

/**
 * يرسل فاتورة واحدة إلى مستأجرها فور الطلب عبر البريد و/أو واتساب.
 *
 * The request no longer sends anything: it validates, checks the permission,
 * reads the invoice, and hands one `invoice.send` job per channel to the
 * worker (contracts/jobs.md section 1). The document is rendered and the
 * message delivered there, so a slow PDF render cannot hold the browser and a
 * provider that is down cannot fail the admin's click.
 *
 * One job per channel because the catalogue payload carries a single channel:
 * the job that renders the invoice is the job that knows which leg to write.
 * An admin may send the same invoice as many times as they like — no dedupe
 * key, because a resend on purpose must not be stopped by a key left over
 * from the first send.
 *
 * The locale follows the tenant's preferred language: the catalogue payload
 * carries ids only, so a per-send override could not travel with the job.
 */
const schema = z.object({
  invoiceId: z.string().uuid(),
  channels: z.array(z.enum(["email", "whatsapp"])).min(1),
});

export const sendInvoiceToTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.update",
      attempted: "invoice.send_to_tenant",
      refusal: "You do not have permission to update an invoice.",
    });

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    // The invoice is read here so a request for an invoice that is not this
    // company's fails here, in the request, and not in a job that would fail
    // a minute later with nothing on screen to say which invoice it was.
    const invoiceRes = await db.from("invoices").select("id").eq("id", data.invoiceId).single();
    if (invoiceRes.error || !invoiceRes.data) {
      throw new Error(invoiceRes.error?.message ?? "Invoice not found");
    }

    const jobRequestIds: string[] = [];
    for (const channel of data.channels) {
      const { jobId } = await enqueueJob(db, "invoice.send", {
        invoiceId: invoiceRes.data.id,
        channel,
      });
      jobRequestIds.push(jobId);
    }

    return { queued: true, jobRequestIds } satisfies QueuedDocumentJob;
  });
