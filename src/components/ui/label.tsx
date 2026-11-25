"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const labelVariants = cva(
  "text-base font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
);

/**
 * النجمة الحمراء التي تدل على أن الحقل إلزامي.
 *
 * Exported because a handful of labels cannot use `Label`'s `required` prop: the
 * two login pages use raw `<label>` elements, and the user-form password label
 * is a `justify-between` row where a trailing sibling would land past the
 * Generate button. One component keeps those from drifting from the rest.
 *
 * `aria-hidden` — `aria-required` on the control is what assistive tech reads.
 * `ms-1` is logical so the gap flips with the page direction.
 */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ms-1 text-destructive">
      *
    </span>
  );
}

/**
 * تسمية حقل، مع نجمة حمراء للحقول الإلزامية.
 *
 * The asterisk is a SIBLING node, never appended to the translated string.
 * `t()` returns finished Arabic or English text; concatenating "*" onto it puts
 * the star on whichever side the bidi algorithm decides, which is the wrong one
 * about half the time. `ms-1` is logical, so the gap flips with the direction.
 *
 * `aria-hidden` because the asterisk is the visual half of the signal —
 * `aria-required` on the control is what a screen reader should announce, and
 * hearing "star" before every mandatory field is noise.
 */
const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants> & { required?: boolean }
>(({ className, required, children, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props}>
    {children}
    {required && <RequiredMark />}
  </LabelPrimitive.Root>
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
