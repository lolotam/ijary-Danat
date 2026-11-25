/** Surface card: white, 1px border, 12px radius, soft shadow. */
export interface CardProps {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}
export declare function Card(props: CardProps): JSX.Element;
export declare function CardHeader(props: CardProps): JSX.Element;
export declare function CardTitle(props: CardProps): JSX.Element;
export declare function CardDescription(props: CardProps): JSX.Element;
export declare function CardContent(props: CardProps): JSX.Element;
export declare function CardFooter(props: CardProps): JSX.Element;
