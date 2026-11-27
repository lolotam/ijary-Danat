import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireStaff } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json, Tables } from "@/integrations/supabase/database.types";

/**
 * أقصى عدد إشعارات يعرضها الجرس؛ نفس الحدّ في الاستعلام وفي النتيجة.
 */
const NOTICE_LIMIT = 20;

/**
 * إشعار واحد كما يراه صاحب الطلب: ما يكفي لعرض عنوانه ومستواه وتاريخه.
 */
export interface Notice {
  id: string;
  /** نوع المهمة التي أنتجت الإشعار، مثل `invoices.generate`. */
  kind: string;
  /** مفتاح عنوان في قاموس الترجمة؛ يُعرض نوع المهمة الخام إن لم يكن معرّفاً. */
  titleKey: string;
  /** جسم الإشعار: عدّادات النتيجة حين تحملها، وإلا `{}`. */
  body: Json;
  level: "success" | "error";
  readAt: string | null;
  createdAt: string;
}

const markNoticeReadSchema = z.object({
  id: z.string().uuid(),
});

/** صف الإشعار كما تقرؤه قاعدة البيانات. */
type NoticeRow = Pick<
  Tables<"user_notices">,
  "id" | "kind" | "title_key" | "body" | "level" | "read_at" | "created_at"
>;

/**
 * يحوّل صف الإشعار إلى ما يراه العميل: أسماء أعمدة مريحة بدل أسماء snake_case.
 */
function toNotice(row: NoticeRow): Notice {
  return {
    id: row.id,
    kind: row.kind,
    titleKey: row.title_key,
    body: row.body,
    level: row.level,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/**
 * يرتّب الإشعارات: غير المقروءة أولاً، ثم الأحدث فالأقدم.
 *
 * The query already asks PostgREST for that order, but the promise belongs to
 * the function: the caller receives the unread notices first whatever the
 * database handed back.
 */
function byUnreadThenNewest(first: Notice, second: Notice): number {
  if (first.readAt === null && second.readAt !== null) return -1;
  if (first.readAt !== null && second.readAt === null) return 1;
  return second.createdAt.localeCompare(first.createdAt);
}

/**
 * يجلب إشعارات الموظف الحالي: غير المقروءة أولاً ثم الأحدث، بحدّ أقصى ٢٠ إشعاراً.
 *
 * The caller's own session client does the filtering. RLS (`user_id = auth.uid()`
 * plus the company check) is the only gate, so neither another user's notices
 * nor another company's can reach the result — no `companyClient` here, because
 * a company-scoped client would see every notice of the company.
 */
export const myNotices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Notice[]> => {
    await requireStaff(context, {
      attempted: "notice.list",
      refusal: "You do not have permission to read background-work notices.",
    });

    const { data, error } = await context.supabase
      .from("user_notices")
      .select("id, kind, title_key, body, level, read_at, created_at")
      .order("read_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(NOTICE_LIMIT);

    if (error) throw new Error(`Notices read failed: ${error.message}`);

    return (data ?? []).map(toNotice).sort(byUnreadThenNewest).slice(0, NOTICE_LIMIT);
  });

/**
 * يعلّم إشعاراً كمقروء.
 *
 * The update writes `read_at` and nothing else, and RLS limits it to the
 * caller's own rows: a row that belongs to somebody else matches no row at
 * all, and the function stays silent rather than say which case it was.
 */
export const markNoticeRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(markNoticeReadSchema)
  .handler(async ({ data, context }): Promise<void> => {
    await requireStaff(context, {
      attempted: "notice.mark_read",
      refusal: "You do not have permission to update background-work notices.",
    });

    // PostgREST cannot evaluate `now()` inside an update body, so the app
    // server's clock writes the timestamp.
    const { error } = await context.supabase
      .from("user_notices")
      .update({ read_at: new Date().toISOString() })
      .eq("id", data.id);

    if (error) throw new Error(`Notice read update failed: ${error.message}`);
  });
