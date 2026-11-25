/** Toggle switch 36x20, primary when on, --input grey when off. */
export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
}
export declare function Switch(props: SwitchProps): JSX.Element;
