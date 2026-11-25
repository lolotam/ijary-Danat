import { describe, expect, it } from "vitest";

import { buildMailboxSenders, defaultMailboxSender, mailboxSenderId } from "@/lib/mailboxSenders";

const RESEND_ADDRESSES = [
  { label: "No-reply", value: "no-reply@danat-future.com" },
  { label: "Management", value: "management@danat-future.com" },
];

describe("buildMailboxSenders", () => {
  it("offers the connected Gmail account and every Resend address", () => {
    const senders = buildMailboxSenders({
      gmailAddress: "office@gmail.com",
      gmailCanSend: true,
      resendAddresses: RESEND_ADDRESSES,
    });

    expect(senders.map((sender) => sender.id)).toEqual([
      "gmail:office@gmail.com",
      "resend:no-reply@danat-future.com",
      "resend:management@danat-future.com",
    ]);
  });

  it("omits Gmail when no account can send", () => {
    // Offering a Gmail sender without a connection produces a Send button that
    // always fails — the option must not exist rather than fail on use.
    const senders = buildMailboxSenders({
      gmailAddress: null,
      gmailCanSend: false,
      resendAddresses: RESEND_ADDRESSES,
    });

    expect(senders.every((sender) => sender.provider === "resend")).toBe(true);
  });

  it("keeps one address twice when both providers can send it", () => {
    // The case the first design got wrong: Resend verifies the *domain*, so a
    // Gmail account on that domain is sendable by either provider, and the two
    // behave differently. Keying on the address alone would collapse them.
    const senders = buildMailboxSenders({
      gmailAddress: "management@danat-future.com",
      gmailCanSend: true,
      resendAddresses: RESEND_ADDRESSES,
    });

    const forAddress = senders.filter((sender) => sender.address === "management@danat-future.com");
    expect(forAddress).toHaveLength(2);
    expect(forAddress.map((sender) => sender.provider).sort()).toEqual(["gmail", "resend"]);
  });

  it("drops a duplicate that differs only by surrounding whitespace", () => {
    const senders = buildMailboxSenders({
      gmailAddress: null,
      gmailCanSend: false,
      resendAddresses: [
        { label: null, value: "ceo@danat-future.com" },
        { label: null, value: "  ceo@danat-future.com  " },
      ],
    });

    expect(senders).toHaveLength(1);
  });

  it("ignores a blank catalogue entry", () => {
    const senders = buildMailboxSenders({
      gmailAddress: null,
      gmailCanSend: false,
      resendAddresses: [{ label: null, value: "   " }],
    });

    expect(senders).toEqual([]);
  });
});

describe("mailboxSenderId", () => {
  it("is case-insensitive so one address cannot appear twice per provider", () => {
    expect(mailboxSenderId("resend", "CEO@Danat-Future.com")).toBe(
      mailboxSenderId("resend", "ceo@danat-future.com"),
    );
  });
});

describe("defaultMailboxSender", () => {
  const senders = buildMailboxSenders({
    gmailAddress: "office@gmail.com",
    gmailCanSend: true,
    resendAddresses: RESEND_ADDRESSES,
  });

  it("pins a reply to the provider the original arrived on", () => {
    const chosen = defaultMailboxSender(senders, "resend");
    expect(chosen?.provider).toBe("resend");
  });

  it("returns null rather than falling back to the wrong provider", () => {
    // A Gmail reply with no Gmail account connected must disable sending, not
    // quietly leave through Resend and drop out of the thread.
    const resendOnly = buildMailboxSenders({
      gmailAddress: null,
      gmailCanSend: false,
      resendAddresses: RESEND_ADDRESSES,
    });

    expect(defaultMailboxSender(resendOnly, "gmail")).toBeNull();
  });

  it("falls back to the first sender when nothing is locked", () => {
    expect(defaultMailboxSender(senders, null)?.provider).toBe("gmail");
  });

  it("returns null when there are no senders at all", () => {
    expect(defaultMailboxSender([], null)).toBeNull();
  });
});
