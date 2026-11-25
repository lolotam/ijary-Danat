import { describe, expect, it } from "vitest";

import { classifyGmailDirection, classifyGmailIsRead } from "@/lib/gmailDirection";

describe("classifyGmailDirection", () => {
  it("classifies SENT as sent", () => {
    expect(classifyGmailDirection(["SENT"])).toBe("sent");
  });

  it("classifies INBOX as received", () => {
    expect(classifyGmailDirection(["INBOX"])).toBe("received");
  });

  it("SENT wins when both SENT and INBOX are present", () => {
    // Live data has ~25 rows with both labels (account mailed itself).
    expect(classifyGmailDirection(["SENT", "INBOX"])).toBe("sent");
    expect(classifyGmailDirection(["INBOX", "UNREAD", "SENT"])).toBe("sent");
  });

  it("defaults empty or missing labels to received", () => {
    expect(classifyGmailDirection([])).toBe("received");
    expect(classifyGmailDirection(undefined)).toBe("received");
    expect(classifyGmailDirection(null)).toBe("received");
  });
});

describe("classifyGmailIsRead", () => {
  it("is unread when labels include UNREAD", () => {
    expect(classifyGmailIsRead(["UNREAD"])).toBe(false);
    expect(classifyGmailIsRead(["INBOX", "UNREAD"])).toBe(false);
  });

  it("is read when labels lack UNREAD", () => {
    expect(classifyGmailIsRead(["INBOX"])).toBe(true);
    expect(classifyGmailIsRead(["SENT", "INBOX"])).toBe(true);
  });

  it("defaults empty labels to unread", () => {
    // Empty array is not "Gmail said read" — hide-as-read is the dangerous
    // failure; show-as-unread is a minor annoyance.
    expect(classifyGmailIsRead([])).toBe(false);
  });

  it("defaults missing labels to unread", () => {
    expect(classifyGmailIsRead(undefined)).toBe(false);
    expect(classifyGmailIsRead(null)).toBe(false);
  });
});
