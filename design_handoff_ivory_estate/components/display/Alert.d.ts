/** Inline message block: default, destructive, success. */
export interface AlertProps {
  variant?: "default" | "destructive" | "success";
  children?: React.ReactNode;
  className?: string;
}
export declare function Alert(props: AlertProps): JSX.Element;
export declare function AlertTitle(props: AlertProps): JSX.Element;
export declare function AlertDescription(props: AlertProps): JSX.Element;
