/** Status chip (invoice/contract states). */
export interface BadgeProps {
  variant?: "default" | "secondary" | "destructive" | "outline" | "success";
  children?: React.ReactNode;
  className?: string;
}
export declare function Badge(props: BadgeProps): JSX.Element;
