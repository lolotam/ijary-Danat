import { describe, expect, test } from "vitest";

import { maskReplayAttribute } from "./posthogReplayAttributes";

const TENANT = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

describe("maskReplayAttribute", () => {
  test.each([
    // URL attributes: redacted, not blanked, so the replay keeps the route.
    ["an admin link loses the record ID", "href", `/admin/tenants/${TENANT}`, "/admin/tenants/:id"],
    ["a portal link loses its query", "href", `/portal?tenant=${TENANT}`, "/portal"],
    ["a phone link hides the number", "href", "tel:+96599887766", "tel:***"],
    ["an email link hides the address", "href", "mailto:tenant@example.com", "mailto:***"],
    [
      "a signed document image loses its token",
      "src",
      "https://supabase.danat-future.com/storage/v1/object/sign/tenant-documents/civil-id.jpg?token=eyJ",
      "https://supabase.danat-future.com/storage/v1/object/sign/tenant-documents/civil-id.jpg",
    ],
    // Codex review, PR #258: rrweb renames a cross-origin iframe's src to rr_src.
    [
      "a cross-origin iframe's rr_src loses its signed token",
      "rr_src",
      "https://supabase.danat-future.com/storage/v1/object/sign/deposit-attachments/receipt.pdf?token=eyJ",
      "https://supabase.danat-future.com/storage/v1/object/sign/deposit-attachments/receipt.pdf",
    ],
    // Codex review, PR #258: the WhatsApp pairing QR is a data: image.
    ["a data: image payload is emptied", "src", "data:image/png;base64,iVBORw0KGgo=", "data:,"],
    // Codex review, PR #258: document-relative references are URLs too.
    ["a relative image loses its token", "src", "hero.jpg?token=SECRET", "hero.jpg"],
    ["a query-only link loses the tenant", "href", `?tenant=${TENANT}`, ""],
    ["a relative path loses its record ID", "href", `tenants/${TENANT}/edit`, "tenants/:id/edit"],
    ["an in-page anchor keeps only the #", "href", "#main-content", "#"],
    [
      "a hashed build asset still loads",
      "src",
      "/assets/logo-B1x2Yz9Q.png",
      "/assets/logo-B1x2Yz9Q.png",
    ],
    // Codex review, PR #258: only same-origin build files are exempt.
    [
      "an external /assets/ URL is redacted like any other",
      "src",
      `https://cdn.example.com/assets/${TENANT}.png?token=abc`,
      "https://cdn.example.com/assets/:id",
    ],
    [
      "every srcset candidate is redacted, descriptors kept",
      "srcset",
      "https://cdn.example.com/m.jpg?token=abc 1x, /assets/m-B1x2Yz9Q.jpg 2x",
      "https://cdn.example.com/m.jpg 1x, /assets/m-B1x2Yz9Q.jpg 2x",
    ],
    ["a data: srcset is emptied whole", "srcset", "data:image/png;base64,iVBOR,xyz 1x", "data:,"],
    // Codex review, PR #258: a comma inside the URL is not a candidate separator.
    [
      "a srcset URL containing a comma still loses its token",
      "srcset",
      "https://cdn.example.com/photo.jpg?crop=10,20&token=SECRET 1x",
      "https://cdn.example.com/photo.jpg 1x",
    ],
    ["an unparseable srcset is emptied whole", "srcset", "a.jpg 1x,b.jpg?token=S 2x", ""],
    [
      "a style keeps its layout but loses a signed background URL",
      "style",
      "width: 10px; background-image: url('https://s.example.com/a.jpg?token=x')",
      "width: 10px; background-image: url('https://s.example.com/a.jpg')",
    ],
    // Layout and state attributes pass, with any UUID replaced.
    [
      "an ordinary class is untouched",
      "class",
      "rounded-full bg-primary",
      "rounded-full bg-primary",
    ],
    ["a component state flag is untouched", "data-state", "open", "open"],
    // Codex review, PR #258: the collapsed sidebar is styled by this flag.
    ["the sidebar's collapsible flag is kept", "data-collapsible", "icon", "icon"],
    ["a UUID in an element id is replaced", "id", `row-${TENANT}`, "row-:id"],
    // Codex review, PR #258: rrweb's own metadata must survive or replays break.
    [
      "rrweb's inlined app stylesheet is kept",
      "_cssText",
      ".bg-primary{background:#0e0d0b}",
      ".bg-primary{background:#0e0d0b}",
    ],
    ["a blocked element's placeholder keeps its position", "rr_position", "relative", "relative"],
    ["a canvas bitmap is blanked", "rr_dataURL", "data:image/png;base64,iVBOR", ""],
    // Everything else fails closed.
    // Codex review, PR #258: admin previews put whole contracts in srcdoc.
    [
      "an iframe srcdoc is blanked",
      "srcdoc",
      "<html><body>Contract for أحمد, civil ID 2850…</body></html>",
      "",
    ],
    ["a tooltip naming a tenant is blanked", "title", "أحمد الكندري", ""],
    ["an aria-label naming a tenant is blanked", "aria-label", "Edit Ahmed", ""],
    ["a free-form data attribute is blanked", "data-tenant-name", "Ahmed", ""],
    ["an attribute nobody listed is blanked", "x-future-attribute", "anything", ""],
  ])("%s", (_scenario, name, value, expected) => {
    expect(maskReplayAttribute(name, value)).toBe(expected);
  });
});
