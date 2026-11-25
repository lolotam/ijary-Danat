/** جزء من نص الرسالة: إما نص عادي أو رابط قابل للنقر. */
export type TextSegment = { kind: "text"; value: string } | { kind: "link"; value: string };

/**
 * نمط يلتقط الروابط داخل نص عادي: ما يبدأ بـ http/https أو بـ `www.`.
 *
 * The trailing class excludes whitespace, quotes and angle brackets only — a
 * URL may legitimately contain `#`, `?`, `=` and `%`, and the credentials
 * message ships `https://danat-future.com/portal` on a line of its own.
 */
const URL_PATTERN = String.raw`(?:https?:\/\/|www\.)[^\s<>"'\`]+`;

/**
 * علامات ترقيم تلتصق بنهاية الرابط في الجملة ولا تُعدّ جزءاً منه.
 *
 * The Arabic marks — `،` comma, `؛` semicolon, `؟` question mark, `۔` full
 * stop — matter more here than the Latin ones: Arabic is the product's primary
 * language, so a sentence ending a link is far likelier to end it with one of
 * these, and `…/portal،` is a different path that 404s.
 */
const TRAILING_PUNCTUATION = /[.,;:!?»”’\]،؛؟۔]+$/;

/**
 * يقصّ علامات الترقيم اللاصقة بنهاية الرابط مع إبقاء الأقواس المتوازنة.
 *
 * Written as a loop rather than one regex because a closing paren is only junk
 * when it has no opener inside the URL — `…/wiki/Kuwait_(city)` keeps its `)`,
 * while `(see https://x.test/a)` does not.
 */
function trimTrailing(url: string): string {
  let value = url;
  for (;;) {
    const stripped = value.replace(TRAILING_PUNCTUATION, "");
    if (stripped !== value) {
      value = stripped;
      continue;
    }
    const unclosed = value.split(")").length > value.split("(").length;
    if (value.endsWith(")") && unclosed) {
      value = value.slice(0, -1);
      continue;
    }
    return value;
  }
}

/**
 * يقسّم نص الرسالة إلى مقاطع نصية وروابط، مع الحفاظ على النص كاملاً.
 *
 * Exported separately from the component so the splitting rules can be tested
 * without rendering: joining every segment's `value` must reproduce the input
 * exactly, which is what keeps a message from silently losing characters.
 */
export function splitTextLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  // A fresh regex per call: a module-level /g regex carries `lastIndex` between
  // calls, and one early return would make the next message start mid-string.
  const pattern = new RegExp(URL_PATTERN, "gi");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const url = trimTrailing(match[0]);
    if (!url) continue;
    if (match.index > cursor) {
      segments.push({ kind: "text", value: text.slice(cursor, match.index) });
    }
    segments.push({ kind: "link", value: url });
    cursor = match.index + url.length;
    pattern.lastIndex = cursor;
  }
  if (cursor < text.length) segments.push({ kind: "text", value: text.slice(cursor) });
  return segments;
}

/** يضيف البروتوكول للروابط المكتوبة بصيغة `www.` حتى لا تُفسَّر كمسار نسبي. */
export function toLinkHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
