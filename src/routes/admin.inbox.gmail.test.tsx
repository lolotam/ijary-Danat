/**
 * @vitest-environment jsdom
 *
 * يثبّت سلوك تبويب Gmail في صندوق الوارد قبل نقل حالته ومكوّناته خارج المسار.
 *
 * Audit M13 / plan row 6.6. The inbox page is 762 lines with 19 pieces of
 * state; about half of it is the Gmail tab. Two properties matter most to a
 * move and are pinned here against the unsplit page:
 *
 *  - lifetime: Radix unmounts inactive tab content, but the Gmail queries and
 *    state live on the page, so both folders stay warm while another tab is
 *    showing. State moved INTO the tab would silently reset on every switch;
 *  - the delete path reports a partial trash failure instead of a blanket
 *    success, and opening an unread message marks it read.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  search: { tab: "gmail" } as Record<string, unknown>,
  gmailCalls: [] as Array<Record<string, unknown>>,
  trash: vi.fn(),
  markRead: vi.fn(),
  markReadAsync: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  rows: [
    {
      id: "g-1",
      subject: "Lease question",
      from_address: "tenant@example.com",
      to_addresses: [],
      snippet: "Hello",
      received_at: "2026-09-20T10:00:00Z",
      is_read: false,
      category: null,
      provider: "gmail",
      direction: "received",
      labels: [],
    },
  ],
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useNavigate: () => vi.fn(),
    useSearch: () => mocks.search,
  }),
}));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isStaff: true, isLoading: false }),
}));
const emptyList = () => ({ data: { items: [], count: 0 }, isLoading: false, error: null });
const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
vi.mock("@/hooks/useTenantMessages", () => ({
  tenantMessageAttachmentUrl: vi.fn(),
  useContactInquiries: emptyList,
  useDeleteContactInquiries: idle,
  useDeleteTenantMessages: idle,
  useTenantMessages: emptyList,
  useUpdateContactInquiryStatus: idle,
  useUpdateTenantMessageStatus: idle,
}));
vi.mock("@/hooks/useLandingSettings", () => ({
  useDeleteLeasingInquiries: idle,
  useLeasingInquiries: emptyList,
  useUpdateLeasingInquiry: idle,
}));
vi.mock("@/hooks/useGmailConnection", () => ({
  useGmailConnection: () => ({ data: { email_address: "office@example.com" } }),
  useRunGmailSync: idle,
}));
vi.mock("@/hooks/useGmailMessages", () => ({
  listItemDeliveryFailure: () => ({ isDeliveryFailure: false, failedRecipients: [] }),
  useGmailMessages: (params: Record<string, unknown>) => {
    mocks.gmailCalls.push(params);
    return { data: { items: mocks.rows, count: mocks.rows.length }, isLoading: false, error: null };
  },
  useTrashGmailMessages: () => ({ mutateAsync: mocks.trash, isPending: false }),
  useMarkGmailRead: () => ({
    mutate: mocks.markRead,
    mutateAsync: mocks.markReadAsync,
    isPending: false,
  }),
}));
vi.mock("@/hooks/useOptionLists", () => ({ useOptionListItemsByCode: () => ({ data: [] }) }));
vi.mock("@/hooks/useWhatsAppInbox", () => ({ useWhatsAppChats: () => ({ data: [] }) }));
vi.mock("@/components/admin/GmailMessageSheet", () => ({
  GmailMessageSheet: ({ messageId }: { messageId: string | null }) =>
    messageId ? <div data-testid="open-message">{messageId}</div> : null,
}));
vi.mock("@/components/admin/compose/GmailComposeDialog", () => ({
  emptyCompose: () => ({ to: "", subject: "", body: "" }),
  GmailComposeDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="compose-open" /> : null,
}));
vi.mock("@/components/admin/inbox/TenantMessagesTable", () => ({
  TenantMessagesTable: () => null,
}));
vi.mock("@/components/admin/inbox/VisitorMessagesTable", () => ({
  VisitorMessagesTable: () => null,
}));
vi.mock("@/components/admin/inbox/LeadsTable", () => ({ LeadsTable: () => null }));
vi.mock("@/components/admin/whatsapp/WhatsAppInboxTab", () => ({ WhatsAppInboxTab: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, message: vi.fn() },
}));

const { Route } = await import("@/routes/admin.inbox");
const InboxPage = (Route as unknown as { component: () => ReactNode }).component;

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب صفحة الوارد داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <InboxPage />
      </I18nProvider>,
    ),
  );
}

/** ينتظر استقرار التأثيرات والوعود بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** آخر زر يحمل النص المطلوب — أزرار التأكيد تُرسم بعد الصفحة. */
function lastButton(text: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll("button")].filter((b) =>
    b.textContent?.includes(text),
  );
  if (!matches.length) throw new Error(`No button with text "${text}"`);
  return matches[matches.length - 1] as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.search = { tab: "gmail" };
  mocks.gmailCalls.length = 0;
  mocks.trash.mockReset();
  mocks.markRead.mockReset();
  mocks.markReadAsync.mockReset().mockResolvedValue(undefined);
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("inbox — Gmail tab", () => {
  it("keeps both folders' queries running while another tab is showing", async () => {
    mocks.search = { tab: "tenants" };
    mount();
    await settle();

    const listCalls = mocks.gmailCalls.filter((call) => call.pageSize === 20);
    expect(listCalls.some((call) => call.direction === "received")).toBe(true);
    expect(listCalls.some((call) => call.direction === "sent")).toBe(true);
  });

  it("opening an unread message shows it and marks it read", async () => {
    mount();
    await settle();

    await act(async () =>
      (
        [...document.querySelectorAll("button")].find((b) =>
          b.textContent?.includes("Lease question"),
        ) as HTMLButtonElement
      ).click(),
    );
    await settle();

    expect(document.querySelector('[data-testid="open-message"]')?.textContent).toBe("g-1");
    expect(mocks.markRead).toHaveBeenCalledWith({ id: "g-1", isRead: true });
  });

  it("compose opens the compose window", async () => {
    mount();
    await settle();

    await act(async () => lastButton(en["inbox.compose"]).click());
    await settle();

    expect(document.querySelector('[data-testid="compose-open"]')).not.toBeNull();
  });

  it("a partial trash failure is reported as an error, not a success", async () => {
    mocks.trash.mockResolvedValue({ failed: [{ id: "g-1", reason: "Gmail refused" }] });
    mount();
    await settle();

    await act(async () =>
      (document.querySelector(`[aria-label="${en["common.delete"]}"]`) as HTMLElement).click(),
    );
    await settle();
    await act(async () => lastButton(en["common.confirm"]).click());
    await settle();

    expect(mocks.trash).toHaveBeenCalledWith(["g-1"]);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalled();
  });
});
