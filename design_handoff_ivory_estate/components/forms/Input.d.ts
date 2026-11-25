/** Text input, 36px tall, transparent bg, 1px --input border. */
export interface InputProps {
  type?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  dir?: "ltr" | "rtl";
  onChange?: (e: any) => void;
  className?: string;
}
export declare function Input(props: InputProps): JSX.Element;
