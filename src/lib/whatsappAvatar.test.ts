import { describe, expect, test } from "vitest";

import { avatarUrlExpiry, isAvatarUrlExpired } from "./whatsappAvatar";

// Shapes copied from real production URLs (the picture id is redacted).
const LIVE = "https://pps.whatsapp.net/v/t61.24694-24/159117833_264084.jpg?ccb=11-4&oe=6AAD6E08";
const NO_EXPIRY = "https://pps.whatsapp.net/v/t61.24694-24/159117833_264084.jpg?ccb=11-4";

describe("avatarUrlExpiry", () => {
  test("reads the hex unix expiry WhatsApp stamps into the URL", () => {
    expect(avatarUrlExpiry(LIVE)?.toISOString()).toBe("2026-09-18T16:59:52.000Z");
  });

  test("returns null for a URL that carries no expiry", () => {
    expect(avatarUrlExpiry(NO_EXPIRY)).toBeNull();
  });

  test("returns null rather than an epoch date for an unparseable value", () => {
    expect(avatarUrlExpiry("https://pps.whatsapp.net/x.jpg?oe=zzz")).toBeNull();
  });
});

describe("isAvatarUrlExpired", () => {
  test("a link past its stamped expiry is expired", () => {
    expect(isAvatarUrlExpired(LIVE, new Date("2026-09-19T00:00:00Z"))).toBe(true);
  });

  test("a link still inside its window is not", () => {
    expect(isAvatarUrlExpired(LIVE, new Date("2026-09-10T00:00:00Z"))).toBe(false);
  });

  test("a link expiring within the safety margin is already treated as dead", () => {
    // Requesting a picture that dies mid-flight costs a broken image; the
    // margin spends a minute of freshness to avoid it.
    expect(isAvatarUrlExpired(LIVE, new Date("2026-09-18T16:59:20Z"))).toBe(true);
  });

  test("no URL, and a URL with no expiry, are never expired", () => {
    expect(isAvatarUrlExpired(null)).toBe(false);
    expect(isAvatarUrlExpired(NO_EXPIRY, new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });
});
