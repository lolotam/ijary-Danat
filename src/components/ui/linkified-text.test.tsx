import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { splitTextLinks } from "@/lib/linkify";

import { LinkifiedText } from "./linkified-text";

describe("splitTextLinks", () => {
  test("keeps every character of the message when splitting", () => {
    const text = "مرحباً\nرابط البوابة: https://danat-future.com/portal\nشكراً";
    expect(
      splitTextLinks(text)
        .map((s) => s.value)
        .join(""),
    ).toBe(text);
  });

  test("finds the portal link the credentials message ships on its own line", () => {
    const segments = splitTextLinks("اسم المستخدم: ali\nhttps://danat-future.com/portal");
    expect(segments.filter((s) => s.kind === "link").map((s) => s.value)).toEqual([
      "https://danat-future.com/portal",
    ]);
  });

  test("leaves a message with no URL as a single text segment", () => {
    expect(splitTextLinks("لا يوجد رابط هنا")).toEqual([
      { kind: "text", value: "لا يوجد رابط هنا" },
    ]);
  });

  test("drops a sentence's trailing punctuation from the link", () => {
    // The href must not carry the full stop: danat-future.com/portal. is a
    // different path and 404s.
    expect(splitTextLinks("افتح https://danat-future.com/portal.")).toEqual([
      { kind: "text", value: "افتح " },
      { kind: "link", value: "https://danat-future.com/portal" },
      { kind: "text", value: "." },
    ]);
  });

  test("drops Arabic sentence punctuation from the link", () => {
    // Arabic is the primary language, so this is the common shape, not an edge
    // case: `…/portal،` is a different path and 404s.
    for (const mark of ["،", "؛", "؟", "۔"]) {
      expect(splitTextLinks(`افتح https://danat-future.com/portal${mark} شكراً`)).toEqual([
        { kind: "text", value: "افتح " },
        { kind: "link", value: "https://danat-future.com/portal" },
        { kind: "text", value: `${mark} شكراً` },
      ]);
    }
  });

  test("keeps a closing paren that the URL itself opened", () => {
    const [link] = splitTextLinks("https://x.test/a_(b)");
    expect(link).toEqual({ kind: "link", value: "https://x.test/a_(b)" });
  });

  test("finds several links in one body", () => {
    const links = splitTextLinks("a https://x.test b www.y.test c").filter(
      (s) => s.kind === "link",
    );
    expect(links.map((s) => s.value)).toEqual(["https://x.test", "www.y.test"]);
  });
});

describe("LinkifiedText", () => {
  test("renders the portal URL as an anchor that opens in a new tab", () => {
    const html = renderToStaticMarkup(<LinkifiedText text="https://danat-future.com/portal" />);
    expect(html).toContain('href="https://danat-future.com/portal"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  test("gives a www-only link an https scheme so it is not read as a relative path", () => {
    expect(renderToStaticMarkup(<LinkifiedText text="www.danat-future.com/portal" />)).toContain(
      'href="https://www.danat-future.com/portal"',
    );
  });

  test("renders plain text without any anchor", () => {
    expect(renderToStaticMarkup(<LinkifiedText text="مرحباً بك" />)).not.toContain("<a ");
  });
});
