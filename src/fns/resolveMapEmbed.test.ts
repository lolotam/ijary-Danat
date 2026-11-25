import { describe, expect, test } from "vitest";

import { coordinatesFrom, embedSrcForResolvedUrl, isAllowedHost } from "./resolveMapEmbed";

describe("isAllowedHost", () => {
  test("accepts Google map hosts over https", () => {
    expect(isAllowedHost("https://maps.app.goo.gl/xYzcRnaKgnzAehSn7")).toBe(true);
    expect(isAllowedHost("https://www.google.com/maps/place/Danat")).toBe(true);
    expect(isAllowedHost("https://google.com.kw/maps")).toBe(true);
  });

  test("rejects the hosts an SSRF would aim for", () => {
    // A short link is attacker-controlled and may redirect anywhere; every hop
    // is re-checked against this, so these must never pass.
    expect(isAllowedHost("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedHost("https://127.0.0.1:8000/")).toBe(false);
    expect(isAllowedHost("https://localhost/admin")).toBe(false);
    expect(isAllowedHost("file:///etc/passwd")).toBe(false);
  });

  test("rejects look-alike hostnames and plaintext google", () => {
    expect(isAllowedHost("https://notgoogle.com/maps")).toBe(false);
    expect(isAllowedHost("https://google.com.evil.example/maps")).toBe(false);
    expect(isAllowedHost("http://www.google.com/maps")).toBe(false);
  });
});

describe("coordinatesFrom", () => {
  test("reads the @lat,lng form used by desktop map URLs", () => {
    expect(coordinatesFrom("https://www.google.com/maps/@29.3375,47.6581,17z")).toBe(
      "29.3375,47.6581",
    );
  });

  test("reads the !3d/!4d form embedded in place URLs", () => {
    expect(coordinatesFrom("https://www.google.com/maps/place/X/data=!3d29.3375!4d47.6581")).toBe(
      "29.3375,47.6581",
    );
  });

  test("returns null when no coordinates are present", () => {
    expect(coordinatesFrom("https://maps.app.goo.gl/xYzcRnaKgnzAehSn7")).toBeNull();
  });
});

describe("embedSrcForResolvedUrl", () => {
  test("passes an existing embed URL through untouched", () => {
    const embed = "https://www.google.com/maps/embed?pb=!1m18";
    expect(embedSrcForResolvedUrl(embed)).toBe(embed);
  });

  test("prefers coordinates over the place name", () => {
    const src = embedSrcForResolvedUrl(
      "https://www.google.com/maps/place/Danat/@29.3375,47.6581,17z",
    );
    expect(src).toBe("https://www.google.com/maps?q=29.3375%2C47.6581&output=embed");
  });

  test("falls back to the place name when there are no coordinates", () => {
    expect(embedSrcForResolvedUrl("https://www.google.com/maps/place/Danat+Al+Jahra")).toBe(
      "https://www.google.com/maps?q=Danat%20Al%20Jahra&output=embed",
    );
  });

  test("returns null when nothing embeddable can be derived, so the page links out", () => {
    expect(embedSrcForResolvedUrl("https://maps.app.goo.gl/xYzcRnaKgnzAehSn7")).toBeNull();
  });
});
