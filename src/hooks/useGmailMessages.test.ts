import { describe, expect, it } from "vitest";

import { pageRange } from "@/hooks/pagination";
import {
  GMAIL_LIST_COLUMNS,
  GMAIL_LIST_COLUMNS_PRE_138,
  gmailMessagesQueryKey,
  isMissingFailedRecipientsColumn,
  listItemDeliveryFailure,
} from "@/hooks/useGmailMessages";

describe("GMAIL_LIST_COLUMNS", () => {
  it("excludes heavy full-message fields from the list select", () => {
    expect(GMAIL_LIST_COLUMNS).not.toMatch(/\braw_payload\b/);
    expect(GMAIL_LIST_COLUMNS).not.toMatch(/\bbody_text\b/);
    expect(GMAIL_LIST_COLUMNS).toMatch(/\bsnippet\b/);
    expect(GMAIL_LIST_COLUMNS).toMatch(/\bsubject\b/);
    expect(GMAIL_LIST_COLUMNS).toMatch(/\bfrom_address\b/);
    expect(GMAIL_LIST_COLUMNS).toMatch(/\bfailed_recipients\b/);
    expect(GMAIL_LIST_COLUMNS_PRE_138).not.toMatch(/\bfailed_recipients\b/);
  });
});

describe("isMissingFailedRecipientsColumn", () => {
  it("recognises a PostgREST schema-cache miss for the new column", () => {
    expect(
      isMissingFailedRecipientsColumn({
        code: "PGRST204",
        message:
          "Could not find the 'failed_recipients' column of 'gmail_messages' in the schema cache",
      }),
    ).toBe(true);
    expect(
      isMissingFailedRecipientsColumn({
        code: "42703",
        message: "column gmail_messages.failed_recipients does not exist",
      }),
    ).toBe(true);
    expect(isMissingFailedRecipientsColumn({ code: "42501", message: "permission denied" })).toBe(
      false,
    );
  });
});

describe("gmailMessagesQueryKey", () => {
  it("differs by page and filters", () => {
    const page1 = gmailMessagesQueryKey({
      page: 1,
      pageSize: 20,
      search: "",
      category: null,
      direction: null,
      isRead: null,
      provider: null,
    });
    const page2 = gmailMessagesQueryKey({
      page: 2,
      pageSize: 20,
      search: "",
      category: null,
      direction: null,
      isRead: null,
      provider: null,
    });
    const filtered = gmailMessagesQueryKey({
      page: 1,
      pageSize: 20,
      search: "rent",
      category: "billing",
      direction: null,
      isRead: false,
      provider: null,
    });
    expect(page1).not.toEqual(page2);
    expect(page1).not.toEqual(filtered);
    expect(page1[0]).toBe("gmail-messages");
  });

  it("differs by provider so Gmail and Resend never share a cache page", () => {
    // Same cache-bleed guard as direction: filtering to Resend and then back to
    // all providers must refetch, not replay the other filter's page.
    const all = gmailMessagesQueryKey({
      page: 1,
      pageSize: 20,
      search: "",
      category: null,
      direction: null,
      isRead: null,
      provider: null,
    });
    const resendOnly = gmailMessagesQueryKey({
      page: 1,
      pageSize: 20,
      search: "",
      category: null,
      direction: null,
      isRead: null,
      provider: "resend",
    });
    const gmailOnly = gmailMessagesQueryKey({
      page: 1,
      pageSize: 20,
      search: "",
      category: null,
      direction: null,
      isRead: null,
      provider: "gmail",
    });
    expect(all).not.toEqual(resendOnly);
    expect(gmailOnly).not.toEqual(resendOnly);
    // The pair that catches a key builder dropping `provider` when it happens
    // to equal the default: "all providers" and "Gmail only" return different
    // rows the moment one Resend message exists, so they must never collide.
    expect(all).not.toEqual(gmailOnly);
  });

  it("differs by direction so Received and Sent never share a cache page", () => {
    // Cache-bleed guard: omitting direction from the key would serve each
    // sub-tab the other's cached page and look like data corruption.
    const received = gmailMessagesQueryKey({
      page: 1,
      pageSize: 20,
      search: "",
      category: null,
      direction: "received",
      isRead: null,
      provider: null,
    });
    const sent = gmailMessagesQueryKey({
      page: 1,
      pageSize: 20,
      search: "",
      category: null,
      direction: "sent",
      isRead: null,
      provider: null,
    });
    expect(received).not.toEqual(sent);
    expect(received[1]).toMatchObject({ direction: "received" });
    expect(sent[1]).toMatchObject({ direction: "sent" });
  });
});

describe("listItemDeliveryFailure", () => {
  it("flags a header-only DSN from the persisted failed_recipients column", () => {
    expect(
      listItemDeliveryFailure({
        from_address: "postmaster@example.com",
        snippet: "See details below",
        failed_recipients: "gone@example.com",
      }),
    ).toEqual({ isDeliveryFailure: true, failedRecipients: ["gone@example.com"] });
  });
});

describe("gmail list range math", () => {
  it("uses stable inclusive boundaries for the first and second page", () => {
    expect(pageRange(1, 20)).toEqual({ from: 0, to: 19 });
    expect(pageRange(2, 20)).toEqual({ from: 20, to: 39 });
  });
});
