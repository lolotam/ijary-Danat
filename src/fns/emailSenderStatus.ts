import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getEmailSenderStatus } from "@/fns/emailSender.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

/*
 * واجهة المتصفح لمُرسِل البريد: الأنواع، والثوابت، ودالة الخادم التي تقرأ الحالة.
 *
 * The sender logic decrypts company credentials, so it lives in
 * `emailSender.server.ts`, which the browser bundle never loads; this module
 * keeps only what the settings screen and the webhook route import.
 */

export type {
  EmailProviderKind,
  EmailProviderRow,
  EmailSenderMode,
  EmailSenderProvider,
  EmailSenderStatus,
  ResolvedEmailSender,
} from "@/fns/emailSender.server";

/** اسم سرّ توقيع 웹 هوك Resend داخل `company_secrets`. */
export const RESEND_WEBHOOK_SECRET_NAME = "webhook_secret";

const statusInput = z.object({ locale: z.enum(["ar", "en"]) });

/**
 * يُعيد حالة مُرسِل البريد للشركة الحالية، وصلاحية التكاملات شرط لقراءتها.
 *
 * A server function rather than a browser read: whether the platform's default
 * sender is configured is a fact about the server's environment, and the
 * browser cannot know it.
 */
export const emailSenderStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => statusInput.parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "settings.integrations",
      attempted: "email_sender.status",
      refusal: "Forbidden: you do not have permission to view the email sender.",
    });
    return getEmailSenderStatus(requireRequestCompany().id, data.locale);
  });
