import { Link } from "@tanstack/react-router";
import { ArrowLeft, Pencil, UserPlus } from "lucide-react";

import { ChatAvatar, chatInitials } from "@/components/admin/whatsapp/WhatsAppChatList";
import { Button } from "@/components/ui/button";
import { LtrText } from "@/components/ui/ltr-text";
import type { ContactTenantLink } from "@/hooks/useWhatsAppInbox";
import type { WhatsappChatRow } from "@/integrations/supabase/database.types";
import { useI18n } from "@/i18n/provider";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

interface WhatsAppThreadHeaderProps {
  chatNumber: string;
  /** The chat row, absent for a number that has no thread on record yet. */
  chat: WhatsappChatRow | null;
  tenant: ContactTenantLink | null;
  /** The open chat has no named contact — the button offers to create one. */
  needsContact: boolean;
  canEditContacts: boolean;
  onBack: () => void;
  onEditContact: () => void;
}

/**
 * ترويسة المحادثة المفتوحة: الصورة والاسم، ومعه الرقم والمستأجر المرتبط.
 *
 * The tenant link is the point of the row under the name: an admin reading a
 * thread is one click from the record it is about, instead of copying the
 * number into the tenants search. Number and tenant name both carry the link
 * because both are the same answer to "who is this" — and neither links when
 * the contact has no tenant on it.
 */
export function WhatsAppThreadHeader({
  chatNumber,
  chat,
  tenant,
  needsContact,
  canEditContacts,
  onBack,
  onEditContact,
}: WhatsAppThreadHeaderProps) {
  const { t, locale } = useI18n();
  const contactLabel = needsContact
    ? t("inbox.whatsapp.addToContacts")
    : t("inbox.whatsapp.editContact");
  const phone = <LtrText>{`+${chatNumber}`}</LtrText>;

  return (
    <div className="flex items-center gap-2 border-b bg-primary/10 px-3 py-2">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label={t("common.back")}
        onClick={onBack}
      >
        <ArrowLeft className="size-4 rtl:-scale-x-100" />
      </Button>
      <ChatAvatar
        avatarUrl={chat?.avatar_url ?? null}
        initials={chat ? chatInitials(chat) : chatNumber.slice(-2)}
        className="size-11"
      />
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
        {/* Fills the header rather than hugging the name: the bar is the
            thread's identity, and a chip sized to the text reads as a stray
            badge floating in an empty strip. */}
        <p className="w-full truncate rounded-full bg-primary/85 px-3 py-1 text-center text-base font-bold text-primary-foreground shadow-sm sm:text-lg">
          {chat?.display_name || phone}
        </p>
        {/* Number at the start of the line, tenant at the end — logical
            properties, so on the Arabic RTL page the number sits right and the
            tenant left, and the pair mirrors in English. */}
        <div className="flex w-full items-center justify-between gap-3 text-xs">
          {tenant ? (
            <Link
              to="/admin/tenants/$id"
              params={{ id: tenant.id }}
              className="text-primary underline-offset-2 hover:underline"
            >
              {phone}
            </Link>
          ) : (
            <span className="text-muted-foreground">{phone}</span>
          )}
          {tenant ? (
            <Link
              to="/admin/tenants/$id"
              params={{ id: tenant.id }}
              className="truncate font-medium text-primary underline-offset-2 hover:underline"
            >
              {tenantDisplayName(tenant, locale)}
            </Link>
          ) : null}
        </div>
      </div>
      {canEditContacts ? (
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          title={contactLabel}
          aria-label={contactLabel}
          onClick={onEditContact}
        >
          {needsContact ? <UserPlus className="size-4" /> : <Pencil className="size-4" />}
        </Button>
      ) : null}
    </div>
  );
}
