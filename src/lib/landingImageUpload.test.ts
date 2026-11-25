import { describe, expect, it } from "vitest";

import {
  LANDING_IMAGE_MAX_BYTES,
  landingImageSizeError,
  mapLandingImageUploadError,
  withTimeout,
} from "./landingImageUpload";

describe("landingImageSizeError", () => {
  it("allows files at or under the limit", () => {
    expect(landingImageSizeError(LANDING_IMAGE_MAX_BYTES, "en")).toBeNull();
    expect(landingImageSizeError(1000, "ar")).toBeNull();
  });

  it("rejects oversized files with a bilingual message", () => {
    const en = landingImageSizeError(LANDING_IMAGE_MAX_BYTES + 1, "en");
    const ar = landingImageSizeError(LANDING_IMAGE_MAX_BYTES + 1, "ar");
    expect(en).toMatch(/too large/i);
    expect(ar).toMatch(/كبير/);
  });
});

describe("mapLandingImageUploadError", () => {
  it("maps RLS / AccessDenied to an admin-required message", () => {
    const msg = mapLandingImageUploadError(
      new Error("new row violates row-level security policy"),
      "en",
    );
    expect(msg).toMatch(/admin/i);

    const ar = mapLandingImageUploadError(
      { message: "AccessDenied: Unauthorized", statusCode: 403 },
      "ar",
    );
    // Assert the Arabic branch specifically: an `|admin` alternation here would
    // also pass on the English string, making the test unable to catch a regression.
    expect(ar).toMatch(/مسؤول/);
    expect(ar).not.toMatch(/requires an admin account/i);
  });

  it("reads statusCode 401 as an expired session, not a permissions problem", () => {
    // Regression: substring matching saw "Unauthorized" and blamed permissions,
    // sending a real admin to chase an access bug that did not exist.
    const en = mapLandingImageUploadError({ message: "Unauthorized", statusCode: 401 }, "en");
    expect(en).toMatch(/session/i);
    expect(en).not.toMatch(/admin/i);

    const ar = mapLandingImageUploadError({ message: "Unauthorized", statusCode: 401 }, "ar");
    expect(ar).toMatch(/الجلسة/);
    expect(ar).not.toMatch(/مسؤول/);
  });

  it("accepts a string statusCode, as storage-api sometimes returns", () => {
    expect(
      mapLandingImageUploadError({ message: "Unauthorized", statusCode: "401" }, "en"),
    ).toMatch(/session/i);
    expect(mapLandingImageUploadError({ message: "denied", statusCode: "403" }, "en")).toMatch(
      /admin/i,
    );
  });

  it("falls back to substring matching when no statusCode is present", () => {
    expect(mapLandingImageUploadError(new Error("row-level security"), "en")).toMatch(/admin/i);
  });

  it("maps timeouts", () => {
    expect(mapLandingImageUploadError(new Error("Upload timed out after 60000ms"), "en")).toMatch(
      /timed out/i,
    );
  });

  it("passes through unknown messages", () => {
    expect(mapLandingImageUploadError(new Error("Bucket not found"), "en")).toBe(
      "Bucket not found",
    );
  });
});

describe("withTimeout", () => {
  it("resolves when the promise wins", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it("rejects when the timer wins", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "Upload")).rejects.toThrow(/timed out/i);
  });
});
