import { useState } from "react";
import { toast } from "sonner";

import { emptyCompose, type ComposeSeed } from "@/components/admin/compose/GmailComposeDialog";
import { mailboxProviderOf } from "@/components/admin/inbox/MailboxProviderBadge";
import { useGmailConnection, useRunGmailSync } from "@/hooks/useGmailConnection";
import {
  useGmailMessages,
  useMarkGmailRead,
  useTrashGmailMessages,
  type MailboxProvider,
} from "@/hooks/useGmailMessages";
import { useOptionListItemsByCode } from "@/hooks/useOptionLists";
import { useI18n } from "@/i18n/provider";
import type { GmailFolder } from "@/lib/inboxSearch";

/**
 * The "no category filter" sentinel. Radix Select treats "" as "nothing
 * selected" and refuses to render an item with that value, so the unfiltered
 * state needs a real one.
 */
export const ALL_CATEGORIES = "__all__";
/** Sentinel for "no provider filter" — Radix Select forbids an empty value. */
export const ALL_PROVIDERS = "__all_providers__";

/** حالة تبويب Gmail وإجراءاته، كما يعيدها `useGmailInbox`. */
export type GmailInbox = ReturnType<typeof useGmailInbox>;

interface GmailInboxOptions {
  /** المجلد الفرعي النشط، من عنوان الصفحة. */
  folder: GmailFolder;
  /** يكتب المجلد الفرعي في عنوان الصفحة. */
  navigateToFolder: (folder: GmailFolder) => void;
  enabled: boolean;
  pageSize: number;
}

/**
 * حالة تبويب Gmail في صندوق الوارد: الاستعلامات والفلاتر والتحديد والحذف والكتابة.
 *
 * A hook called by the inbox PAGE, not state inside the tab component, and
 * that is load-bearing: Radix unmounts inactive tab content, so state living in
 * the tab would reset — selection, filters, page, an open message — every time
 * the operator glanced at another tab, and both folders' queries would stop
 * staying warm. Keeping the lifetime on the page is what lets the markup move
 * out of the 1,000-line route without changing behaviour (audit M13).
 */
export function useGmailInbox({ folder, navigateToFolder, enabled, pageSize }: GmailInboxOptions) {
  const { t, locale } = useI18n();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeSeed, setComposeSeed] = useState<ComposeSeed>(emptyCompose);
  // Set only for reply/forward: the provider the original arrived on, so the
  // compose window can pin the sender and not silently leave the thread.
  const [composeLockedProvider, setComposeLockedProvider] = useState<MailboxProvider | null>(null);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [provider, setProvider] = useState<string>(ALL_PROVIDERS);
  const [page, setPage] = useState(1);

  // Received sub-tab badge — direction filter so Sent never inflates it.
  const unreadReceived = useGmailMessages(
    { page: 1, pageSize: 1, isRead: false, direction: "received" },
    enabled,
  );
  const categoryFilter = category === ALL_CATEGORIES ? null : category;
  const providerFilter = provider === ALL_PROVIDERS ? null : (provider as MailboxProvider);
  // Both folders are queried so switching sub-tabs keeps data warm; only the
  // active folder's loading state drives the table.
  const received = useGmailMessages(
    {
      page: folder === "received" ? page : 1,
      pageSize,
      category: categoryFilter,
      provider: providerFilter,
      direction: "received",
    },
    enabled,
  );
  const sent = useGmailMessages(
    {
      page: folder === "sent" ? page : 1,
      pageSize,
      category: categoryFilter,
      provider: providerFilter,
      direction: "sent",
    },
    enabled,
  );
  const messages = folder === "sent" ? sent : received;
  const connection = useGmailConnection();
  const runSync = useRunGmailSync();
  const categories = useOptionListItemsByCode("gmail_categories");
  const trash = useTrashGmailMessages();
  const markRead = useMarkGmailRead();

  /** يبدّل المجلد الفرعي، ويعيد الصفحة الأولى ويفرّغ التحديد. */
  const changeFolder = (next: string) => {
    navigateToFolder(next as GmailFolder);
    setPage(1);
    setSelectedIds(new Set());
  };

  /**
   * يغيّر فلتر المزوّد أو التصنيف.
   *
   * Selection cannot outlive a filter change: the rows it refers to are about
   * to leave the table, and a bulk delete would then act on messages nobody can
   * see.
   */
  const changeProvider = (value: string) => {
    setProvider(value);
    setPage(1);
    setSelectedIds(new Set());
  };

  /** يغيّر فلتر التصنيف، ويعيد الصفحة الأولى ويفرّغ التحديد. */
  const changeCategory = (value: string) => {
    setCategory(value);
    setPage(1);
    setSelectedIds(new Set());
  };

  /** يشغّل مزامنة Gmail ويعلن النتيجة، بما فيها التخطي. */
  const sync = async () => {
    try {
      const result = await runSync.mutateAsync();
      if (result.skipped) {
        toast.message(t("inbox.gmailSyncSkipped"));
      } else {
        toast.success(t("inbox.gmailSyncDone"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  /** يفتح نافذة كتابة رسالة جديدة فارغة. */
  const composeNew = () => {
    setComposeSeed(emptyCompose());
    setComposeLockedProvider(null);
    setComposeOpen(true);
  };

  /**
   * يفتح نافذة الكتابة للرد أو التحويل من الرسالة المفتوحة.
   *
   * Closes the reader first: the compose window is modal and would otherwise
   * stack on top of an open sheet.
   */
  const composeFromOpen = (seed: ComposeSeed) => {
    const source = (messages.data?.items ?? []).find((item) => item.id === openId);
    setComposeLockedProvider(mailboxProviderOf(source?.provider));
    setOpenId(null);
    setComposeSeed(seed);
    setComposeOpen(true);
  };

  /**
   * يبدّل حالة القراءة لرسالة واحدة في الاتجاهين.
   * Unlike tenant messages, Gmail read state toggles both ways — marking a
   *  message read by mistake should not require deleting it. */
  async function toggleRead(id: string, isRead: boolean) {
    try {
      await markRead.mutateAsync({ id, isRead });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  /**
   * يضبط حالة القراءة لكل الرسائل المحدَّدة دفعةً واحدة.
   *
   * Sequential rather than `Promise.all`: these are individual PATCHes against
   * PostgREST, and a burst of them is how the shared Supabase instance starts
   * rate-limiting the admin's own session.
   *
   * Failures are counted and reported rather than swallowed — a bulk action
   * that half-worked while showing a success toast is worse than one that says
   * so, because the operator's next move is to trust the list.
   */
  async function markSelectedRead(isRead: boolean) {
    const ids = [...selectedIds];
    let failed = 0;
    for (const id of ids) {
      try {
        await markRead.mutateAsync({ id, isRead });
      } catch {
        failed += 1;
      }
    }
    setSelectedIds(new Set());
    if (failed === 0) {
      toast.success(
        (isRead ? t("inbox.bulkMarkedRead") : t("inbox.bulkMarkedUnread")).replace(
          "{count}",
          String(ids.length),
        ),
      );
      return;
    }
    toast.error(
      t("inbox.bulkMarkReadFailed")
        .replace("{failed}", String(failed))
        .replace("{total}", String(ids.length)),
    );
  }

  /** يبدّل تحديد رسالة واحدة. */
  function toggleId(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** يحدّد كل رسائل الصفحة أو يفرّغ التحديد إن كانت كلها محدّدة. */
  function toggleAll() {
    const items = messages.data?.items ?? [];
    if (items.length > 0 && items.every((g) => selectedIds.has(g.id))) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(items.map((g) => g.id)));
  }

  /**
   * ينقل الرسائل المؤكَّدة إلى سلة Gmail ويبلّغ بما تعذّر نقله.
   *
   * A delete here moves the message to Trash in Gmail first. A message that
   * could not be trashed keeps its local row, so the count is reported rather
   * than a blanket success — the previous blanket success is what made a
   * failed delete look like a working one.
   */
  async function confirmDelete() {
    if (!deleteIds?.length) return;
    try {
      const result = await trash.mutateAsync(deleteIds);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        deleteIds.forEach((id) => next.delete(id));
        return next;
      });
      setDeleteIds(null);
      if (result.failed.length) {
        toast.error(
          t("inbox.gmailDeletePartial").replace("{count}", String(result.failed.length)),
          {
            description: result.failed[0].reason,
          },
        );
      } else {
        toast.success(t("phase2.deleted"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  /** يعرض تسمية التصنيف بلغة الواجهة، أو القيمة نفسها إن لم تُعرَّف. */
  const categoryLabel = (value: string | null) => {
    if (!value) return null;
    const item = (categories.data ?? []).find((entry) => entry.value === value);
    if (!item) return value;
    return locale === "ar" ? item.label_ar : item.label_en;
  };

  /**
   * يفتح رسالة للقراءة ويعلّمها مقروءة.
   * Opening a message marks it read, which is what every mail client does. */
  function open(id: string, isRead: boolean) {
    setOpenId(id);
    if (!isRead) markRead.mutate({ id, isRead: true });
  }

  return {
    folder,
    page,
    setPage,
    pageSize,
    category,
    provider,
    selectedIds,
    deleteIds,
    setDeleteIds,
    openId,
    closeMessage: () => setOpenId(null),
    composeOpen,
    setComposeOpen,
    composeSeed,
    composeLockedProvider,
    messages,
    unreadReceivedCount: unreadReceived.data?.count ?? 0,
    connection,
    runSync,
    categories,
    trash,
    markRead,
    changeFolder,
    changeProvider,
    changeCategory,
    sync,
    composeNew,
    composeFromOpen,
    toggleRead,
    markSelectedRead,
    toggleId,
    toggleAll,
    confirmDelete,
    categoryLabel,
    open,
  };
}
