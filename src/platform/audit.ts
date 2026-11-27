// كاتب سجل تدقيق المنصة: كل إجراء سوبر أدمن يُكتب مرة واحدة ولا يُعدَّل بعدها.
//
// The table is insert-only in the database (migration 317): no role holds
// UPDATE or DELETE on it and a trigger refuses both, so this writer only ever
// inserts.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/database.types";

/** أي مفتاح يوحي بسرٍّ؛ `api_key` يشمله `key`. */
const SECRET_KEY_PATTERN = /secret|token|password|key/i;

/** سطر واحد في سجل تدقيق المنصة. */
export interface PlatformAuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  companyId?: string | null;
  actorId?: string | null;
  before?: Json | null;
  after?: Json | null;
  ip?: string | null;
  requestId?: string | null;
}

/**
 * يزيل حقول الأسرار من حمولة التدقيق في كل المستويات.
 *
 * SC-015 asks for zero secret values in the log, and the payload of a platform
 * action can carry a gateway credential, a token or a password. The key is
 * dropped whole: a redacted value would still say how long the secret was.
 */
function stripSecretFields(payload: Json | null | undefined): Json | null {
  if (payload === null || payload === undefined) {
    return null;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => stripSecretFields(item));
  }

  if (typeof payload !== "object") {
    return payload;
  }

  const kept: Record<string, Json> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SECRET_KEY_PATTERN.test(key)) {
      kept[key] = stripSecretFields(value);
    }
  }
  return kept;
}

/**
 * يكتب سطراً في سجل تدقيق المنصة بعد تجريد الحمولة من الأسرار.
 *
 * This is the only way a platform action reaches the log, and it throws when
 * the insert fails: an action that cannot be audited must not look audited
 * (SC-015).
 */
export async function writePlatformAudit(entry: PlatformAuditEntry): Promise<void> {
  const { error } = await supabaseAdmin.from("platform_audit_log").insert({
    actor_id: entry.actorId ?? null,
    company_id: entry.companyId ?? null,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entityId ?? null,
    before: stripSecretFields(entry.before),
    after: stripSecretFields(entry.after),
    ip: entry.ip ?? null,
    request_id: entry.requestId ?? null,
  });

  if (error) {
    throw new Error(`Platform audit write failed: ${error.message}`);
  }
}
