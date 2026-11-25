import { useEffect, useState } from "react";
import { MessageSquareText, TriangleAlert, Users } from "lucide-react";
import { toast } from "sonner";

import { WhatsAppChatList } from "@/components/admin/whatsapp/WhatsAppChatList";
import { WhatsAppComposer } from "@/components/admin/whatsapp/WhatsAppComposer";
import {
  splitContactName,
  WhatsAppContactDialog,
  type ContactDraft,
} from "@/components/admin/whatsapp/WhatsAppContactDialog";
import { WhatsAppContacts } from "@/components/admin/whatsapp/WhatsAppContacts";
import { WhatsAppThread } from "@/components/admin/whatsapp/WhatsAppThread";
import { WhatsAppThreadHeader } from "@/components/admin/whatsapp/WhatsAppThreadHeader";
import { DeleteConfirmation } from "@/components/admin/Phase2Ui";
import { Button } from "@/components/ui/button";
import { useEvolutionConnection } from "@/hooks/useEvolutionConnection";
import { usePermissions } from "@/hooks/usePermissions";
import {
  useDeleteWhatsAppChat,
  useWhatsAppChats,
  useWhatsAppContacts,
} from "@/hooks/useWhatsAppInbox";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

interface WhatsAppInboxTabProps {
  /** `?chat=<number>` from the inbox URL — opens that thread on arrival. */
  deepLinkChat?: string | null;
  enabled: boolean;
  canSend: boolean;
  canEditContacts: boolean;
}

/**
 * تبويب واتساب في صندوق الوارد: لوحان بأسلوب واتساب ويب، مع تبديل إلى قسم
 * جهات الاتصال ولافتة عند انقطاع الجلسة.
 *
 * On narrow screens the two panes collapse into list-or-thread navigation —
 * selecting a chat shows the thread with a back control, mirroring WhatsApp's
 * own phone layout. All state is local; deep-linking stays on the inbox tab
 * level (?tab=whatsapp) like the other sources.
 */
export function WhatsAppInboxTab({
  deepLinkChat = null,
  enabled,
  canSend,
  canEditContacts,
}: WhatsAppInboxTabProps) {
  const { t } = useI18n();
  const [view, setView] = useState<"chats" | "contacts">("chats");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [selectedChat, setSelectedChat] = useState<string | null>(deepLinkChat);
  // Follows the param rather than only seeding from it: arriving from a tenant
  // while the inbox is already mounted changes the URL without remounting, and
  // a seed-only initial state would leave the previous thread on screen.
  useEffect(() => {
    if (deepLinkChat) {
      setSelectedChat(deepLinkChat);
      setView("chats");
    }
  }, [deepLinkChat]);

  const connection = useEvolutionConnection(enabled);
  const chats = useWhatsAppChats(enabled && view === "chats", debouncedSearch);
  const sessionOpen = connection.data?.last_connection_state === "open";
  const [addContactDraft, setAddContactDraft] = useState<ContactDraft | null>(null);
  const deleteChat = useDeleteWhatsAppChat();
  const [deleteChatTarget, setDeleteChatTarget] = useState<string | null>(null);
  const permissions = usePermissions();
  const canDeleteChats = permissions.can("notifications.delete");

  async function confirmDeleteChat() {
    if (!deleteChatTarget) return;
    try {
      await deleteChat.mutateAsync(deleteChatTarget);
      if (selectedChat === deleteChatTarget) setSelectedChat(null);
      setDeleteChatTarget(null);
      toast.success(t("inbox.whatsapp.chatDeleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  const selected = (chats.data ?? []).find((chat) => chat.chat_number === selectedChat) ?? null;
  // Is the open chat already a NAMED contact? The directory is checked
  // directly — the merged display_name can also be a WhatsApp push name.
  const selectedContactLookup = useWhatsAppContacts(enabled && !!selectedChat, selectedChat ?? "");
  const selectedContact =
    selectedContactLookup.data?.find((contact) => contact.phone === selectedChat) ?? null;
  const selectedNeedsContact = !!selectedChat && !selectedContact?.name?.trim();

  function openChat(chatNumber: string) {
    setSelectedChat(chatNumber);
    setView("chats");
  }

  /**
   * يجهز مسودة حوار جهة الاتصال للمحادثة المفتوحة — إضافة لرقم جديد
   * وتعديلًا لرقم مخزّن من الزر نفسه في الترويسة.
   *
   * الاسم المخزّن عمود واحد فيُقسم لأول/عائلة، وبقية الحقول تُقرأ من
   * دليل جهات الاتصال (لا من سجل المحادثة) فيُفتح التعديل مملوءًا
   * ببيانات جهة الاتصال نفسها.
   */
  function buildContactDraft(): ContactDraft | null {
    if (!selectedChat) return null;
    return {
      id: selectedContact?.id,
      phone: `+${selectedChat}`,
      ...splitContactName(selectedContact?.name),
      commercialName: selectedContact?.commercial_name ?? "",
      email: selectedContact?.email ?? "",
      notes: selectedContact?.notes ?? "",
      tenantId: selectedContact?.tenant_id ?? "",
      contractIds: selectedContact?.contracts.map((contract) => contract.id) ?? [],
      avatarUrl: selected?.avatar_url ?? selectedContact?.avatar_url ?? null,
    };
  }

  return (
    <div className="flex h-[calc(100dvh-16rem)] min-h-[420px] flex-col overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <Button
          size="sm"
          variant={view === "chats" ? "secondary" : "ghost"}
          onClick={() => setView("chats")}
        >
          <MessageSquareText className="size-4" />
          {t("inbox.whatsapp.chats")}
        </Button>
        <Button
          size="sm"
          variant={view === "contacts" ? "secondary" : "ghost"}
          onClick={() => setView("contacts")}
        >
          <Users className="size-4" />
          {t("inbox.whatsapp.contacts")}
        </Button>
        {!connection.isLoading && !sessionOpen ? (
          <span className="ms-auto flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="size-3.5" />
            {t("inbox.whatsapp.disconnectedBanner")}
          </span>
        ) : null}
      </div>

      {view === "contacts" ? (
        <WhatsAppContacts enabled={enabled} canEdit={canEditContacts} onOpenChat={openChat} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "w-full shrink-0 border-e md:w-[340px]",
              selectedChat ? "hidden md:block" : "block",
            )}
          >
            <WhatsAppChatList
              chats={chats.data ?? []}
              isLoading={chats.isLoading}
              selectedChat={selectedChat}
              onSelectChat={setSelectedChat}
              onDeleteChat={
                canDeleteChats ? (chat) => setDeleteChatTarget(chat.chat_number) : undefined
              }
              search={search}
              onSearchChange={setSearch}
            />
          </div>

          <div className={cn("min-w-0 flex-1 flex-col", selectedChat ? "flex" : "hidden md:flex")}>
            {selectedChat ? (
              <>
                <WhatsAppThreadHeader
                  chatNumber={selectedChat}
                  chat={selected}
                  tenant={selectedContact?.tenant ?? null}
                  needsContact={selectedNeedsContact}
                  canEditContacts={canEditContacts}
                  onBack={() => setSelectedChat(null)}
                  onEditContact={() => setAddContactDraft(buildContactDraft())}
                />
                <WhatsAppThread chatNumber={selectedChat} canSend={canSend} />
                {canSend ? (
                  <WhatsAppComposer chatNumber={selectedChat} disabled={!sessionOpen} />
                ) : null}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center bg-muted/30">
                <p className="text-sm text-muted-foreground">{t("inbox.whatsapp.selectChat")}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <WhatsAppContactDialog initial={addContactDraft} onClose={() => setAddContactDraft(null)} />

      <DeleteConfirmation
        open={deleteChatTarget !== null}
        pending={deleteChat.isPending}
        title={t("inbox.whatsapp.deleteChat")}
        description={t("inbox.whatsapp.deleteChatDescription")}
        close={() => setDeleteChatTarget(null)}
        confirm={() => void confirmDeleteChat()}
      />
    </div>
  );
}
