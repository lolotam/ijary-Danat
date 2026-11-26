import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { deliverEvolutionNotification } from "@/fns/evolutionDelivery";
import { companyInstanceName } from "@/fns/evolutionSession";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { evolutionClientFromConfig } from "@/lib/providers/evolution";
import { toInternationalDigits } from "@/lib/providers/types";
import { type PermissionContext, requirePermission } from "@/fns/requirePermission";

/**
 * خادم صندوق واتساب: إرسال من الملحن، تعليم المقروء، وإدارة جهات الاتصال.
 *
 * The composer refuses to send unless evolution_api is the ENABLED WhatsApp
 * provider â€” sending through a provider the admins believe is off would make
 * the providers card a lie. Delivery itself goes through the same
 * deliverEvolutionNotification the notification dispatcher uses, so policy
 * (instance resolution, pacing, inbox recording) cannot diverge between the
 * two paths.
 */

/** يرفض طلب صندوق واتساب إن لم يملك المستخدم الصلاحية، بعد تسجيل الرفض. */
async function assertPermission(context: PermissionContext, code: string): Promise<void> {
  await requirePermission(context, {
    code,
    attempted: "whatsapp.chat",
    refusal: "You do not have permission to use the WhatsApp inbox.",
  });
}

/**
 * يعيد إعداد مزوّد evolution_api إن كان هو مزوّد واتساب المفعّل، وإلا يرفض.
 */
export async function requireEnabledEvolutionConfig() {
  const result = await companyClient(requireRequestCompany().id)
    .from("provider_configs")
    .select("*")
    .eq("provider", "evolution_api")
    .eq("is_enabled", true)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) {
    throw new Error(
      "Evolution API is not the enabled WhatsApp provider. Enable it in Settings â†’ Automations â†’ Providers before sending from the inbox.",
    );
  }
  return result.data;
}

const sendSchema = z.object({
  chatNumber: z.string().min(8),
  body: z.string().trim().min(1).max(4096),
});

/**
 * يرسل رسالة نصية من ملحن صندوق الدردشة إلى رقم المحادثة.
 */
export const sendWhatsAppChatMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(sendSchema)
  .handler(async ({ data, context }) => {
    await assertPermission(context, "notifications.send");
    const config = await requireEnabledEvolutionConfig();
    const result = await deliverEvolutionNotification({
      body: data.body,
      config: config.config,
      from: config.from_whatsapp,
      to: data.chatNumber,
    });
    return { messageId: result.messageId };
  });

const markReadSchema = z.object({
  chatNumber: z.string().min(8),
  /** Newest message the reader actually saw; guards the read/increment race. */
  seenAt: z.string().datetime({ offset: true }),
});

/**
 * يصفّر عدّاد غير المقروء بشرط ألا تكون رسالة أحدث قد وصلت بعد آخر ما رآه القارئ.
 *
 * Conditional on last_message_at <= seenAt: an inbound message that lands
 * between render and click keeps its unread mark instead of being silently
 * swallowed by a blind zero-write.
 */
export const markWhatsAppChatRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(markReadSchema)
  .handler(async ({ data, context }) => {
    await assertPermission(context, "notifications.update");
    const result = await companyClient(requireRequestCompany().id)
      .from("whatsapp_chats")
      .update({ unread_count: 0 })
      .eq("chat_number", data.chatNumber);
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

const contactSchema = z.object({
  id: z.string().uuid().optional(),
  phone: z.string().min(8),
  name: z.string().trim().max(200).optional(),
  commercialName: z.string().trim().max(200).optional(),
  email: z.string().trim().email().optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional(),
  tenantId: z.string().uuid().nullable().optional(),
  /** Replaces the contact's contract links wholesale when provided. */
  contractIds: z.array(z.string().uuid()).max(100).optional(),
});

/**
 * يضيف أو يعدّل جهة اتصال؛ الرقم يُطبَّع إلى أرقام دولية مجردة قبل الحفظ.
 */
export const saveWhatsAppContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(contactSchema)
  .handler(async ({ data, context }) => {
    await assertPermission(context, "notifications.update");
    const db = companyClient(requireRequestCompany().id);
    const phone = toInternationalDigits(data.phone);
    const values = {
      phone,
      name: data.name || null,
      commercial_name: data.commercialName || null,
      email: data.email || null,
      notes: data.notes || null,
      tenant_id: data.tenantId ?? null,
    };
    const result = data.id
      ? await db.from("whatsapp_contacts").update(values).eq("id", data.id).select("id").single()
      : await db
          .from("whatsapp_contacts")
          .upsert(values, { onConflict: "phone" })
          .select("id")
          .single();
    if (result.error) throw new Error(result.error.message);

    // Contract links are replaced as a set: the form always submits the full
    // selection, so delete-then-insert mirrors exactly what the admin sees.
    if (data.contractIds) {
      const cleared = await db
        .from("whatsapp_contact_contracts")
        .delete()
        .eq("contact_id", result.data.id);
      if (cleared.error) throw new Error(cleared.error.message);
      if (data.contractIds.length) {
        const linked = await db.from("whatsapp_contact_contracts").insert(
          data.contractIds.map((contractId) => ({
            contact_id: result.data.id,
            contract_id: contractId,
          })),
        );
        if (linked.error) throw new Error(linked.error.message);
      }
    }
    return { id: result.data.id };
  });

const deleteMessageSchema = z.object({
  messageId: z.string().min(8),
  mode: z.enum(["forMe", "forEveryone"]),
});

const deleteChatSchema = z.object({ chatNumber: z.string().min(8) });

/**
 * يحذف رسالة واحدة — إما من الصندوق فقط أو من واتساب أيضاً.
 *
 * "forMe" يحذف الصف من whatsapp_messages فقط (إخفاء محلي). "forEveryone"
 * يستدعي Evolution أولاً ليحذفها من واتساب (يظهر "تم حذف هذه الرسالة" لدى
 * الطرف الآخر) ثم يحذف الصف محلياً. فشل الحذف للجميع لا يمنع الحذف المحلي
 * إذا كانت الرسالة قديمة أو محذوفة مسبقاً على واتساب.
 */
export const deleteWhatsAppMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(deleteMessageSchema)
  .handler(async ({ data, context }) => {
    await assertPermission(context, "notifications.delete");
    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);
    const row = await db
      .from("whatsapp_messages")
      .select("message_id, chat_number, direction")
      .eq("message_id", data.messageId)
      .maybeSingle();
    if (row.error) throw new Error(row.error.message);
    if (!row.data) throw new Error("Message not found.");

    if (data.mode === "forEveryone") {
      if (row.data.direction !== "outbound") {
        throw new Error("Only outbound messages can be deleted for everyone.");
      }
      try {
        const config = await requireEnabledEvolutionConfig();
        const client = evolutionClientFromConfig(config.config);
        // Never a name from config or a literal: either could be another
        // company's instance on the shared Evolution server (T052s).
        const instanceName = companyInstanceName(companyId);
        await client.deleteMessageForEveryone(instanceName, {
          id: row.data.message_id,
          remoteJid: `${toInternationalDigits(row.data.chat_number)}@s.whatsapp.net`,
          fromMe: true,
        });
      } catch (error) {
        // If Evolution says the message is too old or already deleted, still
        // remove it locally — the admin's intent is to clear the inbox.
        const message = error instanceof Error ? error.message : String(error);
        const isOldMessage =
          message.toLowerCase().includes("not found") ||
          message.toLowerCase().includes("too old") ||
          message.toLowerCase().includes("already");
        if (!isOldMessage) throw error;
      }
    }

    const deleted = await db.from("whatsapp_messages").delete().eq("message_id", data.messageId);
    if (deleted.error) throw new Error(deleted.error.message);
    return { ok: true };
  });

/**
 * يحذف خيط محادثة كاملاً: كل رسائله وصف قائمة المحادثات.
 *
 * The contact stays — deleting a conversation is housekeeping, not
 * forgetting the person. Cached media files in the bucket also stay, so a
 * message forwarded elsewhere before the delete keeps its file. Messages go
 * first: if that fails the chat row survives and the thread remains visible
 * rather than orphaning invisible rows.
 */
export const deleteWhatsAppChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(deleteChatSchema)
  .handler(async ({ data, context }) => {
    await assertPermission(context, "notifications.delete");
    const db = companyClient(requireRequestCompany().id);
    const messages = await db.from("whatsapp_messages").delete().eq("chat_number", data.chatNumber);
    if (messages.error) throw new Error(messages.error.message);
    const chat = await db.from("whatsapp_chats").delete().eq("chat_number", data.chatNumber);
    if (chat.error) throw new Error(chat.error.message);
    return { ok: true };
  });

const deleteContactSchema = z.object({ id: z.string().uuid() });

/**
 * يحذف جهة اتصال محفوظة (لا يمس المحادثات أو الرسائل).
 */
export const deleteWhatsAppContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(deleteContactSchema)
  .handler(async ({ data, context }) => {
    await assertPermission(context, "notifications.update");
    const result = await companyClient(requireRequestCompany().id)
      .from("whatsapp_contacts")
      .delete()
      .eq("id", data.id);
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

/**
 * يحصّن خلية CSV: اقتباس RFC 4180 وتحييد صيغ جداول البيانات.
 *
 * A cell beginning with = + - @ executes as a formula when the file opens in
 * Excel; prefixing an apostrophe is the standard neutralisation and survives
 * round-tripping.
 */
function csvCell(value: string | null): string {
  const text = value ?? "";
  const neutralized = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

/**
 * يصدّر كل جهات الاتصال كملف CSV (بترويسة UTF-8 BOM ليقرأ Excel العربية سليمة).
 *
 * Server-side and paged so "export all" really means all rows, not the page
 * the client happened to have loaded.
 */
export const exportWhatsAppContactsCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPermission(context, "notifications.read");

    const db = companyClient(requireRequestCompany().id);
    const rows: Array<{
      phone: string;
      name: string | null;
      commercial_name: string | null;
      email: string | null;
      notes: string | null;
      created_at: string;
    }> = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const page = await db
        .from("whatsapp_contacts")
        .select("phone, name, commercial_name, email, notes, created_at")
        .order("created_at", { ascending: true })
        .range(from, from + pageSize - 1);
      if (page.error) throw new Error(page.error.message);
      rows.push(...(page.data ?? []));
      if (!page.data || page.data.length < pageSize) break;
    }

    const header = ["phone", "name", "commercial_name", "email", "notes", "created_at"];
    const lines = [
      header.join(","),
      ...rows.map((row) =>
        [
          csvCell(row.phone),
          csvCell(row.name),
          csvCell(row.commercial_name),
          csvCell(row.email),
          csvCell(row.notes),
          csvCell(row.created_at),
        ].join(","),
      ),
    ];
    // \uFEFF is the UTF-8 BOM â€” without it Excel misreads Arabic as Windows-1256.
    return { csv: `${"\uFEFF"}${lines.join("\r\n")}`, count: rows.length };
  });
