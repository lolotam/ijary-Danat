import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { plainTextToHtml } from "@/components/admin/compose/GmailComposeDialog";

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/admin/compose/GmailComposeDialog.tsx"),
  "utf8",
);
const SHEET = readFileSync(
  join(process.cwd(), "src/components/admin/GmailMessageSheet.tsx"),
  "utf8",
);

describe("plainTextToHtml", () => {
  it("keeps line breaks that the editor would otherwise collapse", () => {
    // A quoted reply is many short lines. Handed to the editor as one string
    // they become a single paragraph and the quote becomes unreadable.
    expect(plainTextToHtml("one\ntwo")).toBe("<p>one</p><p>two</p>");
  });

  it("preserves a blank line as an empty paragraph", () => {
    expect(plainTextToHtml("a\n\nb")).toBe("<p>a</p><p><br></p><p>b</p>");
  });

  it("escapes markup from the quoted message", () => {
    // The parent message is attacker-controlled text arriving from outside.
    const html = plainTextToHtml("<script>alert(1)</script>");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the ampersand before the angle brackets", () => {
    // Escaping & last would double-encode the entities produced just before it.
    expect(plainTextToHtml("a & <b>")).toBe("<p>a &amp; &lt;b&gt;</p>");
  });
});

describe("GmailComposeDialog", () => {
  it("treats TipTap's empty document as empty", () => {
    // An empty editor returns "<p></p>", which is truthy. Guarding on the raw
    // HTML would let Send fire on a blank message.
    expect(SOURCE).toMatch(/plainTextFrom\(draft\.html\)/);
  });

  it("accepts a bcc-only send", () => {
    // Addressing every tenant produces exactly that. A !to.length guard would
    // reject it before the server ever saw it.
    expect(SOURCE).toMatch(/!to\.length && !cc\.length && !bcc\.length/);
  });

  it("sends both a text and an html part", () => {
    // A text-only client handed nothing renders a blank message.
    expect(SOURCE).toMatch(/body: plainTextFrom\(html\)/);
    expect(SOURCE).toMatch(/^\s+html,$/m);
  });

  it("injects the signature into the body and never appends it at send", () => {
    // The signature is now shown in the message body so the admin can see and
    // edit what will be sent. That makes the old append-at-send a duplicate, so
    // there must be exactly one injection site and no append site at all.
    expect(SOURCE).toMatch(/onSelect=\{selectSignature\}/);
    expect(SOURCE.match(/applySignatureToBody\(/g) ?? []).toHaveLength(1);
    expect(SOURCE).not.toMatch(/wrapSignature\(/);
  });

  it("clears the selected signature when the dialog is reseeded", () => {
    // A reseeded body carries no signature. Leaving the selection behind would
    // show one picked while none is in the message — and, with the append gone,
    // send without one.
    //
    // Anchored to setDraft(seed) rather than grepping for the bare call: the
    // clear only means anything inside the reseed effect, and a loose match
    // would pass on the same literal appearing anywhere else in the file.
    expect(SOURCE).toMatch(/setDraft\(seed\);[\s\S]{0,500}?setSignature\(null\);/);
  });

  it("keeps one address parser", () => {
    expect(SOURCE).not.toMatch(/function splitAddresses/);
    expect(SOURCE).toMatch(/parseAddresses/);
  });

  it("carries the quoted message into reply and forward seeds", () => {
    // The editor binds to draft.html. A seed that only set `body` would open an
    // empty editor and silently drop what the admin is replying to.
    expect(SHEET).toMatch(/html: plainTextToHtml\(quoteForReply\(/);
    expect(SHEET).toMatch(/html: plainTextToHtml\(forwardPreamble\(/);
  });
});
