import { z } from "zod";

import { GATEWAY_PROVIDERS, type GatewayProvider } from "@/gateways/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { PlatformGatewayLaunchRow } from "@/integrations/supabase/database.types";

import { writePlatformAudit } from "./audit";
import { requirePlatformAdmin } from "./requirePlatformAdmin.server";

/**
 * مخطط تعديل السماح بالوضع الفعلي لمزوّد بوابة دفع على مستوى المنصة (SC-012).
 */
export const setGatewayLiveAllowedSchema = z.object({
  provider: z.enum(GATEWAY_PROVIDERS),
  allowed: z.boolean(),
  checklistNote: z.string().trim().max(500).nullable().optional(),
});

/** مدخل تعديل حالة الإطلاق الفعلي لمزوّد بوابة دفع. */
export type SetGatewayLiveAllowedInput = z.infer<typeof setGatewayLiveAllowedSchema>;

/**
 * حالة إطلاق مزوّد مع عدد الشركات التي تعمل عليه حالياً في الوضع الفعلي.
 *
 * Turning the flag off never changes those connections (owner decision,
 * 2026-11-27), so the panel shows the count to make that visible.
 */
export type GatewayLaunchStatus = PlatformGatewayLaunchRow & { live_connections: number };

/**
 * يرتّب صفوف `platform_gateway_launch` وفق الترتيب القياسي للمزوّدين ويملأ أي صف غائب بقيمة افتراضية آمنة.
 */
function normalizeLaunchRows(
  rows: readonly PlatformGatewayLaunchRow[],
): PlatformGatewayLaunchRow[] {
  const byProvider = new Map<GatewayProvider, PlatformGatewayLaunchRow>();
  for (const row of rows) {
    byProvider.set(row.provider, row);
  }
  return GATEWAY_PROVIDERS.map(
    (provider) =>
      byProvider.get(provider) ?? {
        provider,
        live_allowed: false,
        checklist_note: null,
        updated_by: null,
        updated_at: new Date(0).toISOString(),
      },
  );
}

/**
 * يسرد حالة السماح بالوضع الفعلي لجميع مزوّدي بوابات الدفع لعرضها على مشرف المنصة.
 */
export async function platformListGatewayLaunch(): Promise<GatewayLaunchStatus[]> {
  await requirePlatformAdmin();

  const { data, error } = await supabaseAdmin
    .from("platform_gateway_launch")
    .select("*")
    .order("provider");

  if (error) {
    throw new Error(`platform_gateway_launch lookup failed: ${error.message}`);
  }
  const liveCounts = await countLiveConnections();
  return normalizeLaunchRows(data ?? []).map((row) => ({
    ...row,
    live_connections: liveCounts.get(row.provider) ?? 0,
  }));
}

/**
 * يعدّ اتصالات الشركات القائمة في الوضع الفعلي لكل مزوّد.
 *
 * `gateway_connections` is unique on `(company_id, provider)`, so one row per
 * provider is one company.
 */
async function countLiveConnections(): Promise<Map<GatewayProvider, number>> {
  const { data, error } = await supabaseAdmin
    .from("gateway_connections")
    .select("provider")
    .eq("mode", "live");
  if (error) {
    throw new Error(`gateway_connections live count failed: ${error.message}`);
  }
  const counts = new Map<GatewayProvider, number>();
  for (const row of data ?? []) {
    counts.set(row.provider, (counts.get(row.provider) ?? 0) + 1);
  }
  return counts;
}

/**
 * يحدّث إذن الوضع الفعلي لمزوّد بوابة دفع ويسجّل سطر تدقيق بالقيمة قبل وبعد (SC-012).
 *
 * The platform-admin guard runs before any database read or write (SC-015),
 * and a no-op request writes neither a table row nor an audit entry.
 */
export async function platformSetGatewayLiveAllowed(
  input: SetGatewayLiveAllowedInput,
): Promise<PlatformGatewayLaunchRow> {
  const { userId: actorId } = await requirePlatformAdmin();
  const { provider, allowed, checklistNote } = setGatewayLiveAllowedSchema.parse(input);

  const { data: existing, error: readError } = await supabaseAdmin
    .from("platform_gateway_launch")
    .select("*")
    .eq("provider", provider)
    .maybeSingle();

  if (readError) {
    throw new Error(`platform_gateway_launch lookup failed: ${readError.message}`);
  }

  const nextNote = checklistNote !== undefined ? checklistNote : (existing?.checklist_note ?? null);
  if (existing && existing.live_allowed === allowed && existing.checklist_note === nextNote) {
    return existing;
  }

  const { data: updated, error: upsertError } = await supabaseAdmin
    .from("platform_gateway_launch")
    .upsert(
      {
        provider,
        live_allowed: allowed,
        checklist_note: nextNote,
        updated_by: actorId,
      },
      { onConflict: "provider" },
    )
    .select("*")
    .single();

  if (upsertError) {
    throw new Error(`platform_gateway_launch upsert failed: ${upsertError.message}`);
  }

  await writePlatformAudit({
    action: "gateway.live_allowed.update",
    entity: "gateway_launch",
    entityId: provider,
    actorId,
    before: existing
      ? {
          provider,
          live_allowed: existing.live_allowed,
          checklist_note: existing.checklist_note,
        }
      : null,
    after: {
      provider,
      live_allowed: updated.live_allowed,
      checklist_note: updated.checklist_note,
    },
  });

  return updated;
}
