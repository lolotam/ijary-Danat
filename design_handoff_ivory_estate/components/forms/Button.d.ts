/** Primary action control (shadcn new-york values from Dana-kuwait). */
export interface ButtonProps {
  /** Visual style */
  variant?: "default" | "gold" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  /** Control height: default 36px, sm 32px, lg 40px, icon 36x36 */
  size?: "default" | "sm" | "lg" | "icon";
  disabled?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  className?: string;
}
export declare function Button(props: ButtonProps): JSX.Element;
