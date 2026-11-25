import { Table } from "@tiptap/extension-table";

import { SIGNATURE_BLOCK_ATTR } from "@/lib/signatureHtml";

/**
 * جدول TipTap موسَّع ليحتفظ بسمة التوقيع وتنسيقه بعد كل دورة تحرير.
 *
 * ProseMirror discards anything its schema does not declare. That is not a
 * cosmetic loss here: the compose body *is* the email that gets sent, so an
 * attribute the schema drops is an attribute the recipient never receives, and
 * a signature block the editor can no longer find is one it appends a second
 * copy of the next time a signature is picked.
 *
 * The base `Table` node parses `[{ tag: 'table' }]` and declares neither of
 * these, so both are added here rather than relying on the markup surviving on
 * its own — which is exactly how a wrapping `<div>` was lost before.
 *
 * It is registered instead of `TableKit`'s bundled table (`table: false`) — two
 * nodes cannot share the name `table`, and `TableKit.configure({ table })` takes
 * options, not a replacement node.
 */
export const SignatureAwareTable = Table.extend({
  /**
   * يضيف سمة التوقيع وسمة التنسيق إلى سمات الجدول الأصلية دون استبدالها.
   *
   * `this.parent?.()` is spread first so the base node's colwidth and colgroup
   * attributes survive; returning only the two new ones would strip them.
   */
  addAttributes() {
    return {
      ...this.parent?.(),
      [SIGNATURE_BLOCK_ATTR]: {
        default: null,
        parseHTML: (element) => element.getAttribute(SIGNATURE_BLOCK_ATTR),
        renderHTML: (attributes) => {
          const value = attributes[SIGNATURE_BLOCK_ATTR];
          return value ? { [SIGNATURE_BLOCK_ATTR]: value } : {};
        },
      },
      // Mail clients strip <style> blocks, so the signature's rules are inline
      // on the element. Without declaring `style` the node renders bare and the
      // signature arrives unstyled — visible only in the sent mail, never here.
      style: {
        default: null,
        parseHTML: (element) => element.getAttribute("style"),
        renderHTML: (attributes) => (attributes.style ? { style: attributes.style } : {}),
      },
    };
  },
});
