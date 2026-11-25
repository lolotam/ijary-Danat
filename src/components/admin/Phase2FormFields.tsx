import { useState, type ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DateInput } from "@/components/ui/date-input";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface SelectOption {
  label: ReactNode;
  value: string;
}

export function FormTextField<TValues extends FieldValues>({
  control,
  name,
  label,
  required,
  type = "text",
  multiline = false,
  readOnly = false,
  dir,
}: {
  control: Control<TValues>;
  name: FieldPath<TValues>;
  label: string;
  /** Renders the red asterisk. Set per field; never derived from Zod. */
  required?: boolean;
  type?: string;
  multiline?: boolean;
  readOnly?: boolean;
  dir?: "ltr" | "rtl" | "auto";
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel required={required}>{label}</FormLabel>
          <FormControl>
            {multiline ? (
              <Textarea
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                value={String(field.value ?? "")}
                onChange={(event) => field.onChange(event.target.value)}
                rows={3}
                readOnly={readOnly}
              />
            ) : type === "date" ? (
              <DateInput
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                value={String(field.value ?? "")}
                readOnly={readOnly}
                onChange={field.onChange}
              />
            ) : (
              <Input
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                dir={dir ?? (type === "tel" ? "ltr" : undefined)}
                inputMode={type === "tel" ? "tel" : type === "number" ? "decimal" : undefined}
                value={String(field.value ?? "")}
                type={type}
                readOnly={readOnly}
                onChange={(event) => {
                  const raw = event.target.value;
                  // Keep number fields numeric in RHF state so watchers /
                  // date-fns math never string-concatenate month amounts.
                  if (type === "number") {
                    field.onChange(raw === "" ? "" : Number(raw));
                    return;
                  }
                  field.onChange(raw);
                }}
              />
            )}
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function FormSelectField<TValues extends FieldValues>({
  control,
  name,
  label,
  required,
  options,
  placeholder,
  disabled = false,
  description,
}: {
  control: Control<TValues>;
  name: FieldPath<TValues>;
  label: string;
  /** Renders the red asterisk. Set per field; never derived from Zod. */
  required?: boolean;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  description?: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel required={required}>{label}</FormLabel>
          <Select
            value={String(field.value ?? "")}
            onValueChange={field.onChange}
            disabled={disabled}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function FormComboboxField<TValues extends FieldValues>({
  control,
  name,
  label,
  required,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
}: {
  control: Control<TValues>;
  name: FieldPath<TValues>;
  label: string;
  /** Renders the red asterisk. Set per field; never derived from Zod. */
  required?: boolean;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const current = String(field.value ?? "");
        const selected = options.find((option) => option.value === current);
        // Legacy free-text values may not be in the list — show them as-is.
        const triggerLabel = selected?.label ?? current;
        return (
          <FormItem className="flex flex-col">
            <FormLabel required={required}>{label}</FormLabel>
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <FormControl>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className={cn(
                      "w-full justify-between font-normal",
                      !triggerLabel && "text-muted-foreground",
                    )}
                  >
                    {triggerLabel || placeholder}
                    <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                  </Button>
                </FormControl>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput placeholder={searchPlaceholder ?? placeholder} />
                  <CommandList>
                    <CommandEmpty>{emptyText}</CommandEmpty>
                    <CommandGroup>
                      {options.map((option) => (
                        <CommandItem
                          key={option.value}
                          value={`${option.label} ${option.value}`}
                          onSelect={() => {
                            field.onChange(option.value);
                            setOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 size-4",
                              option.value === current ? "opacity-100" : "opacity-0",
                            )}
                          />
                          {option.label}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

/**
 * Three-state override control for a nullable boolean.
 *
 * A Switch can only say on/off, which cannot express "inherit". Used for the
 * portal tab overrides, where null must stay distinct from false: null follows
 * the tenant role permission, false actively hides the tab.
 *
 * The three states are encoded as strings because Radix Select values must be
 * strings and "" is reserved by Radix for the empty placeholder.
 */
export function FormTriStateField<TValues extends FieldValues>({
  control,
  name,
  label,
  required,
  inheritLabel,
  showLabel,
  hideLabel,
}: {
  control: Control<TValues>;
  name: FieldPath<TValues>;
  label: string;
  /** Renders the red asterisk. Set per field; never derived from Zod. */
  required?: boolean;
  inheritLabel: string;
  showLabel: string;
  hideLabel: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <FormLabel required={required} className="shrink-0">
            {label}
          </FormLabel>
          <Select
            value={field.value === true ? "show" : field.value === false ? "hide" : "inherit"}
            onValueChange={(next) =>
              field.onChange(next === "show" ? true : next === "hide" ? false : null)
            }
          >
            <FormControl>
              <SelectTrigger className="w-[11.5rem]">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value="inherit">{inheritLabel}</SelectItem>
              <SelectItem value="show">{showLabel}</SelectItem>
              <SelectItem value="hide">{hideLabel}</SelectItem>
            </SelectContent>
          </Select>
        </FormItem>
      )}
    />
  );
}

export function FormSwitchField<TValues extends FieldValues>({
  control,
  name,
  label,
  required,
}: {
  control: Control<TValues>;
  name: FieldPath<TValues>;
  label: string;
  /** Renders the red asterisk. Set per field; never derived from Zod. */
  required?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex items-center justify-between rounded-lg border p-3">
          <FormLabel required={required}>{label}</FormLabel>
          <FormControl>
            <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}
