/** Radio button group, 16px circles with primary fill dot. */
export interface RadioGroupProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children?: React.ReactNode;
  className?: string;
}
export declare function RadioGroup(props: RadioGroupProps): JSX.Element;
export interface RadioGroupItemProps {
  value: string;
  disabled?: boolean;
  className?: string;
}
export declare function RadioGroupItem(props: RadioGroupItemProps): JSX.Element;
