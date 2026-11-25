import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";

import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { toChatNumber } from "@/lib/whatsappLink";

/**
 * رابط يفتح محادثة واتساب لرقم معيّن داخل صندوق الوارد.
 *
 * The chat number travels in the URL rather than in a click handler because the
 * inbox owns the thread, and a param is what survives a new tab, a refresh, and
 * a middle click. A number the gateway could never dial renders nothing at all
 * (or its `children` unlinked) — an admin clicking through to an empty thread
 * they cannot send from is worse than no link.
 */
export function WhatsAppChatLink({
  phone,
  children,
  className,
  stopRowActivation = false,
}: {
  phone: string | null | undefined;
  /** Omit for the icon-only form used in headers and next to a name. */
  children?: ReactNode;
  className?: string;
  /**
   * Set inside a table row or card that navigates on activation. It stops the
   * click AND the Enter/Space keydown from reaching the row: the row's key
   * handler calls preventDefault(), which cancels this link's own activation,
   * so a keyboard user could never reach the chat without it.
   */
  stopRowActivation?: boolean;
}) {
  const { t } = useI18n();
  const chat = toChatNumber(phone);
  if (!chat) return children ? <>{children}</> : null;
  const label = t("inbox.whatsapp.openChat");
  return (
    <Link
      to="/admin/inbox"
      search={{ tab: "whatsapp" as const, chat }}
      title={label}
      aria-label={children ? undefined : label}
      onClick={stopRowActivation ? (event) => event.stopPropagation() : undefined}
      onKeyDown={
        stopRowActivation
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }
          : undefined
      }
      className={cn("inline-flex items-center gap-1 hover:underline", className)}
    >
      {children ?? <MessageCircle className="size-4" />}
    </Link>
  );
}
