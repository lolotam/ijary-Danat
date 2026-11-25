/** Segmented tabs on a muted pill track (electricity: meters/readings/tariffs/charges). */
export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children?: React.ReactNode;
  className?: string;
}
export declare function Tabs(props: TabsProps): JSX.Element;
export declare function TabsList(props: {
  children?: React.ReactNode;
  className?: string;
}): JSX.Element;
export declare function TabsTrigger(props: {
  value: string;
  children?: React.ReactNode;
  className?: string;
}): JSX.Element;
export declare function TabsContent(props: {
  value: string;
  children?: React.ReactNode;
  className?: string;
}): JSX.Element;
