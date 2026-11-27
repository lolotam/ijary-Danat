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

import { BrandMark } from "@/components/BrandLogo";
import type { ModuleKey } from "@/company/modules";
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
import { useModules } from "@/hooks/useModules";
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

export interface NavItem {
  key: ItemKey;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  /** مفتاح القسم المطلوب إظهار العنصر؛ غيابه يعني أن العنصر دائم الظهور. */
  module?: ModuleKey;
}

export const PRIMARY_NAV_ITEMS: readonly NavItem[] = [
  { key: "admin.dashboard", to: "/admin", icon: LayoutDashboard },
  { key: "admin.invoices", to: "/admin/invoices", icon: FileText, module: "invoices" },
  { key: "admin.tenants", to: "/admin/tenants", icon: Users, module: "tenants" },
  {
    key: "admin.propertiesBuildings",
    to: "/admin/properties",
    icon: Building2,
    module: "properties",
  },
  { key: "admin.units", to: "/admin/units", icon: Home, module: "units" },
  { key: "admin.contracts", to: "/admin/contracts", icon: ScrollText, module: "contracts" },
  { key: "admin.payments", to: "/admin/payments", icon: CreditCard, module: "payments" },
  { key: "admin.employees", to: "/admin/employees", icon: BadgeDollarSign, module: "employees" },
  { key: "admin.deposits", to: "/admin/deposits", icon: Banknote, module: "deposits" },
  { key: "admin.expenses", to: "/admin/expenses", icon: Receipt, module: "expenses" },
  { key: "admin.electricity", to: "/admin/electricity", icon: Zap, module: "electricity" },
];

export const SECONDARY_NAV_ITEMS: readonly NavItem[] = [
  { key: "admin.inbox", to: "/admin/inbox", icon: Inbox, module: "inbox" },
  { key: "admin.reports", to: "/admin/reports", icon: BarChart3, module: "reports" },
  { key: "admin.audit", to: "/admin/audit", icon: ShieldCheck, module: "audit" },
  { key: "admin.settings", to: "/admin/settings", icon: Settings },
];

/**
 * يصفّي عناصر الشريط الجانبي لإخفاء الأقسام المعطّلة للشركة مع إبقاء العناصر الدائمة.
 */
export function filterNavItems(
  items: readonly NavItem[],
  isModuleEnabled: (key: ModuleKey) => boolean,
): NavItem[] {
  return items.filter((item) => !item.module || isModuleEnabled(item.module));
}

/**
 * الشريط الجانبي للوحة الإدارة: يعرض فقط الأقسام المفعّلة للشركة الحالية.
 */
export function AdminSidebar() {
  const { t, dir } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isModuleEnabled } = useModules();
  const primary = filterNavItems(PRIMARY_NAV_ITEMS, isModuleEnabled);
  const secondary = filterNavItems(SECONDARY_NAV_ITEMS, isModuleEnabled);

  const isActive = (to: string) =>
    to === "/admin" ? pathname === "/admin" : pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Sidebar collapsible="icon" side={dir === "rtl" ? "right" : "left"}>
      <SidebarContent>
        <div className="flex items-center gap-2.5 border-b border-sidebar-border px-3 py-5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
          <BrandMark
            alt={t("sidebar.danatFuture")}
            onDark
            className="size-12 rounded-xl group-data-[collapsible=icon]:size-9"
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
