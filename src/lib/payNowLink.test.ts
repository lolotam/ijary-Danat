import { describe, expect, it } from "vitest";

import { overdueReminderTemplate, portalInvoicesUrl } from "./emailTemplates";
import { stripMarkup } from "./templateRender";

describe("portalInvoicesUrl", () => {
  it.each(["https://acme.ijary.app", "https://acme.ijary.app/"])(
    "points %s at its own portal invoices tab without doubling the slash",
    (origin) => {
      expect(portalInvoicesUrl(origin)).toBe("https://acme.ijary.app/portal/invoices");
    },
  );
});

describe("overdueReminderTemplate Pay Now link", () => {
  const base = { daysOverdue: 12, outstanding: "450.000 KWD", tenantName: "Acme Trading" } as const;
  const payNowUrl = "https://danat-future.com/portal/invoices";

  it("renders a Pay Now button pointing at the invoices tab", () => {
    const mail = overdueReminderTemplate({ ...base, locale: "en", payNowUrl });

    expect(mail.html).toContain("Pay Now");
    expect(mail.html).toContain(`href="${payNowUrl}"`);
  });

  it("renders the Arabic label for an Arabic reminder", () => {
    const mail = overdueReminderTemplate({ ...base, locale: "ar", payNowUrl });

    expect(mail.html).toContain("ادفع الآن");
    expect(mail.html).toContain(payNowUrl);
  });

  // WhatsApp sends the text body. An anchor would not survive it, so the URL
  // has to be bare text — this is the assertion that catches someone "tidying"
  // the text body into markup later.
  it("puts a bare url in the text body, which is what WhatsApp sends", () => {
    const mail = overdueReminderTemplate({ ...base, locale: "en", payNowUrl });

    expect(mail.text).toContain(payNowUrl);
    expect(mail.text).not.toContain("<a");
  });

  it("keeps the url intact after stripMarkup, the path the WhatsApp body takes", () => {
    const mail = overdueReminderTemplate({ ...base, locale: "en", payNowUrl });

    expect(stripMarkup(mail.text)).toContain(payNowUrl);
  });

  // The button is a single-cell table because Outlook renders a padded anchor
  // as an unpadded text link, and every client strips <style> blocks.
  it("wraps the button in a table with inline styles, not a styled anchor alone", () => {
    const mail = overdueReminderTemplate({ ...base, locale: "en", payNowUrl });

    expect(mail.html).toContain('role="presentation"');
    expect(mail.html).toContain("bgcolor=");
  });

  it("repeats the url as plain text for clients that strip the anchor", () => {
    const mail = overdueReminderTemplate({ ...base, locale: "en", payNowUrl });

    const occurrences = mail.html.split(payNowUrl).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
