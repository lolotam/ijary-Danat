import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Download, MessageSquareText, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ChatAvatar } from "@/components/admin/whatsapp/WhatsAppChatList";
import {
  splitContactName,
  WhatsAppContactDialog,
  type ContactDraft,
} from "@/components/admin/whatsapp/WhatsAppContactDialog";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { contactSortValue } from "@/components/admin/whatsapp/contactSortValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDebounce } from "@/hooks/useDebounce";
import {
  useDeleteWhatsAppContact,
  useExportWhatsAppContacts,
  useWhatsAppContacts,
  type WhatsAppContactWithContracts,
} from "@/hooks/useWhatsAppInbox";
import { useI18n } from "@/i18n/provider";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

const EMPTY_DRAFT: ContactDraft = {
  phone: "",
  firstName: "",
  lastName: "",
  commercialName: "",
  email: "",
  notes: "",
  tenantId: "",
  contractIds: [],
  avatarUrl: null,
};

interface WhatsAppContactsProps {
  enabled: boolean;
  canEdit: boolean;
  onOpenChat: (chatNumber: string) => void;
}

/**
 * قسم جهات الاتصال: قائمة قابلة للبحث، إضافة وتعديل وحذف، وتصدير الكل CSV.
 *
 * Numbers auto-captured from incoming chats already live here (the ingestion
 * RPC inserts them); this view lets the admin put names and details on them.
 */
export function WhatsAppContacts({ enabled, canEdit, onOpenChat }: WhatsAppContactsProps) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState("");
  // القيمة المهدّأة تغذي الاستعلام فقط، فلا ينطلق طلب شبكة مع كل ضغطة مفتاح.
  const debouncedSearch = useDebounce(search);
  const contacts = useWhatsAppContacts(enabled, debouncedSearch);
  // Sorts what the query returned (500 rows at most) rather than pushing an
  // order param through the hook — the same trade the other admin tables make.
  const { sort, toggle, sorted } = useTableSort(
    contacts.data ?? [],
    (contact, key) => contactSortValue(contact, key, locale),
    { key: null, direction: "asc" },
    [locale],
  );
  const remove = useDeleteWhatsAppContact();
  const exportCsv = useExportWhatsAppContacts();
  const [draft, setDraft] = useState<ContactDraft | null>(null);

  function startEdit(contact: WhatsAppContactWithContracts) {
    setDraft({
      id: contact.id,
      phone: contact.phone,
      ...splitContactName(contact.name),
      commercialName: contact.commercial_name ?? "",
      email: contact.email ?? "",
      notes: contact.notes ?? "",
      tenantId: contact.tenant_id ?? "",
      contractIds: contact.contracts.map((contract) => contract.id),
      avatarUrl: contact.avatar_url,
    });
  }

  async function onDelete(id: string) {
    try {
      await remove.mutateAsync(id);
      toast.success(t("inbox.whatsapp.contactDeleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  async function onExport() {
    try {
      const { count } = await exportCsv.mutateAsync();
      toast.success(`${t("inbox.whatsapp.exported")} (${count})`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("inbox.whatsapp.searchContacts")}
          className="h-9 max-w-xs"
        />
        <div className="ms-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={exportCsv.isPending} onClick={onExport}>
            <Download className="size-4" />
            {t("inbox.whatsapp.exportCsv")}
          </Button>
          {canEdit ? (
            <Button size="sm" onClick={() => setDraft(EMPTY_DRAFT)}>
              <Plus className="size-4" />
              {t("inbox.whatsapp.addContact")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-center">#</TableHead>
              <SortableHead sortKey="name" sort={sort} toggle={toggle}>
                {t("inbox.whatsapp.contactName")}
              </SortableHead>
              <SortableHead sortKey="commercial_name" sort={sort} toggle={toggle}>
                {t("inbox.whatsapp.contactCommercialName")}
              </SortableHead>
              <SortableHead sortKey="tenant" sort={sort} toggle={toggle}>
                {t("inbox.whatsapp.contactTenant")}
              </SortableHead>
              <SortableHead sortKey="contracts" sort={sort} toggle={toggle}>
                {t("inbox.whatsapp.contactContracts")}
              </SortableHead>
              <SortableHead sortKey="phone" sort={sort} toggle={toggle}>
                {t("inbox.whatsapp.contactPhone")}
              </SortableHead>
              <SortableHead sortKey="email" sort={sort} toggle={toggle}>
                {t("inbox.whatsapp.contactEmail")}
              </SortableHead>
              <SortableHead sortKey="notes" sort={sort} toggle={toggle}>
                {t("inbox.whatsapp.contactNotes")}
              </SortableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {contacts.isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  {t("common.loading")}
                </TableCell>
              </TableRow>
            ) : sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  {t("inbox.whatsapp.noContacts")}
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((contact, index) => (
                <TableRow key={contact.id}>
                  <TableCell className="w-12 text-center font-mono text-xs text-muted-foreground">
                    {index + 1}
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <ChatAvatar
                        avatarUrl={contact.avatar_url}
                        initials={(contact.name ?? contact.phone).slice(0, 2)}
                        className="size-8 text-xs"
                      />
                      <span className="truncate">{contact.name ?? "—"}</span>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-44 truncate">
                    {contact.commercial_name ?? "—"}
                  </TableCell>
                  <TableCell className="max-w-44 truncate">
                    {contact.tenant ? (
                      <Link
                        to="/admin/tenants/$id"
                        params={{ id: contact.tenant.id }}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {tenantDisplayName(contact.tenant, locale)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {contact.contracts.length ? (
                      <div className="flex flex-wrap gap-1">
                        {contact.contracts.map((contract) => (
                          <Link
                            key={contract.id}
                            to="/admin/contracts"
                            search={{ q: contract.code }}
                            className="rounded-md border px-1.5 py-0.5 text-xs text-primary underline-offset-2 hover:underline"
                            dir="ltr"
                          >
                            {contract.code}
                          </Link>
                        ))}
                      </div>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="text-primary underline-offset-2 hover:underline"
                      onClick={() => onOpenChat(contact.phone)}
                    >
                      <LtrText>{`+${contact.phone}`}</LtrText>
                    </button>
                  </TableCell>
                  <TableCell>{contact.email ? <LtrText>{contact.email}</LtrText> : "—"}</TableCell>
                  <TableCell className="max-w-56 truncate">{contact.notes ?? "—"}</TableCell>
                  <TableCell className="text-end">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("inbox.whatsapp.messageContact")}
                        onClick={() => onOpenChat(contact.phone)}
                      >
                        <MessageSquareText className="size-4 text-primary" />
                      </Button>
                      {canEdit ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("inbox.whatsapp.editContact")}
                            onClick={() => startEdit(contact)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("common.delete")}
                            disabled={remove.isPending}
                            onClick={() => void onDelete(contact.id)}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <WhatsAppContactDialog
        initial={draft}
        onClose={() => setDraft(null)}
        onSaved={(phone) => {
          // A freshly added contact was almost certainly added to be messaged —
          // jump straight into their chat, like tapping a new contact in WhatsApp.
          if (!draft?.id) onOpenChat(phone);
        }}
      />
    </div>
  );
}
