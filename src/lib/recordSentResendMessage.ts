import type { Json } from "@/integrations/supabase/database.types";

/** بادئة معرّف الرسالة لصفوف Resend في جدول الصندوق. */
const RESEND_MESSAGE_ID_PREFIX = "resend:";

/**
 * يسجّل الرسالة المُرسَلة عبر Resend في جدول الصندوق الموحّد.
 *
 * `direction` is written explicitly and never left to the default. The column is
 * nullable and the list treats null as *received*, so an omitted value here
 * would invent an inbound Resend message — the one illusion this feature must
 * not create, since no inbound path exists.
 *
 * `message_id` is namespaced `resend:<id>` so it cannot collide with a Gmail
 * row keyed on an RFC Message-ID, and so the row joins to
 * `email_webhook_events.provider_message_id` when a delivery event arrives.
 */
export async function recordSentResendMessage(input: {
  bcc: string[];
  body: string;
  cc: string[];
  companyId?: string;
  from: string;
  resendId: string;
  source: "resendMailboxSend" | "dispatchNotification";
  subject: string;
  to: string[];
}): Promise<void> {
  // استيراد ديناميكي حتى لا يتسرب عميل الخادم إلى حزمة المتصفح.
  const { serverCompanyClient } = await import("@/company/companyClient.server");
  const { companyId, client } = serverCompanyClient(input.companyId);

  const now = new Date().toISOString();
  const rawPayload = {
    id: input.resendId,
    cc: input.cc,
    bcc: input.bcc,
    // Which screen produced the row. Both the manual compose form and the
    // notification dispatcher record here now, and triage cannot tell an
    // automated send from something an admin typed without it.
    source: input.source,
  } as unknown as Json;

  const { error } = await client.from("gmail_messages").upsert(
    {
      company_id: companyId,
      message_id: `${RESEND_MESSAGE_ID_PREFIX}${input.resendId}`,
      thread_id: null,
      from_address: input.from,
      to_address: input.to.join(", ") || null,
      subject: input.subject || null,
      snippet: input.body.slice(0, 200) || null,
      body_text: input.body || null,
      received_at: now,
      is_read: true,
      direction: "sent",
      provider: "resend",
      raw_payload: rawPayload,
    },
    { onConflict: "company_id,message_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
}
