import { describe, expect, test } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import {
  invoiceSendRowBucket,
  invoiceSendToast,
  type InvoiceSendOutcome,
} from "@/lib/invoiceSendOutcome";

/** حصيلة إرسال فارغة تُعدَّل حسب الحالة تحت الاختبار. */
function outcome(overrides: Partial<InvoiceSendOutcome> = {}): InvoiceSendOutcome {
  return { sent: [], queued: [], failed: [], refused: [], paused: [], ...overrides };
}

describe("invoiceSendRowBucket", () => {
  test.each([
    ["sent", "sent"],
    ["queued", "queued"],
    ["failed", "failed"],
    ["skipped", "failed"],
    ["needs_review", "failed"],
    ["cancelled", "failed"],
  ] as const)("%s is reported as %s", (state, bucket) => {
    // dispatchNotificationRecord returns the row after writing these states;
    // a non-null id is not evidence of delivery.
    expect(invoiceSendRowBucket(state)).toBe(bucket);
  });
});

describe("invoiceSendToast", () => {
  test("every accepted channel toasts as sent", () => {
    expect(invoiceSendToast(outcome({ sent: ["n-1"] }))).toEqual({
      kind: "success",
      key: "invoices.sent",
    });
  });

  test("a still-queued row is not toasted as sent", () => {
    expect(invoiceSendToast(outcome({ queued: ["n-1"] }))).toEqual({
      kind: "warning",
      key: "invoices.sendQueued",
    });
  });

  test("an incomplete send is distinct from a refused channel", () => {
    expect(invoiceSendToast(outcome({ failed: ["n-1"] }))).toEqual({
      kind: "error",
      key: "invoices.sendFailed",
    });
  });

  test("a refused channel keeps the refused copy", () => {
    expect(invoiceSendToast(outcome({ refused: ["whatsapp"] }))).toEqual({
      kind: "error",
      key: "invoices.sendRefused",
    });
  });

  test("a paused tenant says the notifications are paused, not that the send failed", () => {
    // The admin paused this tenant's notifications, so nothing was meant to
    // reach them. Toasting "send failed" would send them after a broken
    // template instead of after the switch they flipped.
    expect(invoiceSendToast(outcome({ paused: ["email"] }))).toEqual({
      kind: "warning",
      key: "invoices.sendTenantPaused",
    });
  });

  test("a channel that went out is not hidden by a paused sibling", () => {
    // One channel delivered and one skipped by the pause: the message DID go
    // out, so the pause copy must not replace the delivery copy.
    expect(invoiceSendToast(outcome({ sent: ["n-1"], paused: ["whatsapp"] }))).toEqual({
      kind: "success",
      key: "invoices.sent",
    });
  });

  test("a failed channel is not hidden behind the paused copy", () => {
    // الإيقاف المؤقت لا يغطّي فشلاً حقيقياً: المسؤول يحتاج أن يرى الفشل.
    // The pause branch must not swallow a failure: the admin needs the failure,
    // not a pause message about a sibling channel.
    expect(invoiceSendToast(outcome({ paused: ["email"], failed: ["n-1"] }))).toEqual({
      kind: "error",
      key: "invoices.sendFailed",
    });
  });

  test("a send that went out without its pdf warns instead of toasting sent", () => {
    // 2026-09-24 → 09-27 the PDF render failed silently and every send still
    // toasted "Invoice sent"; the admin had no way to know the tenant got text.
    expect(invoiceSendToast(outcome({ sent: ["n-1"], pdfMissing: true }))).toEqual({
      kind: "warning",
      key: "invoices.sentWithoutPdf",
    });
  });

  test.each([
    outcome({ sent: ["n-1"], refused: ["whatsapp"] }),
    outcome({ sent: ["n-1"], failed: ["n-2"] }),
    outcome({ sent: ["n-1"], queued: ["n-2"] }),
  ])("partly sent requires at least one accepted row %#", (mixed) => {
    expect(invoiceSendToast(mixed)).toEqual({
      kind: "warning",
      key: "invoices.sentPartly",
    });
  });

  test.each([
    outcome({ sent: ["n-1"], refused: ["whatsapp"], pdfMissing: true }),
    outcome({ sent: ["n-1"], failed: ["n-2"], pdfMissing: true }),
  ])("a partial send without its pdf says both %#", (partial) => {
    // Codex P2 on #263: the delivered channel lacked its PDF, and "partly sent"
    // alone said nothing about it.
    expect(invoiceSendToast(partial)).toEqual({
      kind: "warning",
      key: "invoices.sentPartlyWithoutPdf",
    });
  });

  test.each([
    outcome({ queued: ["n-1"], failed: ["n-2"] }),
    outcome({ queued: ["n-1"], refused: ["whatsapp"] }),
  ])("queued with unavailable channels stays pending, not partly sent %#", (pending) => {
    expect(invoiceSendToast(pending)).toEqual({
      kind: "warning",
      key: "invoices.sendQueuedPartly",
    });
  });

  test("every toast key exists in both dictionaries", () => {
    // Callers pass `t(feedback.key)`; a missing key renders as the raw string.
    const keys = [
      invoiceSendToast(outcome({ sent: ["n-1"] })).key,
      invoiceSendToast(outcome({ queued: ["n-1"] })).key,
      invoiceSendToast(outcome({ failed: ["n-1"] })).key,
      invoiceSendToast(outcome({ refused: ["whatsapp"] })).key,
      invoiceSendToast(outcome({ paused: ["email"] })).key,
      invoiceSendToast(outcome({ sent: ["n-1"], refused: ["whatsapp"] })).key,
      invoiceSendToast(outcome({ queued: ["n-1"], refused: ["whatsapp"] })).key,
      invoiceSendToast(outcome({ sent: ["n-1"], pdfMissing: true })).key,
      invoiceSendToast(outcome({ sent: ["n-1"], refused: ["whatsapp"], pdfMissing: true })).key,
    ];
    for (const key of keys) {
      expect(dictionaries.ar[key], `ar missing ${key}`).toBeTruthy();
      expect(dictionaries.en[key], `en missing ${key}`).toBeTruthy();
    }
  });
});
