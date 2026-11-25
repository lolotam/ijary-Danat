import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Input types whose value is inherently left-to-right.
 *
 * A phone number, email address or URL is Latin/numeric regardless of the page
 * language, so on an Arabic form it must not inherit RTL. Without this, the
 * phone field renders left-aligned (it was already handled) while the email
 * field directly beneath it renders right-aligned — visibly inconsistent, and
 * caught on a 390px Arabic viewport rather than by any test.
 *
 * An explicit `dir` prop still wins, so a caller can override per field.
 */
const LTR_INPUT_TYPES = new Set(["tel", "email", "url"]);

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, dir, type, ...props }, ref) => {
    return (
      <input
        type={type}
        dir={dir ?? (type && LTR_INPUT_TYPES.has(type) ? "ltr" : undefined)}
        className={cn(
          "flex h-9 w-full rounded-[12px] border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
