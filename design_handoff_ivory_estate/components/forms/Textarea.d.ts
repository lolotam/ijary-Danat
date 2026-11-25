/** Multi-line text field, min-height 60px. */
export interface TextareaProps {
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  onChange?: (e: any) => void;
  className?: string;
}
export declare function Textarea(props: TextareaProps): JSX.Element;
