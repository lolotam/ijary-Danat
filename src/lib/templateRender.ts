import { escapeHtml } from "@/lib/html";

/**
 * نصّ القالب المرئي: يحلّ أقسام {{#key}}…{{/key}} و{{^key}}…{{/key}} ويُبقي الباقي كما هو.
 *
 * Mustache-shaped on purpose: admins already know `{{var}}`, and a section is
 * the only way an authored body can drop a row (the discount rows) when the
 * value is empty. Innermost sections resolve first so nesting works; a tag
 * with no closing partner is left verbatim, the same policy as an unknown
 * variable, so a typo is visible rather than silently swallowed.
 */
export function visibleTemplateSource(value: string, variables: Record<string, string>): string {
  // Innermost section = one whose body holds no other section tag, opener OR
  // closer. A crossed closer ({{#a}}A{{/b}}B{{/a}}) therefore never matches
  // and every tag survives verbatim.
  const section =
    /{{([#^])\s*([a-zA-Z0-9_]+)\s*}}((?:(?!{{[#^/]\s*[a-zA-Z0-9_]+\s*}}).)*){{\/\s*\2\s*}}/s;
  let output = value;
  for (;;) {
    const match = section.exec(output);
    if (!match) return output;
    const [, kind, key, inner] = match;
    const present = Object.hasOwn(variables, key) && variables[key] !== "";
    const keep = kind === "#" ? present : !present;
    // Spliced by index, never String.replace with a replacement string: "$&"
    // in authored text would re-insert the match and the loop would spin
    // forever.
    output =
      output.slice(0, match.index) +
      (keep ? inner : "") +
      output.slice(match.index + match[0].length);
  }
}

/**
 * Substitutes `{{variable}}` placeholders in a notification template, after
 * resolving `{{#key}}…{{/key}}` and `{{^key}}…{{/key}}` sections.
 *
 * An unknown key is left verbatim rather than blanked, so a typo in a template
 * shows up as `{{recipent_name}}` in the sent message instead of a silent gap
 * nobody notices.
 *
 * **This does not escape.** Callers that render into HTML must escape the
 * *values* before passing them in — see `escapeVariables`. The template text
 * itself is admin-authored and may legitimately contain markup.
 */
export function renderTemplate(
  value: string | null,
  variables: Record<string, string>,
): string | null {
  if (value === null) return null;
  return visibleTemplateSource(value, variables).replace(
    /{{\s*([a-zA-Z0-9_]+)\s*}}/g,
    (match, key: string) => (Object.hasOwn(variables, key) ? variables[key] : match),
  );
}

/**
 * HTML-escapes every value in a variable map, leaving the keys alone.
 *
 * Use before `renderTemplate` when the result is inserted into an HTML email:
 * a tenant whose display name contains `<script>` must not be able to inject
 * through a template placeholder. The admin-authored template body around the
 * placeholders is deliberately left as markup.
 */
export function escapeVariables(variables: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [key, escapeHtml(value)]),
  );
}

/**
 * Flattens rendered HTML into the plain-text alternative.
 *
 * Block tags become newlines so paragraphs stay paragraphs, and the entities the
 * renderer introduced are turned back into their characters — WhatsApp is plain
 * text and would otherwise show a literal `&amp;`.
 *
 * One authored body, both representations: the table has no body_text column and
 * deliberately does not gain one.
 *
 * Source formatting is dropped the way a browser drops it: a newline between
 * two tags is not content, and the indentation an editor puts at the start of
 * a line is not content either. Both reached tenants verbatim over WhatsApp,
 * which shows whitespace the HTML rendering never did.
 */
export function stripMarkup(html: string | null): string {
  if (!html) return "";
  return (
    html
      .replace(/>\s*\n\s*</g, "><")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      // Table cells become WhatsApp-readable lines: cells joined by a space,
      // rows by a newline. Before this the flattened body read
      // "رقم الفاتورةINV-0003154" with no separator at all.
      .replace(/<\/\s*(td|th)\s*>/gi, " ")
      .replace(/<\/\s*tr\s*>/gi, "\n")
      .replace(/<\/\s*(p|div|h[1-6]|li)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
