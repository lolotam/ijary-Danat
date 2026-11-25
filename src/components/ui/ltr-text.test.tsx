import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { LtrText } from "./ltr-text";

describe("LtrText", () => {
  test("forces left-to-right direction so phone numbers keep their order in RTL", () => {
    const html = renderToStaticMarkup(<LtrText>+965 1234 5678</LtrText>);
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("+965 1234 5678");
  });

  test("aligns to the start of the column rather than the left edge of the page", () => {
    // This test previously asserted `text-start` was present — the very class
    // that broke it. Paired with `dir="ltr"` on the same element, `text-align:
    // start` resolves against that element's own direction and lands on the
    // LEFT of an Arabic page, dragging the value out from under its label.
    // The rule that actually holds: the outer element carries no `dir`, so it
    // inherits the page's, and only the inner span is marked LTR.
    const html = renderToStaticMarkup(<LtrText as="p">a@b.test</LtrText>);

    expect(html).toMatch(/^<p[^>]*>/);
    expect(html.slice(0, html.indexOf(">"))).not.toContain("dir=");
    expect(html).toContain('<span dir="ltr">a@b.test</span>');
  });

  test("renders as another element when block layout is needed", () => {
    // `[>\s]` rather than a bare space: with `dir` moved to the inner span, a
    // caller who passes no className now yields a bare `<p>` with no attributes.
    expect(renderToStaticMarkup(<LtrText as="p">x@y.test</LtrText>)).toMatch(/^<p[>\s]/);
  });

  test("keeps caller classes alongside the alignment default", () => {
    expect(renderToStaticMarkup(<LtrText className="font-medium">z</LtrText>)).toContain(
      "font-medium",
    );
  });
});

/**
 * Journey 6, 2026-07-31 — this defect has now shipped twice, in mirror image,
 * and no test saw it either time:
 *
 *   PR #34  the tenant form treated `tel` inputs but not `email`
 *   PR #43  the Inbox wrapped `email` but not the `phone` directly beside it
 *
 * On an Arabic page the untreated one reverses: `+965 51234567` rendered as
 * `51234567 965+`. Both were caught by looking at a screen, because the two
 * values sit side by side in the same row and only one was ever handled.
 *
 * The rule worth guarding is therefore the *pairing*: in a table that shows both
 * a contact number and an email as display text, either both go through LtrText
 * or neither does. Reading the source is the only way to check a rendering rule
 * spanning several routes without mounting each one.
 */
const CONTACT_TABLES = [
  "src/routes/admin.inbox.tsx",
  "src/routes/admin.settings.users.tsx",
  // The users table moved out of that route (audit M13); the guard follows it.
  "src/components/admin/users/UsersTable.tsx",
  "src/routes/admin.tenants.index.tsx",
  "src/components/admin/tenants/TenantsTable.tsx",
  // The brand card on the public landing page and its admin preview. Both were
  // fixed in the same pass and both render a phone inside a `tel:` link — and
  // the landing page is the one Arabic surface a customer actually sees.
  "src/routes/index.tsx",
  "src/routes/admin.settings.landing-page.tsx",
  // Tenant portal profile shows mobile + email side by side on Arabic pages.
  "src/routes/portal.profile.tsx",
];

describe("contact values are never left half-treated", () => {
  test.each(CONTACT_TABLES)("%s wraps phone and email consistently", (file) => {
    // Remove everything already inside an LtrText wrapper, then anything left
    // that renders a contact value as page text is untreated.
    const unwrapped = readFileSync(join(process.cwd(), file), "utf8").replace(
      /<LtrText[\s\S]*?<\/LtrText>/g,
      "",
    );

    // Display renders only — `{row.phone}` as JSX content. Excludes prop values
    // (`value={x.email}`, `phone={x.whatsapp}`), template hrefs
    // (`tel:${x.phone}`) and member access
    // on the left of a dot, none of which reach the page as text.
    // Terminator is `}` or `??` only. A bare `?` would also match
    // `{brand.phone ? (…) : null}`, which is a conditional, not a render.
    const bare = [
      ...unwrapped.matchAll(/(?<![\w.$])\{\s*(\w+)\.(phone|mobile|whatsapp|email)\s*(?:\}|\?\?)/g),
    ]
      .filter((match) => {
        const before = unwrapped.slice(Math.max(0, match.index - 40), match.index);
        return !/(?:value|checked|href|phone|placeholder|defaultValue|aria-\w+)=\s*$/.test(before);
      })
      .map((match) => `${match[1]}.${match[2]}`);

    expect(bare).toEqual([]);
  });
});
