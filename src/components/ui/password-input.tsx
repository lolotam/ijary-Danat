import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export type PasswordInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  /**
   * Start revealed. Only for the admin user forms, where the point of the field
   * is that a human reads the generated password and passes it on — masking
   * those by default would break a working flow.
   */
  defaultVisible?: boolean;
};

/**
 * حقل كلمة مرور مع زر إظهار وإخفاء.
 *
 * `dir` deliberately lands on the WRAPPER, not on the input — which is why this
 * component exists rather than each page growing its own eye icon.
 *
 * The two login pages are RTL Arabic overall but force the password field to
 * LTR. Put the toggle button inside an RTL ancestor and `end-2` resolves to the
 * left edge, while `pe-10` on the LTR input reserves space on the right: the
 * icon lands on top of the first characters typed. Isolating direction on the
 * wrapper makes both agree, and leaves the `<label>` outside to stay RTL.
 *
 * Passing no `dir` (the tenant profile page) inherits the page direction, which
 * is correct there. Note `ui/input.tsx` deliberately does NOT force LTR for
 * `type="password"`, and `input.test.tsx` pins that — the wrapper carries
 * direction, the input never does.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, dir, defaultVisible = false, ...props }, ref) => {
    const { t } = useI18n();
    const [visible, setVisible] = React.useState(defaultVisible);
    const label = visible ? t("auth.hidePassword") : t("auth.showPassword");
    const ToggleIcon = visible ? EyeOff : Eye;

    return (
      <div className="relative" dir={dir}>
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pe-10", className)}
          {...props}
        />
        <button
          // Bare <button> defaults to submit; both call sites sit inside a form
          // that would post on every reveal.
          type="button"
          onClick={() => setVisible((current) => !current)}
          title={label}
          // The name changes with state ("Show" / "Hide"), so no `aria-pressed`
          // as well — that would announce the state twice, once as the label and
          // once as the pressed value.
          aria-label={label}
          className="absolute end-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ToggleIcon className="size-4" />
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
