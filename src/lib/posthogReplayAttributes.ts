import { redactUrl } from "./posthogPrivacy";

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Layout, styling and state attributes a replay needs to render and that
// carry no tenant data. Everything not listed here, and not a URL attribute,
// is blanked: failing closed is the point (Codex review, PR #258 — `srcdoc`
// full of contract HTML, `rr_src` with a signed PDF token).
const SAFE_ATTRIBUTES = new Set([
  "class",
  "style",
  "id",
  "role",
  "type",
  "dir",
  "lang",
  "hidden",
  "tabindex",
  "disabled",
  "readonly",
  "required",
  "checked",
  "selected",
  "open",
  "width",
  "height",
  "colspan",
  "rowspan",
  "for",
  "name",
  "target",
  "rel",
  "loading",
  "decoding",
  "crossorigin",
  "sizes",
  "media",
  "autocomplete",
  "inputmode",
  "maxlength",
  "min",
  "max",
  "step",
  "draggable",
  "spellcheck",
  "viewbox",
  "xmlns",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "fill-rule",
  "clip-rule",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "points",
  "transform",
  "opacity",
  "aria-hidden",
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "aria-disabled",
  "aria-current",
  "aria-haspopup",
  "aria-orientation",
  "aria-modal",
  "aria-live",
  "aria-busy",
  "aria-invalid",
  "aria-sort",
  // rrweb-generated metadata (Codex review, PR #258). `_cssText` is our own
  // stylesheet, inlined in place of the <link>; blanking it leaves every
  // replay unstyled. The rr_* geometry keeps a ph-no-capture placeholder the
  // same size and in the same place. `rr_dataURL` is deliberately absent: it
  // is a canvas bitmap and can hold anything drawn on it.
  "_csstext",
  "rr_position",
  "rr_left",
  "rr_top",
  "rr_display",
  "rr_transform",
  "rr_medialoop",
  "rr_width",
  "rr_height",
  "rr_scrolltop",
  "rr_scrollleft",
  "rr_mediastate",
  "rr_mediacurrenttime",
  "rr_mediaplaybackrate",
  "rr_mediamuted",
  "rr_mediavolume",
]);
// Component-library state flags (`data-state="open"`, `data-side="top"`,
// Radix/Sonner/cmdk internals) drive styling; free-form data-* attributes do not.
const SAFE_DATA_ATTRIBUTE =
  /^data-(state|side|align|orientation|slot|disabled|highlighted|placeholder|swipe|expanded|variant|size|collapsible|panel-group-direction|motion|active|focused|selected|selected-single|range-start|range-middle|range-end|radix-[\w-]+|sonner-[\w-]+|cmdk-[\w-]+)$/;
// URL-valued attributes, including rrweb's `rr_src`, which is what `src`
// becomes on a cross-origin iframe before this hook runs.
const URL_ATTRIBUTES = new Set(["href", "src", "rr_src", "action", "formaction", "poster"]);
// Vite's content-hashed build files, same-origin and relative: public, and
// their digit-bearing names would otherwise redact to `:id` and blank images.
const BUILD_ASSET = /^\/assets\/[\w.-]+$/;
const CONTACT_SCHEME = /^(mailto|tel|sms):/i;
const DATA_URL = /^data:/i;
const ABSOLUTE_OR_ROOTED = /^(?:[a-z][a-z\d+.-]*:\/\/|\/)/i;
// A srcset width, density or height descriptor: `800w`, `2x`, `1.5x`.
const SRCSET_DESCRIPTOR = /^\d+(?:\.\d+)?[wxh]$/;
const CSS_URL = /url\((['"]?)([^'")]+)\1\)/g;

/**
 * خطّاف session_recording.maskAttributeFn: يمرّر سمات التخطيط ويجرّد الروابط ويُفرغ الباقي.
 *
 * `maskTextSelector: "*"` masks text nodes only; rrweb serialises attributes
 * as they are, so this is the only line between PostHog and whatever an
 * attribute holds. It is an allowlist, not a blocklist: an attribute nobody
 * thought of is emptied rather than recorded. The QR codes are not handled
 * here at all — their elements carry rrweb's block class `ph-no-capture`.
 */
export function maskReplayAttribute(name: string, value: string): string {
  const key = name.toLowerCase();
  if (URL_ATTRIBUTES.has(key)) return redactUrlAttribute(value);
  if (key === "srcset") return redactSrcset(value);
  if (key === "style") return redactStyle(value);
  if (SAFE_ATTRIBUTES.has(key) || SAFE_DATA_ATTRIBUTE.test(key)) {
    return value.replace(UUID_ANYWHERE, ":id");
  }
  return "";
}

/**
 * يجرّد قيمة سمة رابط، مع الإبقاء على ملفات البناء وإخفاء روابط الاتصال كليًا.
 *
 * A `data:` URL is its own payload — the WhatsApp pairing QR is one — so it is
 * emptied, not passed through.
 */
function redactUrlAttribute(value: string): string {
  if (DATA_URL.test(value)) return "data:,";
  if (BUILD_ASSET.test(value)) return value;
  const contact = CONTACT_SCHEME.exec(value);
  if (contact) return `${contact[1]}:***`;
  if (value.startsWith("#")) return "#";
  // A document-relative reference (`hero.jpg?token=…`, `?tenant=<uuid>`) is a
  // URL here, though `redactUrl` passes non-path strings through for event
  // properties' sake: anchor it to the root, redact, then drop the anchor
  // (Codex review, PR #258).
  if (!ABSOLUTE_OR_ROOTED.test(value)) return redactUrl(`/${value}`).slice(1);
  return redactUrl(value);
}

/**
 * يجرّد كل رابط في قائمة srcset مع الإبقاء على واصفه (1x، 800w).
 *
 * A URL may itself contain commas (`?crop=10,20&token=…`), so candidates are
 * read the way the HTML parser reads them — a URL is a whitespace-free run,
 * and only a comma at its end separates candidates — rather than split on
 * every comma (Codex review, PR #258). Anything that does not parse as
 * URL-plus-descriptor empties the whole attribute: failing closed again. A
 * `data:` URL empties it too, since it is its own payload.
 */
function redactSrcset(value: string): string {
  if (DATA_URL.test(value.trim())) return "data:,";
  const tokens = value.trim().split(/\s+/);
  const candidates: string[] = [];
  for (let index = 0; index < tokens.length; ) {
    const url = tokens[index++];
    let ended = url.endsWith(",");
    const descriptors: string[] = [];
    while (!ended && index < tokens.length) {
      const token = tokens[index++];
      ended = token.endsWith(",");
      descriptors.push(token.replace(/,+$/, ""));
    }
    if (!descriptors.every((descriptor) => SRCSET_DESCRIPTOR.test(descriptor))) return "";
    candidates.push([redactUrlAttribute(url.replace(/,+$/, "")), ...descriptors].join(" "));
  }
  return candidates.join(", ");
}

/**
 * يُبقي أنماط العنصر ويجرّد الروابط داخل url(...) منها، كصور الخلفية الموقّعة.
 */
function redactStyle(value: string): string {
  return value
    .replace(CSS_URL, (_match, quote: string, url: string) => {
      return `url(${quote}${redactUrlAttribute(url)}${quote})`;
    })
    .replace(UUID_ANYWHERE, ":id");
}
