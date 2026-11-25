import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { notifyContactInquiryRecord } from "@/fns/notifyContactInquiry";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { clientAddress } from "@/lib/clientAddress";
import { rateLimitPublicForm } from "@/lib/publicFormGuard";

// Exported so the honeypot rule can be asserted directly. The server-fn test
// harness stubs `.validator()`, so a test that goes through `submitContactInquiry`
// never runs zod and would pass no matter what this schema says.
export const contactSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Invalid email address").max(320),
  phone: z.string().max(24).optional().nullable(),
  subject: z.string().max(200).optional().nullable(),
  message: z.string().min(1, "Message is required").max(2000),
  // Honeypot — rendered invisibly on the public form; humans leave it empty.
  // Mirrors submitLeasingInquiry:19. Without it, posting request_type=general
  // skipped spam protection entirely.
  website: z.string().max(0).optional(),
});

export type SubmitContactInquiryInput = z.infer<typeof contactSchema>;

export const submitContactInquiry = createServerFn({ method: "POST" })
  .validator(contactSchema)
  .handler(async ({ data }) => {
    const request = getRequest();
    // A missing address must not fail the request open: every such caller
    // shares the one "unknown" bucket, so the limit still applies.
    const ip = clientAddress(request) ?? "unknown";

    if (rateLimitPublicForm("contact", ip)) {
      throw new Error("Too many inquiries. Please try again later.");
    }

    const { data: inserted, error } = await supabaseAdmin
      .from("contact_inquiries")
      .insert({
        name: data.name,
        email: data.email,
        phone: data.phone ?? null,
        subject: data.subject ?? null,
        message: data.message,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Error inserting contact inquiry:", error);
      throw new Error("Failed to submit contact inquiry. Please try again later.");
    }

    // The inquiry is already stored, so a notification outage must not fail the public form.
    try {
      await notifyContactInquiryRecord(inserted.id);
    } catch (notificationError) {
      console.error("notifyContactInquiry failed:", notificationError);
    }

    return { success: true };
  });
