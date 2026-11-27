import { Link, useRouterState } from "@tanstack/react-router";
import { Building2, LayoutDashboard, ScrollText } from "lucide-react";
import type { ComponentType } from "react";

import { BrandMark } from "@/components/BrandLogo";
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

/** عنصر واحد في شريط تنقّل المشرف العام. */
interface PlatformNavItem {
  to: "/platform" | "/platform/companies" | "/platform/audit";
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
}

/** روابط لوحة المشرف العام؛ لا يوجد فيها أي رابط الخاصة بشركة. */
const NAV_ITEMS: readonly PlatformNavItem[] = [
  { to: "/platform", labelKey: "platform.nav.overview", icon: LayoutDashboard },
  { to: "/platform/companies", labelKey: "platform.nav.companies", icon: Building2 },
  { to: "/platform/audit", labelKey: "platform.nav.audit", icon: ScrollText },
];

/**
 * الشريط الجانبي للوحة المشرف العام.
 *
 * It is deliberately separate from `AdminSidebar`: that component reads the
 * request company's enabled modules and service-role-free hooks, neither of
 * which a super admin has or should see.
 */
export function PlatformSidebar() {
  const { t, dir } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  /** يطابق الرابط الحالي حتى لا يُضاء رابط الأب خطأً. */
  const isActive = (to: string) =>
    to === "/platform" ? pathname === "/platform" : pathname.startsWith(to);

  return (
    <Sidebar collapsible="icon" side={dir === "rtl" ? "right" : "left"}>
      <SidebarContent>
        <div className="flex items-center gap-2.5 border-b border-sidebar-border px-3 py-5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
          <BrandMark
            alt={t("platform.title")}
            onDark
            className="size-12 rounded-xl group-data-[collapsible=icon]:size-9"
          />
          <span className="truncate text-[20px] font-semibold text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            {t("platform.title")}
          </span>
        </div>
        <nav aria-label={t("platform.title")}>
          <SidebarGroup>
            <SidebarGroupLabel>{t("platform.subtitle")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive(item.to)}
                      tooltip={t(item.labelKey)}
                    >
                      <Link
                        to={item.to}
                        aria-current={isActive(item.to) ? "page" : undefined}
                        className="flex items-center gap-2"
                      >
                        <item.icon className="size-[22px]" />
                        <span>{t(item.labelKey)}</span>
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
