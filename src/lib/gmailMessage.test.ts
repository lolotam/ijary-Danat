import { describe, expect, it, test } from "vitest";

import {
  buildReplyHeaders,
  buildReplyRecipients,
  decodeBody,
  extractHeaders,
  extractHtmlBody,
  forwardSubject,
  listAttachments,
  parseAddresses,
  replySubject,
  resolveGmailId,
  type GmailHeaders,
  type GmailMessagePayload,
} from "@/lib/gmailMessage";

/** Gmail encodes part bodies as unpadded URL-safe base64. */
function encode(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The shape real mail actually arrives in: a mixed container holding an
 * alternative pair plus an attachment. Reading only `payload.body.data` — which
 * the sync worker did originally — finds nothing here, which is why these tests
 * use a nested fixture rather than a flat one.
 */
const multipartMessage: GmailMessagePayload = {
  mimeType: "multipart/mixed",
  headers: [
    { name: "Message-ID", value: "<parent@mail.example>" },
    { name: "References", value: "<root@mail.example>" },
    { name: "From", value: "Dana Owner <owner@example.com>" },
    { name: "To", value: "danatfuture@gmail.com, Second <second@example.com>" },
    { name: "Cc", value: "cc@example.com" },
    { name: "Subject", value: "Lease renewal" },
    { name: "Date", value: "Fri, 1 Aug 2026 10:00:00 +0300" },
  ],
  parts: [
    {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: encode("Plain body") } },
        { mimeType: "text/html", body: { data: encode("<p>HTML body</p>") } },
      ],
    },
    {
      mimeType: "application/pdf",
      filename: "contract.pdf",
      body: { attachmentId: "att-1", size: 2048 },
    },
  ],
};

describe("reading a stored Gmail payload", () => {
  test("finds the HTML body nested inside multipart/alternative", () => {
    expect(extractHtmlBody(multipartMessage)).toBe("<p>HTML body</p>");
  });

  test("returns no HTML when the message is plain text only", () => {
    const plainOnly: GmailMessagePayload = {
      mimeType: "text/plain",
      body: { data: encode("just text") },
    };
    expect(extractHtmlBody(plainOnly)).toBeNull();
  });

  test("decodes Arabic without mangling it", () => {
    // The browser path goes through atob, which yields one character per byte;
    // without a TextDecoder step every Arabic subject in this deployment would
    // render as mojibake.
    expect(decodeBody(encode("مرحبا بك"))).toBe("مرحبا بك");
  });

  test("lists only parts that are really attachments", () => {
    // The body parts and the multipart wrappers have no filename/attachmentId
    // pair; without requiring both, every message reports phantom attachments.
    expect(listAttachments(multipartMessage)).toEqual([
      {
        attachmentId: "att-1",
        filename: "contract.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
      },
    ]);
  });

  test("reads the headers a reply needs", () => {
    const headers = extractHeaders(multipartMessage);
    expect(headers.messageId).toBe("<parent@mail.example>");
    expect(headers.references).toBe("<root@mail.example>");
    expect(headers.subject).toBe("Lease renewal");
  });
});

describe("threading a reply", () => {
  const base: GmailHeaders = {
    messageId: "<parent@mail.example>",
    references: null,
    inReplyTo: null,
    from: null,
    to: null,
    cc: null,
    replyTo: null,
    subject: null,
    date: null,
  };

  test("refuses to thread on the sync worker's synthetic id", () => {
    // `gmail_messages.message_id` is NOT always an RFC message id: the worker
    // substitutes `gmail:<id>` for messages with no Message-ID header. That is a
    // fine uniqueness key and an invalid header — emitting it produces mail no
    // client threads. Null means "send without threading", which is correct.
    expect(buildReplyHeaders({ ...base, messageId: "gmail:18f2c9" })).toBeNull();
  });

  test("starts a References chain from the parent when there is none", () => {
    expect(buildReplyHeaders(base)).toEqual({
      inReplyTo: "<parent@mail.example>",
      references: "<parent@mail.example>",
    });
  });

  test("appends to an existing References chain rather than replacing it", () => {
    // Replacing it splits a long conversation into a new thread at every reply.
    expect(buildReplyHeaders({ ...base, references: "<root@mail.example>" })).toEqual({
      inReplyTo: "<parent@mail.example>",
      references: "<root@mail.example> <parent@mail.example>",
    });
  });
});

describe("choosing reply recipients", () => {
  const headers = extractHeaders(multipartMessage);
  const SELF = "danatfuture@gmail.com";

  test("a plain reply goes to the sender alone", () => {
    expect(buildReplyRecipients(headers, SELF, false)).toEqual({
      to: ["owner@example.com"],
      cc: [],
    });
  });

  test("reply-all copies the other recipients but never this mailbox", () => {
    expect(buildReplyRecipients(headers, SELF, true)).toEqual({
      to: ["owner@example.com"],
      cc: ["second@example.com", "cc@example.com"],
    });
  });

  test("reply-all adds nobody while the connected address is still unknown", () => {
    /*
     * Found in review, not by a failure. `connectedAddress` comes from a query
     * that has not resolved on first render, and the original code compared
     * with `address.toLowerCase() !== connectedAddress?.toLowerCase()` — which
     * against `undefined` is always true, so the mailbox stayed in its own Cc.
     * Clicking reply-all quickly mailed the account itself, and the sync worker
     * pulled the result back in as a new unread message.
     *
     * Returning no Cc is the safe direction: a missing Cc is visible on screen,
     * a self-addressed loop is not.
     */
    expect(buildReplyRecipients(headers, null, true).cc).toEqual([]);
  });

  test("matches this mailbox regardless of the case the sender used", () => {
    expect(buildReplyRecipients(headers, "DanatFuture@Gmail.com", true).cc).not.toContain(
      "danatfuture@gmail.com",
    );
  });
});

describe("subject prefixing", () => {
  test.each([
    ["Lease renewal", "Re: Lease renewal"],
    ["Re: Lease renewal", "Re: Lease renewal"],
    ["RE: Lease renewal", "RE: Lease renewal"],
    [null, "Re:"],
  ])("replySubject(%s) → %s", (input, expected) => {
    expect(replySubject(input)).toBe(expected);
  });

  test.each([
    ["Lease renewal", "Fwd: Lease renewal"],
    ["Fwd: Lease renewal", "Fwd: Lease renewal"],
    ["Fw: Lease renewal", "Fw: Lease renewal"],
  ])("forwardSubject(%s) → %s", (input, expected) => {
    expect(forwardSubject(input)).toBe(expected);
  });
});

describe("address headers", () => {
  test("takes the address out of a display-name form", () => {
    expect(parseAddresses("Dana Owner <owner@example.com>, plain@example.com")).toEqual([
      "owner@example.com",
      "plain@example.com",
    ]);
  });

  test("drops entries that are not addresses rather than passing them on", () => {
    // A malformed header would otherwise reach the send path and be rejected by
    // Gmail as a whole-message failure.
    expect(parseAddresses("undisclosed-recipients:;")).toEqual([]);
  });
});

describe("resolveGmailId", () => {
  it("takes Gmail's own id from the stored payload", () => {
    // `message_id` is the RFC 822 header, not Gmail's id — the trash endpoint
    // is addressed by the latter, which only survives inside raw_payload.
    expect(resolveGmailId({ message_id: "<abc@mail.example>", raw_payload: { id: "18f0c" } })).toBe(
      "18f0c",
    );
  });

  it("falls back to the gmail: prefix used when a message had no Message-ID header", () => {
    expect(resolveGmailId({ message_id: "gmail:18f0c", raw_payload: null })).toBe("18f0c");
  });

  it("returns null when neither source has an id, so the caller can refuse", () => {
    expect(resolveGmailId({ message_id: "<abc@mail.example>", raw_payload: null })).toBeNull();
    expect(resolveGmailId({ message_id: "gmail:", raw_payload: {} })).toBeNull();
  });
});
