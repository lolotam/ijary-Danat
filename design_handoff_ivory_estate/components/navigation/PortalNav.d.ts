/** Tenant-portal horizontal pill nav (active pill = solid primary). */
export interface PortalNavItem {
  key: string;
  label: string;
  icon: string;
}
export interface PortalNavProps {
  /** defaults to the real portal nav (لوحتي، عقدي، فواتيري…) */
  items?: PortalNavItem[];
  activeKey?: string;
  onNavigate?: (key: string) => void;
  className?: string;
}
export declare function PortalNav(props: PortalNavProps): JSX.Element;
