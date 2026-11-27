import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildFinalMessage } from "@/fns/resolveTemplateVariables.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { LocaleCode, NotificationType } from "@/integrations/supabase/database.types";
import { TEMPLATE_VARIABLES } from "@/lib/templateVariables";
import { requirePermission } from "@/fns/requirePermission";

/**
 * مخطط التحقق من مدخلات بناء الرسالة (المستأجر، القالب، اللغة، العقد).
 *
 * Exported and asserted directly in tests: the createServerFn test mock skips
 * .validator(), so a schema checked only through the server fn never runs.
 */
export const resolveVariablesSchema = z.object({
  tenantId: z.string().uuid(),
  templateCode: z.string().trim().max(120).nullable().optional(),
  locale: z.enum(["ar", "en"]).nullable().optional(),
  contractId: z.string().uuid().nullable().optional(),
  /** Free-text subject override — same field sendNotification accepts. */
  subject: z.string().trim().max(300).nullable().optional(),
  /** Free-text body override — same field sendNotification accepts. */
  body: z.string().trim().max(10000).nullable().optional(),
  /** Explicit variable overrides — must apply on preview and send alike. */
  variables: z.record(z.string()).optional(),
});

export type ResolveVariablesInput = z.infer<typeof resolveVariablesSchema>;

export interface FinalMessage {
  variables: Record<string, string>;
  /** Rendered subject from RAW values (plain SMTP header — never HTML-escaped). */
  subject: string;
  /** Rendered body from HTML-escaped values — exactly what is persisted on the row. */
  bodyHtml: string;
  bodyText: string;
  /** Placeholders present in the template that no value was found for. */
  missing: string[];
  /** Template row actually used — looked up by code, never by locale counterpart. */
  templateCode: string | null;
  templateType: NotificationType | null;
  locale: LocaleCode;
  /**
   * When set, this locale has no active template that could be sent — the
   * preview tab must say so rather than render a message send would reject.
   */
  unavailableReason: string | null;
}

export interface BuildFinalMessageInput extends ResolveVariablesInput {
  /**
   * Optional as-of date (YYYY-MM-DD) for days_overdue / days_until.
   * Defaults to today. Exposed for deterministic tests only.
   */
  asOf?: string | null;
}

/**
 * نقطة دخول الخادم لمعاينة الرسالة — يغلّف buildFinalMessage بصلاحية الإرسال.
 */
export const resolveTemplateVariables = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(resolveVariablesSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "notifications.send",
      attempted: "template.resolve_variables",
      refusal: "You do not have permission to send notifications.",
    });
    return buildFinalMessage(data);
  });

/**
 * مفاتيح الكتالوج لنوع معيّن — للاختبارات والتحقق من التوافق.
 */
export function catalogueKeysFor(type: NotificationType): string[] {
  return (TEMPLATE_VARIABLES[type] ?? []).map((spec) => spec.key);
}
