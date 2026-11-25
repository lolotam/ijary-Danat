import { useMemo, useState } from "react";
import { ImageOff, Images } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

/**
 * Rendering mail HTML written by strangers, inside an authenticated admin
 * session.
 *
 * Two controls, and the first is the one that matters:
 *
 * 1. A `sandbox` iframe with **no** `allow-scripts`. Script execution is
 *    impossible — not filtered, impossible — and the frame gets an opaque
 *    origin, so it cannot reach the parent DOM, the Supabase session, or
 *    cookies. This holds even against markup no sanitiser anticipated, which is
 *    why it is preferred over scrubbing the HTML and injecting it directly.
 *
 * 2. Remote content blocked by default via an injected CSP, with an explicit
 *    opt-in. Remote images in mail are tracking pixels: loading one tells the
 *    sender the message was opened, when, and from which IP. Defaulting to
 *    "load everything" would leak that on every message an admin so much as
 *    glances at.
 *
 * `allow-same-origin` is deliberately absent. Combined with `allow-scripts` it
 * would let the frame remove its own sandbox; alone it is simply unnecessary.
 */

/** Blocks every remote fetch the frame could attempt. */
const CSP_BLOCK_ALL =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;";

/** Images permitted (including remote), everything else still denied. */
const CSP_ALLOW_IMAGES =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:;";

function buildSrcDoc(html: string, allowImages: boolean, isRtl: boolean): string {
  return `<!doctype html>
<html dir="${isRtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${allowImages ? CSP_ALLOW_IMAGES : CSP_BLOCK_ALL}">
<base target="_blank">
<style>
  body { margin:0; padding:12px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         font-size:14px; line-height:1.6; color:#111; background:#fff; word-wrap:break-word; }
  img, table { max-width:100%; height:auto; }
  table { border-collapse:collapse; }
  a { color:#1a73e8; }
  blockquote { margin:0 0 0 8px; padding-left:12px; border-left:2px solid #ddd; color:#555; }
</style>
</head>
<body>${html}</body>
</html>`;
}

export function GmailMessageBody({ html, text }: { html: string | null; text: string | null }) {
  const { t, locale } = useI18n();
  const [allowImages, setAllowImages] = useState(false);

  // Only offer the toggle when the message actually references remote content,
  // so it does not appear on the plain-text mail where it would do nothing.
  const hasRemoteContent = useMemo(
    () => Boolean(html && /<img[^>]+src=["']?https?:/i.test(html)),
    [html],
  );

  const srcDoc = useMemo(
    () => (html ? buildSrcDoc(html, allowImages, locale === "ar") : null),
    [html, allowImages, locale],
  );

  if (!srcDoc) {
    return (
      <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-sans text-sm leading-relaxed">
        {text || t("inbox.noContent")}
      </pre>
    );
  }

  return (
    <div className="space-y-2">
      {hasRemoteContent && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          {allowImages ? (
            <Images className="size-4 shrink-0" />
          ) : (
            <ImageOff className="size-4 shrink-0" />
          )}
          <span className="flex-1">
            {allowImages ? t("inbox.imagesShown") : t("inbox.imagesBlocked")}
          </span>
          <Button size="sm" variant="outline" onClick={() => setAllowImages((v) => !v)}>
            {allowImages ? t("inbox.hideImages") : t("inbox.showImages")}
          </Button>
        </div>
      )}
      <iframe
        // Empty sandbox = every restriction applied. Scripts cannot run.
        sandbox=""
        srcDoc={srcDoc}
        title={t("inbox.messageBody")}
        className="h-[45vh] w-full rounded-md border bg-white"
      />
    </div>
  );
}
