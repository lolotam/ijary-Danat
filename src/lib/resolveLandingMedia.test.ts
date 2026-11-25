import { describe, expect, it } from "vitest";

import { planLandingMediaResolution } from "./resolveLandingMedia";

const catalog = [
  {
    id: "media-old-cover",
    storage_path: "https://cdn.example/landing/shops/cards/old.png",
    show_in_gallery: false,
  },
  {
    id: "media-logo",
    storage_path: "https://cdn.example/landing/shops/logos/logo.png",
    show_in_gallery: true,
  },
];

describe("planLandingMediaResolution", () => {
  it("creates a new media row when the form URL is new and no prior id exists", () => {
    const plan = planLandingMediaResolution(
      "https://cdn.example/landing/shops/cards/new-16x9.png",
      null,
      catalog,
      false,
    );
    expect(plan).toEqual({
      kind: "create",
      storagePath: "https://cdn.example/landing/shops/cards/new-16x9.png",
    });
  });

  it("creates a new media row when re-uploading replaces an existing cover id", () => {
    // Regression: old code found byId and returned media-old-cover without
    // updating storage_path, so shop card photos never saved on edit.
    const plan = planLandingMediaResolution(
      "https://cdn.example/landing/shops/cards/replacement-16x9.png",
      "media-old-cover",
      catalog,
      false,
    );
    expect(plan).toEqual({
      kind: "create",
      storagePath: "https://cdn.example/landing/shops/cards/replacement-16x9.png",
      // The superseded row must come back so the call site can deactivate it —
      // otherwise the public gallery keeps rendering both old and new image.
      retireId: "media-old-cover",
    });
  });

  it("omits retireId when there is no previous media row to supersede", () => {
    const plan = planLandingMediaResolution(
      "https://cdn.example/landing/shops/cards/first-upload.png",
      null,
      catalog,
      false,
    );
    expect(plan).toEqual({
      kind: "create",
      storagePath: "https://cdn.example/landing/shops/cards/first-upload.png",
    });
    expect(plan).not.toHaveProperty("retireId");
  });

  it("reuses the row when the URL already matches a catalog storage_path", () => {
    const plan = planLandingMediaResolution(
      "https://cdn.example/landing/shops/cards/old.png",
      "media-old-cover",
      catalog,
      false,
    );
    expect(plan).toEqual({
      kind: "reuse",
      id: "media-old-cover",
      needsGallerySync: false,
    });
  });

  it("flags gallery sync when reusing a path with a changed gallery opt-in", () => {
    const plan = planLandingMediaResolution(
      "https://cdn.example/landing/shops/logos/logo.png",
      "media-logo",
      catalog,
      false,
    );
    expect(plan).toEqual({
      kind: "reuse",
      id: "media-logo",
      needsGallerySync: true,
    });
  });

  it("keeps the existing id when the URL field is cleared", () => {
    const plan = planLandingMediaResolution("", "media-old-cover", catalog, true);
    expect(plan).toEqual({
      kind: "reuse",
      id: "media-old-cover",
      needsGallerySync: true,
    });
  });

  it("returns null keep when neither URL nor id is set", () => {
    const plan = planLandingMediaResolution("   ", null, catalog, false);
    expect(plan).toEqual({ kind: "keep", id: null });
  });

  it("keeps an orphan existing id that is missing from the catalog", () => {
    const plan = planLandingMediaResolution("", "orphan-id", catalog, false);
    expect(plan).toEqual({ kind: "keep", id: "orphan-id" });
  });
});
