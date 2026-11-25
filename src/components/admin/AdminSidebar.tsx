import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  FileText,
  Inbox,
  Users,
  BadgeDollarSign,
  Building2,
  Home,
  ScrollText,
  CreditCard,
  Banknote,
  Receipt,
  BarChart3,
  ShieldCheck,
  Settings,
  Zap,
} from "lucide-react";

import { useBrandLogoUrl } from "@/components/BrandLogo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useI18n } from "@/i18n/provider";

type ItemKey =
  | "admin.dashboard"
  | "admin.invoices"
  | "admin.inbox"
  | "admin.tenants"
  | "admin.propertiesBuildings"
  | "admin.units"
  | "admin.maintenance"
  | "admin.contracts"
  | "admin.payments"
  | "admin.employees"
  | "admin.deposits"
  | "admin.expenses"
  | "admin.electricity"
  | "admin.reports"
  | "admin.audit"
  | "admin.settings";

interface NavItem {
  key: ItemKey;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
}

const primary: NavItem[] = [
  { key: "admin.dashboard", to: "/admin", icon: LayoutDashboard },
  { key: "admin.invoices", to: "/admin/invoices", icon: FileText },
  { key: "admin.tenants", to: "/admin/tenants", icon: Users },
  { key: "admin.propertiesBuildings", to: "/admin/properties", icon: Building2 },
  { key: "admin.units", to: "/admin/units", icon: Home },
  // Maintenance module is hidden from the nav for now (route/code kept):
  // { key: "admin.maintenance", to: "/admin/maintenance", icon: Wrench },
  { key: "admin.contracts", to: "/admin/contracts", icon: ScrollText },
  { key: "admin.payments", to: "/admin/payments", icon: CreditCard },
  { key: "admin.employees", to: "/admin/employees", icon: BadgeDollarSign },
  { key: "admin.deposits", to: "/admin/deposits", icon: Banknote },
  { key: "admin.expenses", to: "/admin/expenses", icon: Receipt },
  { key: "admin.electricity", to: "/admin/electricity", icon: Zap },
];

const secondary: NavItem[] = [
  { key: "admin.inbox", to: "/admin/inbox", icon: Inbox },
  { key: "admin.reports", to: "/admin/reports", icon: BarChart3 },
  { key: "admin.audit", to: "/admin/audit", icon: ShieldCheck },
  { key: "admin.settings", to: "/admin/settings", icon: Settings },
];

export function AdminSidebar() {
  const { t, dir } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const logoUrl = useBrandLogoUrl();

  const isActive = (to: string) =>
    to === "/admin" ? pathname === "/admin" : pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Sidebar collapsible="icon" side={dir === "rtl" ? "right" : "left"}>
      <SidebarContent>
        <div className="flex items-center gap-2.5 border-b border-sidebar-border px-3 py-5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
          <img
            src={logoUrl}
            alt={t("sidebar.danatFuture")}
            className="size-12 shrink-0 rounded-xl object-contain group-data-[collapsible=icon]:size-9"
          />
          <span className="truncate text-[20px] font-semibold text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            {t("sidebar.danatFuture")}
          </span>
        </div>
        <nav aria-label="إدارة النظام / Admin navigation">
          <SidebarGroup>
            <SidebarGroupLabel>{t("admin.dashboard")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {primary.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={isActive(item.to)} tooltip={t(item.key)}>
                      <Link
                        to={item.to}
                        aria-current={isActive(item.to) ? "page" : undefined}
                        className="flex items-center gap-2"
                      >
                        <item.icon className="size-[22px]" />
                        <span>{t(item.key)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>{t("admin.settings")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {secondary.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={isActive(item.to)} tooltip={t(item.key)}>
                      <Link
                        to={item.to}
                        aria-current={isActive(item.to) ? "page" : undefined}
                        className="flex items-center gap-2"
                      >
                        <item.icon className="size-[22px]" />
                        <span>{t(item.key)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}
