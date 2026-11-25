/** 16px square checkbox; checked = solid primary with white check. */
export interface CheckboxProps {
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
