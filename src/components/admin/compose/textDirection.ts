import { Extension } from "@tiptap/core";

/**
 * يضيف خاصية الاتجاه (rtl/ltr) لكل فقرة وعنوان في المحرّر.
 *
 * TipTap ships no direction extension, and this product is Arabic-first with an
 * RTL admin console. Direction has to be per block rather than one setting for
 * the whole message: replying in Arabic above a quoted English thread is the
 * normal case in this mailbox, not a corner case.
 *
 * The attribute is rendered onto the element so it survives into the sent HTML,
 * where the recipient's mail client is the thing actually doing the layout —
 * a class or an editor-only setting would be stripped on the way out.
 */
export const TextDirection = Extension.create({
  name: "textDirection",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          dir: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute("dir"),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.dir ? { dir: attributes.dir as string } : {},
          },
        },
      },
    ];
  },
});
