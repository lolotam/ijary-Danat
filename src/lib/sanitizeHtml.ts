import DOMPurify from "dompurify";

/**
 * ينقّي HTML التوقيع قبل حفظه وقبل عرضه.
 *
 * Signature HTML is stored in the database and later rendered into a privileged
 * admin session with `dangerouslySetInnerHTML`, which makes an unsanitized
 * value stored XSS rather than a rendering bug. Sanitizing on write *and* on
 * render means a row written before this existed cannot execute either.
 *
 * Browser only, by design. The app never renders outbound HTML server-side, and
 * `isomorphic-dompurify` would pull jsdom into the production bundle to guard a
 * surface that does not exist. The SSR branch returns an empty string rather
 * than the input: returning it unsanitized would defeat the function in exactly
 * the environment where the caller cannot tell the difference.
 *
 * Inline styles are deliberately allowed. Mail clients strip `<style>` blocks,
 * so a signature is inline styles or it is unstyled text.
 */
export function sanitizeSignatureHtml(html: string): string {
  if (typeof window === "undefined") return "";
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "table",
      "tbody",
      "tr",
      "td",
      "img",
      "a",
      "span",
      "strong",
      "em",
      "b",
      "i",
      "u",
      "br",
      "p",
      "div",
      "small",
    ],
    ALLOWED_ATTR: [
      "href",
      "src",
      "alt",
      "width",
      "height",
      "style",
      "target",
      "rel",
      "dir",
      "cellpadding",
      "cellspacing",
    ],
    /**
     * `ALLOWED_URI_REGEXP` is NOT scoped to URI attributes — DOMPurify tests it
     * against the value of every attribute not listed as URI-safe. Without this
     * line the strict pattern below ran against `dir="rtl"`, `style="…"` and
     * `width="80"`, none of which are URLs, and dropped all of them: every
     * signature would have arrived stripped of the inline styles it is built
     * from. Only href and src are genuinely URIs here.
     */
    ADD_URI_SAFE_ATTR: [
      "dir",
      "style",
      "width",
      "height",
      "alt",
      "cellpadding",
      "cellspacing",
      "target",
      "rel",
    ],
    /**
     * Overridden rather than left default because the default blocks `data:`
     * entirely, and an inline base64 logo is a legitimate signature asset.
     */
    ALLOWED_URI_REGEXP:
      /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,)/i,
  });
}
