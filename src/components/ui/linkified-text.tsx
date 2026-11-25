import type { ReactNode } from "react";

import { splitTextLinks, toLinkHref } from "@/lib/linkify";

/**
 * يعرض نص رسالة عادياً مع تحويل الروابط داخله إلى روابط قابلة للنقر تفتح في تبويب جديد.
 *
 * WhatsApp's own clients linkify message text at render time; the message
 * bodies we store are plain text, so a portal link that a tenant can tap on
 * their phone was dead text in this app's chat view until this ran over it.
 * `rel="noreferrer"` is not optional on a `_blank` link — without it the opened
 * page gets a handle on this one through `window.opener`.
 */
export function LinkifiedText({ text }: { text: string }): ReactNode {
  return splitTextLinks(text).map((segment, index) =>
    segment.kind === "link" ? (
      <a
        key={index}
        href={toLinkHref(segment.value)}
        target="_blank"
        rel="noreferrer"
        dir="ltr"
        className="underline underline-offset-2 hover:no-underline"
      >
        {segment.value}
      </a>
    ) : (
      <span key={index}>{segment.value}</span>
    ),
  );
}
