/** Modal dialog: centered card, max-w 512px, black/80 overlay. Controlled via open/onOpenChange. */
export interface DialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}
export declare function Dialog(props: DialogProps): JSX.Element;
export declare function DialogHeader(props: {
  children?: React.ReactNode;
  className?: string;
}): JSX.Element;
export declare function DialogTitle(props: {
  children?: React.ReactNode;
  className?: string;
}): JSX.Element;
export declare function DialogDescription(props: {
  children?: React.ReactNode;
  className?: string;
}): JSX.Element;
export declare function DialogFooter(props: {
  children?: React.ReactNode;
  className?: string;
}): JSX.Element;
