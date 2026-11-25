import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { notificationLogColumns } from "./notificationLogColumns";

/** ترجمة وهمية تعيد المفتاح نفسه. */
const t = (key: string) => key;

/** متغيرات حالة وهمية — الاختبار يفحص المفاتيح لا الرسم. */
const stateVariant = () => "secondary" as const;
const stateBadgeClass = () => "";

describe("the notification log's two presentations cannot diverge", () => {
  it("declares every data column once, in a stable order", () => {
    // واصف واحد فقط — الجدول والبطاقة يكرران نفس المصفوفة.
    const keys = notificationLogColumns(t, stateVariant, stateBadgeClass).map((c) => c.key);
    expect(keys).toEqual([
      "tenant",
      "audience",
      "to",
      "from",
      "type",
      "related",
      "language",
      "channel",
      "template",
      "scheduledAt",
      "sentAt",
      "provider",
      "providerId",
      "status",
      "failure",
      "retries",
    ]);
  });

  it("gives every column a non-empty label", () => {
    // البطاقة تعرض التسميات التي يضعها الجدول في الرأس.
    for (const column of notificationLogColumns(t, stateVariant, stateBadgeClass)) {
      expect(column.label.trim()).not.toBe("");
    }
  });

  it("renders every address from a comma-joined recipient_address", () => {
    const to = notificationLogColumns(t, stateVariant, stateBadgeClass).find((c) => c.key === "to");
    expect(to).toBeDefined();
    const html = renderToStaticMarkup(
      <>
        {to!.render({
          recipient_address: "ops@example.com, finance@example.com",
        } as never)}
      </>,
    );
    expect(html).toContain("ops@example.com");
    expect(html).toContain("finance@example.com");
    expect(html).toContain("<li");
  });

  it.each([
    ["a row stamped attachment_missing shows the badge", { attachment_missing: ["INV-1"] }, true],
    ["a complete send shows no badge", { attachment_paths: ["x.pdf"] }, false],
    ["a row from before the key existed shows no badge", null, false],
  ] as const)("%s", (_name, payload, shown) => {
    // The payload flag alone was invisible: a text-only send read as a normal
    // sent row, which is how 2026-09-24 → 09-27 went unnoticed.
    const status = notificationLogColumns(t, stateVariant, stateBadgeClass).find(
      (c) => c.key === "status",
    );
    const html = renderToStaticMarkup(<>{status!.render({ state: "sent", payload } as never)}</>);

    expect(html).toContain("notificationState.sent");
    expect(html.includes("notifications.pdfMissing")).toBe(shown);
    if (shown) expect(html).toContain('title="INV-1"');
  });

  it("carries title for every truncated cell", () => {
    // الخلايا المقطوعة تفقد القيمة الكاملة بدون title — A3.
    const truncated = notificationLogColumns(t, stateVariant, stateBadgeClass).filter((c) =>
      c.cellClassName?.includes("truncate"),
    );
    expect(truncated.length).toBeGreaterThan(0);
    for (const column of truncated) {
      expect(column.title, `${column.key} needs title`).toBeTypeOf("function");
    }
  });
});
