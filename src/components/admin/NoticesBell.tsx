import { Bell } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Notice } from "@/fns/notices";
import { useMarkNoticeRead, useNotices } from "@/hooks/useNotices";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";

/**
 * عنوان الإشعار: مفتاحه في قاموس الترجمة، أو نوع المهمة الخام إن لم يكن معرّفاً.
 *
 * A notice written by a job this build does not know still has to read as
 * something: the raw kind is better than a blank line or a raw key.
 */
function noticeTitle(t: (key: string) => string, notice: Notice): string {
  const translated = t(notice.titleKey);
  return translated === notice.titleKey ? notice.kind : translated;
}

/**
 * لون شارة المستوى: أخضر للنجاح،أحمر للخطأ.
 */
function levelBadgeClass(level: Notice["level"]): string {
  return level === "error"
    ? "bg-destructive/10 text-destructive"
    : "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400";
}

/**
 * جرس إشعارات المهام الخلفية في ترويسة لوحة الإدارة.
 *
 * Shows how many notices are unread and lists them: the title the notice
 * carries, its level, and when it arrived. Choosing a notice marks it read.
 */
export function NoticesBell() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const enabled = !permissions.isLoading && permissions.isStaff;
  const noticesQuery = useNotices(enabled);
  const markRead = useMarkNoticeRead();

  const notices = noticesQuery.data ?? [];
  const unreadCount = notices.filter((notice) => notice.readAt === null).length;

  if (!permissions.isStaff) return null;

  const dateFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative shrink-0 pointer-coarse:size-11"
          title={t("notices.badge")}
          aria-label={t("notices.badge")}
        >
          <Bell className="size-4" />
          {unreadCount > 0 && (
            <span className="absolute -end-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-destructive-foreground">
              {unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{t("notices.title")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {notices.length === 0 ? (
          <DropdownMenuItem disabled className="text-muted-foreground">
            {t("notices.empty")}
          </DropdownMenuItem>
        ) : (
          notices.map((notice) => (
            <DropdownMenuItem
              key={notice.id}
              onSelect={() => markRead.mutate(notice.id)}
              className="flex flex-col items-start gap-0.5"
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span
                  className={`truncate text-xs ${
                    notice.readAt === null ? "font-bold" : "font-medium text-muted-foreground"
                  }`}
                >
                  {noticeTitle(t, notice)}
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${levelBadgeClass(
                    notice.level,
                  )}`}
                >
                  {t(`notices.level.${notice.level}`)}
                </span>
              </span>
              <span className="text-[10px] text-muted-foreground">
                {dateFormatter.format(new Date(notice.createdAt))}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
