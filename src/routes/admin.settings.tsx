import { Link, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";

import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/settings")({
  component: SettingsLayout,
});

const tabs = [
  { to: "/admin/settings", key: "admin.settings" as const, exact: true },
  { to: "/admin/settings/lists", key: "admin.lists" as const },
  { to: "/admin/settings/users", key: "admin.users" as const },
  { to: "/admin/settings/roles", key: "settings.rolesPermissions" as const },
  // Automations groups what the system does on its own: the notification pool,
  // the templates it sends, the providers it sends through, and the jobs that
  // trigger them. Those four live as tabs inside the notifications screen, so
  // the standalone Scheduled jobs entry is no longer listed here — its route
  // stays reachable for existing links.
  { to: "/admin/settings/notifications", key: "settings.automations" as const },
  { to: "/admin/settings/landing-page", key: "settings.landingPage" as const },
  { to: "/admin/settings/integrations", key: "settings.integrations" as const },
  { to: "/admin/settings/cards", key: "settings.cardsControl" as const },
  { to: "/admin/settings/backup", key: "settings.backup" as const },
];

function SettingsLayout() {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isActive = (to: string, exact?: boolean) =>
    exact
      ? pathname === to || pathname === `${to}/`
      : pathname === to || pathname.startsWith(`${to}/`);

  return (
    <div className="space-y-6">
      <div className="border-b">
        <nav className="-mb-px flex flex-wrap gap-x-6 gap-y-2 overflow-x-auto">
          {tabs.map((tab) => {
            const active = isActive(tab.to, tab.exact);
            return (
              <Link
                key={tab.to}
                to={tab.to}
                className={cn(
                  "whitespace-nowrap border-b-2 px-1 pb-3 pt-2 text-sm font-medium transition-colors",
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground",
                )}
              >
                {t(tab.key)}
              </Link>
            );
          })}
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
