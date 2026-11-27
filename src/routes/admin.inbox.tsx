import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { guardModuleRoute } from "@/company/requireModule";
import { toast } from "sonner";

import { LeadsTable } from "@/components/admin/inbox/LeadsTable";
import { TenantMessagesTable } from "@/components/admin/inbox/TenantMessagesTable";
import { VisitorMessagesTable } from "@/components/admin/inbox/VisitorMessagesTable";
import { WhatsAppInboxTab } from "@/components/admin/whatsapp/WhatsAppInboxTab";
import { DeleteConfirmation, ModuleHeader } from "@/components/admin/Phase2Ui";
import { useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";
import {
  tenantMessageAttachmentUrl,
  useContactInquiries,
  useDeleteContactInquiries,
  useDeleteTenantMessages,
  useTenantMessages,
  useUpdateContactInquiryStatus,
  useUpdateTenantMessageStatus,
} from "@/hooks/useTenantMessages";
import {
  useDeleteLeasingInquiries,
  useLeasingInquiries,
  useUpdateLeasingInquiry,
} from "@/hooks/useLandingSettings";
import { useGmailMessages } from "@/hooks/useGmailMessages";
import {
  parseInboxSearch,
  type GmailFolder,
  type InboxSearch,
  type InboxTab,
} from "@/lib/inboxSearch";
import { useWhatsAppChats } from "@/hooks/useWhatsAppInbox";
import { useI18n } from "@/i18n/provider";
import { GmailOverlays, GmailTabPanel } from "@/components/admin/inbox/GmailTabPanel";
import { useGmailInbox } from "@/components/admin/inbox/useGmailInbox";

type LeadStatus = "new" | "contacted" | "accepted" | "rejected";

export const Route = createFileRoute("/admin/inbox")({
  beforeLoad: () => guardModuleRoute("inbox"),
  // `?message=<id>` highlights a row and `?tab=<source>` selects the tab that
  // holds it. The header bell links to entries from all four sources, so
  // without the tab it would land every one of them on Tenant messages.
  // `?folder=received|sent` picks the Gmail sub-tab (default received), and
  // `?chat=<number>` opens a WhatsApp thread.
  validateSearch: parseInboxSearch,
  component: InboxPage,
});

/**
 * صفحة صندوق الوارد: رسائل المستأجرين والزوار وطلبات التأجير وGmail.
 *
 * جداول التبويبات الثلاثة الأولى مُستخرجة؛ الاستعلامات تبقى هنا لأن شارات
 * غير المقروء على محفّزات التبويب تعتمد عليها وRadix يُلغي محتوى التبويب غير النشط.
 *
 * The Gmail tab follows the same rule: its markup is `GmailTabPanel` and
 * `GmailOverlays`, but its state is `useGmailInbox`, called here, so a tab
 * switch cannot reset a selection, a filter or an open message (audit M13).
 */
function InboxPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const navigate = Route.useNavigate();
  const {
    message: highlightId,
    tab: tabParam,
    folder: folderParam,
    chat: chatParam,
  } = Route.useSearch();
  // The tab lives in the URL rather than in component state so a bell link can
  // open the right one even when the inbox is already mounted.
  const tab: InboxTab = tabParam ?? "tenants";
  const gmailFolder: GmailFolder = folderParam ?? "received";
  const setTab = (next: string) => {
    navigate({
      search: (prev: InboxSearch) => ({ ...prev, tab: next as InboxTab }),
      replace: true,
    });
  };
  const [selectedTenantIds, setSelectedTenantIds] = useState<Set<string>>(new Set());
  const [selectedInquiryIds, setSelectedInquiryIds] = useState<Set<string>>(new Set());
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set());
  const [deleteTenantIds, setDeleteTenantIds] = useState<string[] | null>(null);
  const [deleteInquiryIds, setDeleteInquiryIds] = useState<string[] | null>(null);
  const [deleteLeadIds, setDeleteLeadIds] = useState<string[] | null>(null);
  const [tenantPage, setTenantPage] = useState(1);
  const [inquiryPage, setInquiryPage] = useState(1);
  const [leadPage, setLeadPage] = useState(1);
  const navigateToFolder = (next: GmailFolder) => {
    navigate({
      search: (prev: InboxSearch) => ({ ...prev, tab: "gmail", folder: next }),
      replace: true,
    });
  };
  const inboxPageSize = 20;
  const staffEnabled = !permissions.isLoading && permissions.isStaff;
  const canReadLeads = staffEnabled && permissions.can(PERMISSIONS.LANDING_PAGE_LEASING_READ);
  const canManageLeads = permissions.can(PERMISSIONS.LANDING_PAGE_LEASING_UPDATE);
  const canDeleteGmail = permissions.can(PERMISSIONS.INBOX_MANAGE);

  // Unread badge counts use a separate status-filtered page so pagination of
  // the full list does not undercount the badge.
  const unreadTenants = useTenantMessages({ page: 1, pageSize: 1, status: "new" }, staffEnabled);
  const unreadInquiries = useContactInquiries(
    { page: 1, pageSize: 1, status: "new" },
    staffEnabled,
  );
  const unreadLeads = useLeasingInquiries({ page: 1, pageSize: 1, status: "new" }, canReadLeads);
  // Outer Gmail badge: all unread (sent rows are inserted read, so this is
  // effectively the received unread total after migration 100).
  const unreadGmail = useGmailMessages({ page: 1, pageSize: 1, isRead: false }, staffEnabled);

  const messages = useTenantMessages({ page: tenantPage, pageSize: inboxPageSize }, staffEnabled);
  const inquiries = useContactInquiries(
    { page: inquiryPage, pageSize: inboxPageSize },
    staffEnabled,
  );
  const leads = useLeasingInquiries({ page: leadPage, pageSize: inboxPageSize }, canReadLeads);
  const gmail = useGmailInbox({
    folder: gmailFolder,
    navigateToFolder,
    enabled: staffEnabled,
    pageSize: inboxPageSize,
  });
  // WhatsApp badge: the chat list itself (limit 200) — one query shared with
  // the tab content through the cache, summed for the trigger badge.
  const whatsappChats = useWhatsAppChats(staffEnabled, "");
  const unreadWhatsappCount = (whatsappChats.data ?? []).reduce(
    (sum, chat) => sum + chat.unread_count,
    0,
  );
  const updateStatus = useUpdateTenantMessageStatus();
  const updateInquiryStatus = useUpdateContactInquiryStatus();
  const deleteMessages = useDeleteTenantMessages();
  const deleteInquiries = useDeleteContactInquiries();
  const deleteLeads = useDeleteLeasingInquiries();
  const updateLead = useUpdateLeasingInquiry();
  const {
    sort,
    toggle,
    sorted: sortedMessages,
  } = useTableSort(messages.data?.items ?? [], (message, key) =>
    key === "tenant"
      ? (message.tenant?.name ?? null)
      : (message as unknown as Record<string, unknown>)[key],
  );

  const dateFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const allTenantSelected = useMemo(() => {
    const ids = sortedMessages.map((m) => m.id);
    return ids.length > 0 && ids.every((id) => selectedTenantIds.has(id));
  }, [sortedMessages, selectedTenantIds]);

  const allInquirySelected = useMemo(() => {
    const ids = (inquiries.data?.items ?? []).map((i) => i.id);
    return ids.length > 0 && ids.every((id) => selectedInquiryIds.has(id));
  }, [inquiries.data?.items, selectedInquiryIds]);

  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!permissions.isStaff) return <p className="text-destructive">{t("common.notAuthorized")}</p>;

  async function openAttachment(path: string) {
    const url = await tenantMessageAttachmentUrl(path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else toast.error(t("common.error"));
  }

  async function markRead(id: string) {
    try {
      await updateStatus.mutateAsync({ id, status: "read" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  /**
   * Moves a lead through its workflow. This control lived on the landing-page
   * settings tab until that tab moved into this inbox without it, which left
   * every lead permanently stuck at 'new'.
   */
  async function updateLeadStatus(id: string, status: LeadStatus) {
    try {
      await updateLead.mutateAsync({ id, updates: { status } });
      toast.success(t("common.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  function toggleTenantId(id: string) {
    setSelectedTenantIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllTenants() {
    if (allTenantSelected) {
      setSelectedTenantIds(new Set());
      return;
    }
    setSelectedTenantIds(new Set(sortedMessages.map((m) => m.id)));
  }

  function toggleInquiryId(id: string) {
    setSelectedInquiryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllInquiries() {
    if (allInquirySelected) {
      setSelectedInquiryIds(new Set());
      return;
    }
    setSelectedInquiryIds(new Set((inquiries.data?.items ?? []).map((i) => i.id)));
  }

  function toggleLeadId(id: string) {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllLeads() {
    const leadItems = leads.data?.items ?? [];
    if (leadItems.length > 0 && leadItems.every((l) => selectedLeadIds.has(l.id))) {
      setSelectedLeadIds(new Set());
      return;
    }
    setSelectedLeadIds(new Set(leadItems.map((l) => l.id)));
  }

  async function confirmDeleteLeads() {
    if (!deleteLeadIds?.length) return;
    try {
      await deleteLeads.mutateAsync(deleteLeadIds);
      setSelectedLeadIds((prev) => {
        const next = new Set(prev);
        deleteLeadIds.forEach((id) => next.delete(id));
        return next;
      });
      setDeleteLeadIds(null);
      toast.success(t("phase2.deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  async function confirmDeleteTenants() {
    if (!deleteTenantIds?.length) return;
    try {
      await deleteMessages.mutateAsync(deleteTenantIds);
      setSelectedTenantIds((prev) => {
        const next = new Set(prev);
        deleteTenantIds.forEach((id) => next.delete(id));
        return next;
      });
      setDeleteTenantIds(null);
      toast.success(t("phase2.deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  async function confirmDeleteInquiries() {
    if (!deleteInquiryIds?.length) return;
    try {
      await deleteInquiries.mutateAsync(deleteInquiryIds);
      setSelectedInquiryIds((prev) => {
        const next = new Set(prev);
        deleteInquiryIds.forEach((id) => next.delete(id));
        return next;
      });
      setDeleteInquiryIds(null);
      toast.success(t("phase2.deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  // Each tab badges its OWN source. The consolidated total across sources lives
  // on the header bell (InboxBell) — showing it here too made every unread Gmail
  // message count twice, once on Gmail and once on Tenant messages.
  // Counts come from dedicated unread queries so pagination of the list cannot
  // undercount badges.
  const unreadTenantCount = unreadTenants.data?.count ?? 0;
  const unreadLeadCount = unreadLeads.data?.count ?? 0;
  const unreadGmailCount = unreadGmail.data?.count ?? 0;
  const unreadInquiryCount = unreadInquiries.data?.count ?? 0;

  /**
   * Visitor messages became unread-able in migration 64. Without a way to clear
   * that, the bell would only ever count up — the exact defect its own comment
   * describes, so the control ships with the state rather than after it.
   */
  async function markInquiryRead(id: string) {
    try {
      await updateInquiryStatus.mutateAsync({ id, status: "read" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }
  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader title={t("inbox.title")} subtitle={t("inbox.subtitle")} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="tenants" className="relative">
            {t("inbox.tenantMessages")}
            {unreadTenantCount > 0 && (
              <span className="ms-2 rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground">
                {unreadTenantCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="visitors" className="relative">
            {t("inbox.contactInquiries")}
            {unreadInquiryCount > 0 && (
              <Badge className="ms-2 px-1.5 py-0 text-[10px]" variant="destructive">
                {unreadInquiryCount}
              </Badge>
            )}
          </TabsTrigger>
          {canReadLeads && (
            <TabsTrigger value="leads" className="relative">
              {t("inbox.leasingLeads")}
              {unreadLeadCount > 0 && (
                <span className="ms-2 rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground">
                  {unreadLeadCount}
                </span>
              )}
            </TabsTrigger>
          )}
          <TabsTrigger value="gmail" className="relative">
            {t("inbox.gmail")}
            {unreadGmailCount > 0 && (
              <span className="ms-2 rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground">
                {unreadGmailCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="whatsapp" className="relative">
            {t("inbox.whatsapp")}
            {unreadWhatsappCount > 0 && (
              <span className="ms-2 rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground">
                {unreadWhatsappCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tenants" className="mt-4">
          <TenantMessagesTable
            selectedTenantIds={selectedTenantIds}
            setDeleteTenantIds={setDeleteTenantIds}
            messagesLoading={messages.isLoading}
            messagesError={Boolean(messages.error)}
            sortedMessages={sortedMessages}
            allTenantSelected={allTenantSelected}
            toggleAllTenants={toggleAllTenants}
            toggleTenantId={toggleTenantId}
            sort={sort}
            toggle={toggle}
            highlightId={highlightId}
            dateFormatter={dateFormatter}
            openAttachment={openAttachment}
            markRead={markRead}
            markReadPending={updateStatus.isPending}
            tenantPage={tenantPage}
            setTenantPage={setTenantPage}
            inboxPageSize={inboxPageSize}
            messagesCount={messages.data?.count ?? 0}
          />
        </TabsContent>

        <TabsContent value="visitors" className="mt-4">
          <VisitorMessagesTable
            selectedInquiryIds={selectedInquiryIds}
            setDeleteInquiryIds={setDeleteInquiryIds}
            inquiriesLoading={inquiries.isLoading}
            inquiriesError={Boolean(inquiries.error)}
            inquiryItems={inquiries.data?.items ?? []}
            allInquirySelected={allInquirySelected}
            toggleAllInquiries={toggleAllInquiries}
            toggleInquiryId={toggleInquiryId}
            highlightId={highlightId}
            dateFormatter={dateFormatter}
            markInquiryRead={markInquiryRead}
            markInquiryReadPending={updateInquiryStatus.isPending}
            inquiryPage={inquiryPage}
            setInquiryPage={setInquiryPage}
            inboxPageSize={inboxPageSize}
            inquiriesCount={inquiries.data?.count ?? 0}
          />
        </TabsContent>

        {/* LEASING LEADS — formerly the "Leasing Leads" tab on the landing-page settings. */}
        {canReadLeads && (
          <TabsContent value="leads" className="mt-4">
            <LeadsTable
              canManage={canManageLeads}
              selectedLeadIds={selectedLeadIds}
              setDeleteLeadIds={setDeleteLeadIds}
              leadsLoading={leads.isLoading}
              leadsError={Boolean(leads.error)}
              leadItems={leads.data?.items ?? []}
              toggleAllLeads={toggleAllLeads}
              toggleLeadId={toggleLeadId}
              highlightId={highlightId}
              dateFormatter={dateFormatter}
              updateLeadStatus={updateLeadStatus}
              updateLeadPending={updateLead.isPending}
              leadPage={leadPage}
              setLeadPage={setLeadPage}
              inboxPageSize={inboxPageSize}
              leadsCount={leads.data?.count ?? 0}
            />
          </TabsContent>
        )}

        {/* GMAIL — messages synced from the connected Gmail account by the sync worker. */}
        <TabsContent value="gmail" className="mt-4">
          <GmailTabPanel
            gmail={gmail}
            canDelete={canDeleteGmail}
            highlightId={highlightId}
            dateFormatter={dateFormatter}
          />
        </TabsContent>

        {/* WHATSAPP — Evolution API chats ingested by the public webhook. */}
        <TabsContent value="whatsapp" className="mt-4">
          <WhatsAppInboxTab
            deepLinkChat={chatParam ?? null}
            enabled={staffEnabled}
            canSend={permissions.can("notifications.send")}
            canEditContacts={permissions.can("notifications.update")}
          />
        </TabsContent>
      </Tabs>

      <GmailOverlays gmail={gmail} />

      <DeleteConfirmation
        open={Boolean(deleteTenantIds?.length)}
        pending={deleteMessages.isPending}
        title={t("phase2.deleteTitle")}
        description={t("phase2.bulkDeleteDescription")}
        close={() => setDeleteTenantIds(null)}
        confirm={confirmDeleteTenants}
      />
      <DeleteConfirmation
        open={Boolean(deleteInquiryIds?.length)}
        pending={deleteInquiries.isPending}
        title={t("phase2.deleteTitle")}
        description={t("phase2.bulkDeleteDescription")}
        close={() => setDeleteInquiryIds(null)}
        confirm={confirmDeleteInquiries}
      />
      <DeleteConfirmation
        open={Boolean(deleteLeadIds?.length)}
        pending={deleteLeads.isPending}
        title={t("phase2.deleteTitle")}
        description={t("phase2.bulkDeleteDescription")}
        close={() => setDeleteLeadIds(null)}
        confirm={confirmDeleteLeads}
      />
    </div>
  );
}
