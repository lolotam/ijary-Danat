/** Admin sidebar (cosmetic recreation of the shadcn Sidebar as configured in Dana-kuwait). Right side in RTL. */
export interface SidebarNavItem {
  key: string;
  label: string;
  icon: string;
}
export interface SidebarNavGroup {
  label: string;
  items: SidebarNavItem[];
}
export interface SidebarNavProps {
  /** defaults to the real admin nav (dashboard→electricity, reports/audit/settings) */
  groups?: SidebarNavGroup[];
  activeKey?: string;
  onNavigate?: (key: string) => void;
  className?: string;
}
export declare function SidebarNav(props: SidebarNavProps): JSX.Element;
