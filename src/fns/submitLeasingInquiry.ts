import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z as zod } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { clientAddress } from "@/lib/clientAddress";
import { rateLimitPublicForm } from "@/lib/publicFormGuard";

// Exported because the landing form derives its own validation from it
// (audit M23), and because the server-fn test harness stubs `.validator()`.
export const leasingSchema = zod.object({
  name: zod.string().min(1, "Name is required").max(200),
  company_name: zod.string().max(200).optional().nullable(),
  business_activity: zod.string().max(200).optional().nullable(),
  phone: zod.string().min(8, "Phone number must be at least 8 digits").max(24),
  email: zod.string().email("Invalid email address").max(320),
  preferred_size: zod.string().max(100).optional().nullable(),
  preferred_contact_method: zod.string().max(30).optional().nullable(),
  message: zod.string().max(2000).optional().nullable(),
  locale: zod.enum(["ar", "en"]),
  source: zod.string().max(50).optional().nullable(),
  // Honeypot — rendered invisibly on the public form; humans leave it empty.
  website: zod.string().max(0).optional(),
});

export type SubmitLeasingInquiryInput = zod.infer<typeof leasingSchema>;

export const submitLeasingInquiry = createServerFn({ method: "POST" })
  .validator(leasingSchema)
  .handler(async ({ data }) => {
    const request = getRequest();
    // A missing address must not fail the request open: every such caller
    // shares the one "unknown" bucket, so the limit still applies.
    const ip = clientAddress(request) ?? "unknown";

    if (rateLimitPublicForm("leasing", ip)) {
      throw new Error("Too many inquiries. Please try again later.");
    }

    // Fetch company_id
    const { data: company, error: companyError } = await supabaseAdmin
      .from("companies")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (companyError || !company) {
      console.error("Error fetching company for leasing inquiry:", companyError);
      throw new Error("Company settings not configured.");
    }

    const { error } = await supabaseAdmin.from("leasing_inquiries" as any).insert({
      company_id: company.id,
      name: data.name,
      company_name: data.company_name ?? null,
      business_activity: data.business_activity ?? null,
      phone: data.phone,
      email: data.email,
      preferred_size: data.preferred_size ?? null,
      preferred_contact_method: data.preferred_contact_method ?? null,
      message: data.message ?? null,
      locale: data.locale,
      status: "new",
      source: data.source ?? null,
    });

    if (error) {
      console.error("Error inserting leasing inquiry:", error);
      throw new Error("Failed to submit leasing inquiry. Please try again later.");
    }

    return { success: true };
  });
