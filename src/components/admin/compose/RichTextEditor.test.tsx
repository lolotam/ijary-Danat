import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/admin/compose/RichTextEditor.tsx"),
  "utf8",
);

/**
 * يزيل التعليقات قبل البحث عن استدعاءات فعلية في الشيفرة.
 *
 * Without this, a comment saying "not window.prompt()" fails the very assertion
 * that exists to ban the call — the guard would be tripped by its own rationale.
 */
const CODE_ONLY = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("RichTextEditor", () => {
  it("does not build a ProseMirror view during SSR", () => {
    // TanStack Start renders this on the server. TipTap v3 builds its view
    // immediately by default, which needs a `document` that does not exist
    // there, and the mismatch surfaces as a hydration error rather than a clear
    // crash.
    expect(SOURCE).toMatch(/immediatelyRender:\s*false/);
  });

  it("keeps table and image in the schema", () => {
    // ProseMirror discards nodes its schema does not know. The signature is a
    // <table> with an <img> logo; without these it round-trips to flat text and
    // the logo disappears.
    expect(SOURCE).toMatch(/TableKit/);
    expect(SOURCE).toMatch(/\bImage\b/);
  });

  it("registers the direction extension", () => {
    // The product is Arabic-first; an editor that cannot set direction per block
    // can only write one language per message.
    expect(SOURCE).toMatch(/TextDirection/);
  });

  it("guards setContent so the caret does not reset on every keystroke", () => {
    // setContent unconditionally on each render rebuilds the document and drops
    // the selection, sending the caret to position 0 as the admin types.
    expect(SOURCE).toMatch(/if \(editor\.getHTML\(\) === value\) return;/);
  });

  it("uses a popover for the link prompt, never window.prompt", () => {
    // Native dialogs block every subsequent browser event and hard-freeze this
    // project's browser automation.
    expect(CODE_ONLY).not.toMatch(/\bprompt\(/);
    expect(CODE_ONLY).not.toMatch(/\bconfirm\(/);
    expect(CODE_ONLY).not.toMatch(/\balert\(/);
    // And the replacement is actually there.
    expect(CODE_ONLY).toMatch(/PopoverContent/);
  });

  it("labels every toolbar control for assistive tech", () => {
    // Icon-only buttons are unusable without this, and the toolbar is entirely
    // icon-only.
    expect(SOURCE).toMatch(/aria-label=\{label\}/);
  });
});
