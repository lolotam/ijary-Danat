import * as React from "react";
import { CalendarIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useOptionalI18n } from "@/i18n/provider";
import {
  dateToIsoLocal,
  displayDatePlaceholder,
  formatIsoDateForDisplay,
  isoToLocalDate,
  parseDisplayDateToIso,
  type DateTextDir,
} from "@/lib/dateDisplay";
import { cn } from "@/lib/utils";

export type DateInputProps = Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "onChange" | "defaultValue"
> & {
  /** ISO `yyyy-MM-dd` (or empty). */
  value?: string;
  onChange?: (iso: string) => void;
  /** Force direction; defaults to app i18n dir. */
  textDir?: DateTextDir;
};

/**
 * Date field that keeps ISO in form state but shows:
 * - LTR: dd/mm/yyyy
 * - RTL: yyyy/mm/dd
 */
export const DateInput = React.forwardRef<HTMLInputElement, DateInputProps>(
  (
    {
      value = "",
      onChange,
      onBlur,
      className,
      disabled,
      readOnly,
      textDir,
      placeholder,
      name,
      id,
      ...rest
    },
    ref,
  ) => {
    const i18n = useOptionalI18n();
    const dir: DateTextDir = textDir ?? i18n?.dir ?? "ltr";
    const openCalendarLabel = i18n?.t("common.openCalendar") ?? "Open calendar";
    const iso = value?.slice(0, 10) ?? "";
    const [text, setText] = React.useState(() => formatIsoDateForDisplay(iso, dir));
    const [open, setOpen] = React.useState(false);

    React.useEffect(() => {
      setText(formatIsoDateForDisplay(iso, dir));
    }, [iso, dir]);

    function commitText(next: string) {
      if (readOnly || disabled) return;
      const parsed = parseDisplayDateToIso(next, dir);
      if (parsed === "") {
        onChange?.("");
        setText("");
        return;
      }
      if (parsed) {
        onChange?.(parsed);
        setText(formatIsoDateForDisplay(parsed, dir));
        return;
      }
      // Invalid partial — snap back to last good ISO display.
      setText(formatIsoDateForDisplay(iso, dir));
    }

    const selected = isoToLocalDate(iso);

    return (
      <div className={cn("relative flex w-full items-center gap-1", className)}>
        <Input
          {...rest}
          ref={ref}
          id={id}
          name={name}
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          placeholder={placeholder ?? displayDatePlaceholder(dir)}
          value={text}
          disabled={disabled}
          readOnly={readOnly}
          className="min-w-0 flex-1"
          onChange={(event) => {
            if (readOnly || disabled) return;
            setText(event.target.value);
          }}
          onBlur={(event) => {
            commitText(event.target.value);
            onBlur?.(event);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitText((event.target as HTMLInputElement).value);
            }
          }}
        />
        {!readOnly && !disabled && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                // Hardcoded English until now, on every date field of an
                // Arabic-first RTL product. `useOptionalI18n` rather than
                // `useI18n` because this is a ui/ primitive that must not throw
                // outside the provider.
                title={openCalendarLabel}
                aria-label={openCalendarLabel}
              >
                <CalendarIcon className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={selected}
                defaultMonth={selected}
                onSelect={(date) => {
                  if (!date) return;
                  const next = dateToIsoLocal(date);
                  onChange?.(next);
                  setText(formatIsoDateForDisplay(next, dir));
                  setOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>
    );
  },
);
DateInput.displayName = "DateInput";
