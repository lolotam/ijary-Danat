import { describe, expect, it } from "vitest";

import { appendAddresses, parseAddresses, splitEmailAddresses } from "./addressList";

describe("parseAddresses", () => {
  it("splits on commas and semicolons and drops empties", () => {
    expect(parseAddresses("a@x.com, b@x.com; c@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("drops a trailing empty part left by a hanging separator", () => {
    expect(parseAddresses("a@x.com, ")).toEqual(["a@x.com"]);
  });
});

describe("splitEmailAddresses", () => {
  it("splits a comma-joined recipient_address into one mailbox per entry", () => {
    expect(splitEmailAddresses("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("returns an empty list when the field is missing or has no mailbox", () => {
    expect(splitEmailAddresses(null)).toEqual([]);
    expect(splitEmailAddresses("+96550123456")).toEqual([]);
  });
});

describe("appendAddresses", () => {
  it("appends only the addresses that are not already present", () => {
    expect(appendAddresses("a@x.com", ["a@x.com", "b@x.com"])).toBe("a@x.com, b@x.com");
  });

  it("detects duplicates case-insensitively and keeps the typed casing", () => {
    expect(appendAddresses("A@X.com", ["a@x.com"])).toBe("A@X.com");
  });

  it("preserves mid-typed non-address text instead of stripping it", () => {
    expect(appendAddresses("draft-note", ["a@x.com"])).toBe("draft-note, a@x.com");
  });

  it("returns just the additions when the field is empty", () => {
    expect(appendAddresses("", ["a@x.com"])).toBe("a@x.com");
  });

  it("does not double a trailing comma-and-space separator", () => {
    expect(appendAddresses("a@x.com, ", ["b@x.com"])).toBe("a@x.com, b@x.com");
  });

  it("does not double a trailing semicolon separator", () => {
    expect(appendAddresses("a@x.com;", ["b@x.com"])).toBe("a@x.com, b@x.com");
  });

  it("leaves the typed value untouched when every addition is already present", () => {
    // A rewrite that "normalises" trailing separators would mutate the field
    // even when nothing new landed — the user is still mid-typing.
    expect(appendAddresses("a@x.com, ", ["a@x.com"])).toBe("a@x.com, ");
  });

  it("does not repeat an address that appears twice in one batch", () => {
    // Two tenants can share one mailbox — a family, or a reused company
    // contact. A dedupe set built only from `current` cannot see the batch's
    // own repeats, so both copies were appended.
    expect(appendAddresses("", ["a@x.com", "A@X.com"])).toBe("a@x.com");
    expect(appendAddresses("z@x.com", ["a@x.com", "a@x.com"])).toBe("z@x.com, a@x.com");
  });
});
