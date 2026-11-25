import { describe, expect, it } from "vitest";

import {
  detectGmailDeliveryFailure,
  failedRecipientsHeaderValue,
  highlightFailedRecipients,
} from "@/lib/gmailDeliveryFailure";

describe("detectGmailDeliveryFailure", () => {
  it("ignores ordinary inbound mail", () => {
    expect(
      detectGmailDeliveryFailure({
        fromAddress: "tenant@example.com",
        snippet: "Please renew the lease for unit 4.",
      }),
    ).toEqual({ isDeliveryFailure: false, failedRecipients: [] });
  });

  it("flags Mailer-Daemon and pulls the failed address out of the snippet", () => {
    expect(
      detectGmailDeliveryFailure({
        fromAddress: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        snippet: "Address not found Your message wasn't delivered to missing@example.com",
      }),
    ).toEqual({
      isDeliveryFailure: true,
      failedRecipients: ["missing@example.com"],
    });
  });

  it("flags a message that only carries X-Failed-Recipients", () => {
    expect(
      detectGmailDeliveryFailure({
        fromAddress: "postmaster@example.com",
        headers: [{ name: "X-Failed-Recipients", value: "a@x.com, b@y.com" }],
      }),
    ).toEqual({
      isDeliveryFailure: true,
      failedRecipients: ["a@x.com", "b@y.com"],
    });
  });

  it("does not list the Mailer-Daemon address as a failed recipient", () => {
    const result = detectGmailDeliveryFailure({
      fromAddress: "mailer-daemon@googlemail.com",
      snippet: "mailer-daemon@googlemail.com could not deliver to gone@example.com",
    });
    expect(result.isDeliveryFailure).toBe(true);
    expect(result.failedRecipients).toEqual(["gone@example.com"]);
  });

  it("treats X-Failed-Recipients as authoritative and ignores extra snippet addresses", () => {
    expect(
      detectGmailDeliveryFailure({
        fromAddress: "mailer-daemon@googlemail.com",
        snippet: "Delivery to gone@example.com failed. Contact support@example.com",
        failedRecipientsHeader: "Gone@example.com",
      }),
    ).toEqual({
      isDeliveryFailure: true,
      failedRecipients: ["Gone@example.com"],
    });
  });

  it("does not fall back to the snippet when a present header has no mailbox", () => {
    expect(
      detectGmailDeliveryFailure({
        fromAddress: "mailer-daemon@googlemail.com",
        snippet: "Delivery to gone@example.com failed. Contact support@example.com",
        failedRecipientsHeader: "undisclosed-recipients:;",
      }),
    ).toEqual({ isDeliveryFailure: true, failedRecipients: [] });
  });

  it("flags Mailer-Daemon at google.com the same as googlemail.com", () => {
    expect(
      detectGmailDeliveryFailure({
        fromAddress: "Mail Delivery Subsystem <mailer-daemon@google.com>",
        snippet: "Your message wasn't delivered to missing@example.com",
      }).isDeliveryFailure,
    ).toBe(true);
  });
});

describe("highlightFailedRecipients", () => {
  it("highlights the longer address first when one mailbox contains another", () => {
    expect(
      highlightFailedRecipients("mail went to a@x.com and aa@x.com", ["a@x.com", "aa@x.com"]),
    ).toEqual([
      { text: "mail went to ", failed: false },
      { text: "a@x.com", failed: true },
      { text: " and ", failed: false },
      { text: "aa@x.com", failed: true },
    ]);
  });

  it("marks the failed address inside the snippet and keeps the surrounding text", () => {
    expect(
      highlightFailedRecipients("Delivery to gone@example.com failed", ["gone@example.com"]),
    ).toEqual([
      { text: "Delivery to ", failed: false },
      { text: "gone@example.com", failed: true },
      { text: " failed", failed: false },
    ]);
  });
});

describe("failedRecipientsHeaderValue", () => {
  it("reads X-Failed-Recipients case-insensitively", () => {
    expect(failedRecipientsHeaderValue([{ name: "x-failed-recipients", value: " a@x.com " }])).toBe(
      "a@x.com",
    );
  });

  it("returns null when the header is missing", () => {
    expect(failedRecipientsHeaderValue([{ name: "From", value: "a@x.com" }])).toBeNull();
  });
});
