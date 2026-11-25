/** Dropdown select (cosmetic recreation of Radix select). */
export interface SelectOption {
  value: string;
  label: string;
}
export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  className?: string;
}
export declare function Select(props: SelectProps): JSX.Element;
