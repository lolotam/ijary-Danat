import { describe, expect, test } from "vitest";

import {
  DEFAULT_MAX_DIMENSION,
  compressImageFile,
  fitWithinBounds,
  mimeTypeFromPath,
  shouldSkipCompression,
  withExtension,
} from "./imageCompression";

describe("fitWithinBounds", () => {
  /*
   * An image at or under the bound must come back byte-identical in dimensions.
   * Scaling unconditionally would upscale a 64px logo to 1600px — more bytes for
   * detail that is not in the source.
   */
  test.each([
    [800, 600, 1600],
    [64, 64, DEFAULT_MAX_DIMENSION],
    [1600, 900, 1600],
  ])("%ix%i within a %i bound is returned unchanged", (width, height, bound) => {
    expect(fitWithinBounds(width, height, bound)).toEqual({ width, height });
  });

  test.each([
    ["landscape", 4000, 3000, 1600, { width: 1600, height: 1200 }],
    ["portrait", 3000, 4000, 1600, { width: 1200, height: 1600 }],
    ["square", 2048, 2048, 512, { width: 512, height: 512 }],
  ])("scales a %s image by its longest edge", (_shape, width, height, bound, expected) => {
    expect(fitWithinBounds(width, height, bound)).toEqual(expected);
  });

  test("preserves the aspect ratio to within a rounded pixel", () => {
    const { width, height } = fitWithinBounds(3968, 2232, 1600);
    expect(width).toBe(1600);
    expect(Math.abs(width / height - 3968 / 2232)).toBeLessThan(0.01);
  });

  test("never collapses an extreme ratio to a zero-pixel edge", () => {
    // A 6000x3 panorama scaled to 512 rounds the short edge to 0 without the
    // Math.max guard, and a 0-height canvas throws on drawImage.
    expect(fitWithinBounds(6000, 3, 512).height).toBe(1);
  });

  test("returns a degenerate 0x0 input unchanged, never dividing by zero", () => {
    // Reaches the already-fits branch (0 <= 1600), so `scale` is never computed.
    expect(fitWithinBounds(0, 0, 1600)).toEqual({ width: 0, height: 0 });
  });
});

describe("shouldSkipCompression", () => {
  test.each(["image/png", "image/jpeg", "image/webp"])("%s is compressed", (type) => {
    expect(shouldSkipCompression(type)).toBe(false);
  });

  /*
   * Each of these is skipped for a different reason, and getting any of them
   * wrong corrupts the upload rather than merely failing to shrink it: SVG is
   * vector and rasterising discards the scaling that made it worth using, GIF
   * loses every frame but the first, and a non-image has nothing to decode.
   */
  test.each([
    ["image/svg+xml", "vector art must not be rasterised"],
    ["image/gif", "animation would be reduced to one frame"],
    ["application/pdf", "not an image at all"],
    ["", "no type reported by the browser"],
  ])("%s is skipped — %s", (type) => {
    expect(shouldSkipCompression(type)).toBe(true);
  });
});

describe("withExtension", () => {
  test.each([
    ["cover.png", "cover.webp"],
    ["shop.logo.final.PNG", "shop.logo.final.webp"],
    ["screenshot", "screenshot.webp"],
    [".png", "image.webp"],
    ["shops/cards/cover", "shops/cards/cover.webp"],
  ])("%s -> %s", (input, expected) => {
    expect(withExtension(input, "webp")).toBe(expected);
  });
});

describe("compressImageFile", () => {
  test("returns the original file for a format it must not re-encode", async () => {
    const svg = new File(["<svg />"], "logo.svg", { type: "image/svg+xml" });
    await expect(compressImageFile(svg)).resolves.toBe(svg);
  });

  test("returns the original file when the browser image APIs are unavailable", async () => {
    // Asserting the premise, not the framework: the suite runs under
    // `environment: "node"`, so `document` is genuinely absent and this exercises
    // the guard that keeps an upload working on a runtime that cannot decode.
    // Without this line, switching the suite to jsdom would leave the test
    // passing for an entirely different reason.
    expect(typeof document).toBe("undefined");
    const png = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });
    const result = await compressImageFile(png, 512);
    expect(result).toBe(png);
    expect(result.name).toBe("cover.png");
  });
});

describe("mimeTypeFromPath", () => {
  test.each([
    ["shops/cards/cover.webp", "image/webp"],
    ["hero.PNG", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["banner.svg", "image/svg+xml"],
    ["loop.gif", "image/gif"],
    ["next-gen.avif", "image/avif"],
  ])("%s -> %s", (path, expected) => {
    expect(mimeTypeFromPath(path)).toBe(expected);
  });

  test("reads through a signed-URL query string", () => {
    // Landing media rows can hold a pasted URL, not only a bucket path, and a
    // token appended after the extension must not defeat the lookup.
    expect(mimeTypeFromPath("https://cdn.example.com/a/b.webp?token=abc&v=2")).toBe("image/webp");
  });

  test("reads through a URL fragment", () => {
    expect(mimeTypeFromPath("https://cdn.example.com/a/b.jpg#preview")).toBe("image/jpeg");
  });

  test.each([
    ["https://cdn.example.com/image", "no extension at all"],
    ["archive.tar", "an extension that is not an image"],
  ])("%s falls back to png — %s", (path) => {
    // A wrong-ish content type beats blocking a save the admin is mid-way
    // through; the object itself is still served from Storage's own xattrs.
    expect(mimeTypeFromPath(path)).toBe("image/png");
  });
});
