import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({ dir: "ltr", locale: "en", t: (key: string) => key }),
  useOptionalI18n: () => ({ dir: "ltr", locale: "en" }),
}));

const isMobile = vi.hoisted(() => ({ current: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => isMobile.current }));

import type { NotificationWithRelations } from "@/hooks/useNotifications";

import { NotificationLogTable } from "./NotificationLogTable";
import { notificationLogColumns } from "./notificationLogColumns";

/**
 * صف سجل واحد بالحقول التي تقرأها الأعمدة.
 *
 * Fully typed rather than cast: every key is checked against the real row, so
 * a renamed column or an invented enum value fails the build instead of
 * rendering `undefined`. Both mistakes were made writing this fixture — the
 * field names `language` / `recipient` / `sender`, and `type: "invoice_due"`,
 * none of which exist.
 */
const ROW: NotificationWithRelations = {
  audience: "tenant",
  body: "Invoice INV-1 is due.",
  channel: "email",
  company_id: "comp-1",
  contract: null,
  contract_id: null,
  created_at: "2026-08-01T09:00:00.000Z",
  delivery_key: null,
  error_code: null,
  failure_reason: "SMTP timeout",
  id: "n1",
  invoice: null,
  invoice_id: null,
  locale: "en",
  payload: {},
  provider: "smtp",
  provider_message_id: "abc-123",
  recipient_address: "tenant@example.com",
  report_schedule_id: null,
  retry_count: 2,
  scheduled_at: null,
  sender_address: "noreply@example.com",
  sent_at: null,
  state: "failed",
  subject: "Invoice due",
  template_code: "due_reminder",
  tenant: {
    id: "t1",
    code: "T-001",
    name: "Tenant A",
    reminders_enabled: true,
    email: "tenant@example.com",
    whatsapp: null,
  },
  tenant_id: "t1",
  type: "due_reminder",
  updated_at: "2026-08-01T09:00:00.000Z",
};

/**
 * يرسم المكوّن في العرض المطلوب ويعيد الـ markup.
 */
function render(mobile: boolean): string {
  isMobile.current = mobile;
  return renderToStaticMarkup(
    <NotificationLogTable
      canDelete={false}
      selected={[]}
      setSelected={vi.fn()}
      items={[ROW]}
      page={1}
      pageSize={20}
      retryPending={false}
      onRetry={vi.fn()}
      onCancel={vi.fn()}
      stateVariant={() => "secondary"}
      stateBadgeClass={() => ""}
    />,
  );
}

/**
 * يرسم صفاً بحالة محدّدة ويعيد الـ markup — لفحص توفّر أزرار الصف لكل حالة.
 */
function renderWithState(state: NotificationWithRelations["state"]): string {
  isMobile.current = false;
  return renderToStaticMarkup(
    <NotificationLogTable
      canDelete={false}
      selected={[]}
      setSelected={vi.fn()}
      items={[{ ...ROW, state }]}
      page={1}
      pageSize={20}
      retryPending={false}
      onRetry={vi.fn()}
      onCancel={vi.fn()}
      stateVariant={() => "secondary"}
      stateBadgeClass={() => ""}
    />,
  );
}

/**
 * يستخرج مجموعة الحقول المعروضة من سمات data-field.
 */
function renderedFields(mobile: boolean): string[] {
  return [...render(mobile).matchAll(/data-field="([^"]+)"/g)].map((match) => match[1]);
}

afterEach(() => {
  isMobile.current = false;
});

describe("the notification log's two presentations", () => {
  it("show exactly the same fields on mobile and desktop", () => {
    // The invariant the whole design rests on. Both render paths iterate one
    // descriptor array, so a field can never reach the table and miss the card
    // — which is how `failure_reason` would become unreachable on a phone, the
    // defect this component was built to prevent.
    expect([...renderedFields(true)].sort()).toEqual([...renderedFields(false)].sort());
  });

  it("render the columns the descriptor declares, in its order", () => {
    // The descriptor's own contents are pinned in notificationLogColumns.test;
    // what this adds is that the rendering follows it rather than a second,
    // hand-written list inside the component.
    expect(renderedFields(false)).toEqual(
      notificationLogColumns(
        (key) => key,
        () => "secondary",
        () => "",
      ).map((column) => column.key),
    );
  });

  it("keeps the failure reason readable on a phone", () => {
    // Named explicitly: this is the field whose unreachability on mobile is the
    // reason the card presentation exists at all. Asserts the value, not just
    // that a `failure` cell was emitted.
    expect(render(true)).toContain("SMTP timeout");
  });

  it.each(["failed", "skipped", "needs_review"] as const)(
    "offers a retry action on a %s row",
    (state) => {
      // needs_review is the one that matters: the drain job parks rows there for
      // conditions a human fixes outside Danat (a quota that resets, an admin who
      // re-authorizes), and their failure_reason tells staff to re-queue. Without
      // this button a parked row was harder to recover than an ordinary failure.
      expect(renderWithState(state)).toContain("notifications.retry");
    },
  );

  it("offers no retry action on a row that was already sent", () => {
    expect(renderWithState("sent")).not.toContain("notifications.retry");
  });
});
