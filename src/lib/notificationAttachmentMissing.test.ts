import { describe, expect, test } from "vitest";

import { attachmentMissingCodes } from "@/lib/notificationAttachmentMissing";

describe("attachmentMissingCodes", () => {
  test.each([
    ["the stamped codes", { attachment_missing: ["PAY-1", "PAY-2"] }, ["PAY-1", "PAY-2"]],
    ["nothing for a complete send", { attachment_paths: ["x.pdf"] }, []],
    ["nothing for a null payload", null, []],
    ["nothing for an array payload", ["PAY-1"], []],
    ["nothing when the key is not a list", { attachment_missing: "PAY-1" }, []],
    ["only the non-empty strings", { attachment_missing: ["PAY-1", "", 7, null] }, ["PAY-1"]],
  ] as const)("reads %s", (_name, payload, expected) => {
    // A false positive puts a red badge on a complete send; a false negative is
    // the silent text-only send the key exists to expose.
    expect(attachmentMissingCodes(payload as never)).toEqual(expected);
  });
});
