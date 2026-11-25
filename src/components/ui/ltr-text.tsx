import type { ElementType, ReactNode } from "react";

/**
 * Renders inherently left-to-right text — phone numbers, WhatsApp numbers,
 * email addresses, URLs — inside a page that may be right-to-left.
 *
 * Without `dir="ltr"` the bidirectional algorithm reorders a Latin/numeric run
 * that sits among Arabic text: `+965 1234 5678` renders with its groups in the
 * wrong order, and an email's punctuation migrates to the wrong end.
 *
 * **`dir` goes on the inner span, never on the outer element.** `text-align:
 * start` resolves against an element's *own* direction, so an outer block
 * carrying `dir="ltr"` computes to `text-align: left` on an Arabic page — the
 * value slides to the left edge while its label stays right, which is exactly
 * the misalignment this component is supposed to prevent. Leaving the outer
 * element alone lets it inherit the page direction and align normally, while
 * the span still isolates the bidi run: the UA stylesheet gives any `[dir]`
 * element `unicode-bidi: isolate`, so the text inside keeps its LTR order.
 *
 * This exists as one component rather than a `dir="ltr"` attribute sprinkled
 * across twenty call sites so the rule is testable and can be changed in one
 * place. Note `Input type="tel"` already applies the same treatment
 * (components/ui/input.tsx) — this is the read-only counterpart.
 */
export function LtrText({
  children,
  className,
  as: Component = "span",
}: {
  children: ReactNode;
  className?: string;
  /** Defaults to `span`; pass `p`/`div` where block layout is needed. */
  as?: ElementType;
}) {
  return (
    <Component className={className}>
      <span dir="ltr">{children}</span>
    </Component>
  );
}
