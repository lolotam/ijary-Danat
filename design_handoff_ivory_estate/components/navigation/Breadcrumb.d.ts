/** Breadcrumb trail; chevron flips in RTL. */
export interface BreadcrumbItem {
  label: string;
  href?: string;
}
export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}
export declare function Breadcrumb(props: BreadcrumbProps): JSX.Element;
