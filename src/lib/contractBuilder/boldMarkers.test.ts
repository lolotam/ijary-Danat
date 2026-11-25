import { describe, expect, test } from "vitest";

import { BOLD_CLOSE, BOLD_OPEN, renderBold, stripBoldMarkers, v } from "./boldMarkers";
import { esc } from "./html";

describe("v", () => {
  test("wraps the value in the bold markers", () => {
    expect(v("5")).toBe(`${BOLD_OPEN}5${BOLD_CLOSE}`);
  });

  test("accepts numbers without stringifying the markers", () => {
    expect(v(2500)).toBe(`${BOLD_OPEN}2500${BOLD_CLOSE}`);
  });

  test("strips embedded markers before wrapping, so a typed value cannot open its own tag", () => {
    expect(v(`${BOLD_OPEN}x${BOLD_CLOSE}`)).toBe(`${BOLD_OPEN}x${BOLD_CLOSE}`);
  });
});

describe("renderBold", () => {
  test("turns markers into <strong> only after escaping, so a value cannot smuggle a tag", () => {
    expect(renderBold(esc(v("<b>x</b>")))).toBe("<strong>&lt;b&gt;x&lt;/b&gt;</strong>");
  });

  test.each([["a\u0001b"], ["a\u0002b"]])(
    "leaves an unpaired marker (%s) as plain text",
    (text) => {
      expect(renderBold(text)).toBe(text);
      expect(renderBold(text)).not.toContain("<strong>");
    },
  );
});

describe("stripBoldMarkers", () => {
  test("removes both markers and keeps the text", () => {
    expect(stripBoldMarkers(`${BOLD_OPEN}5${BOLD_CLOSE}`)).toBe("5");
  });

  test("leaves marker-free text untouched", () => {
    expect(stripBoldMarkers("plain text 123")).toBe("plain text 123");
  });
});
