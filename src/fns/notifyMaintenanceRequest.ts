import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  loadCompanyDefaults,
  notifyAdminEvent,
  renderAdminEmailCopy,
  rowOrThrow,
  type AdminEmailMessage,
  type AdminNotificationResult,
} from "@/fns/adminEmailNotification";
import { requirePermission } from "@/fns/requirePermission";
import { translatorFor } from "@/i18n/dictionary";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Tables } from "@/integrations/supabase/database.types";

const WORKFLOW_KEY = "maintenance-request-created";
const schema = z.object({ requestId: z.string().uuid() });

/** يقرأ اسم الوحدة، أو "-" لطلب غير مرتبط بوحدة. */
async function loadUnitName(unitId: string | null): Promise<string> {
  if (!unitId) return "-";
  const unit = await supabaseAdmin.from("units").select("name").eq("id", unitId).maybeSingle();
  return unit.data?.name ?? "-";
}

/** يبني رسالة طلب الصيانة الجديد وحمولتها. */
async function buildMaintenanceMessage(
  request: Tables<"maintenance_requests">,
): Promise<AdminEmailMessage> {
  const [{ locale }, unitName] = await Promise.all([
    loadCompanyDefaults(),
    loadUnitName(request.unit_id),
  ]);
  const t = translatorFor(locale);
  const copy = await renderAdminEmailCopy({
    code: "maintenance-request",
    locale,
    variables: {
      code: request.code,
      title: request.title,
      unit_name: unitName,
      priority: request.priority,
    },
    fallbackSubject: t("workflows.fallbackSubject.maintenanceRequest"),
    fallbackBody: (safe) =>
      `<p>${safe.code} - ${safe.title}</p><p>${safe.unit_name} - ${safe.priority}</p>`,
  });
  return { copy, payload: { request_id: request.id } };
}

/** يرسل تنبيه طلب الصيانة إلى الإدارة عبر بوابة سير العمل. */
export async function notifyMaintenanceRequestRecord(
  requestId: string,
): Promise<AdminNotificationResult> {
  return notifyAdminEvent(WORKFLOW_KEY, {
    type: "maintenance_request",
    load: async () =>
      rowOrThrow(
        await supabaseAdmin.from("maintenance_requests").select("*").eq("id", requestId).single(),
      ),
    dedupeMatch: { request_id: requestId },
    build: buildMaintenanceMessage,
  });
}

export const notifyMaintenanceRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "maintenance.create",
      attempted: "notification.maintenance_request",
      refusal: "You do not have permission to create a maintenance request.",
    });
    return notifyMaintenanceRequestRecord(data.requestId);
  });
