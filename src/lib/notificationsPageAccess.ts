/**
 * Visibility rules for /admin/settings/notifications.
 *
 * The page hosts both notification surfaces (pool, templates) and the jobs
 * tab (workflows + scheduled/generated reports). Those surfaces require
 * different permissions, so the page-level guard is an OR while each tab is
 * gated on its own rule. Extracted as a pure helper so the matrix can be
 * unit-tested without rendering the route (exporting from a route file trips
 * react-refresh/only-export-components).
 */

export type NotificationsPageTab = "pool" | "templates" | "providers" | "jobs";

export type NotificationsPageAccessInput = {
  canReadNotifications: boolean;
  canReadReports: boolean;
  /** settings.integrations — the Providers tab. */
  canManageIntegrations: boolean;
  /** workflows.manage — the WorkflowsPanel inside the jobs tab. */
  canManageWorkflows: boolean;
};

export type NotificationsPageAccess = {
  forbidden: boolean;
  visibleTabs: NotificationsPageTab[];
  defaultTab: NotificationsPageTab;
};

/** Preferred landing order when more than one tab is visible. */
const TAB_ORDER: readonly NotificationsPageTab[] = ["pool", "templates", "providers", "jobs"];

/**
 * Decide which tabs the user may see and which one to open by default.
 *
 * - pool / templates: notifications.read
 * - providers: settings.integrations
 * - jobs: workflows.manage (WorkflowsPanel) OR reports.read (scheduled/generated reports)
 *
 * Forbidden only when no tab is visible. Before migration 230 these were
 * admin-only and the page entry was the OR of the two reads; a role granted
 * only settings.integrations must now be able to reach its tab.
 * defaultTab is the first tab in TAB_ORDER that is visible; when forbidden it
 * is "pool" (unused — the page returns early).
 */
export function resolveNotificationsPageAccess(
  input: NotificationsPageAccessInput,
): NotificationsPageAccess {
  const { canReadNotifications, canReadReports, canManageIntegrations, canManageWorkflows } = input;

  const visibleTabs: NotificationsPageTab[] = [];
  if (canReadNotifications) {
    visibleTabs.push("pool", "templates");
  }
  if (canManageIntegrations) {
    visibleTabs.push("providers");
  }
  if (canManageWorkflows || canReadReports) {
    visibleTabs.push("jobs");
  }
  if (visibleTabs.length === 0) {
    return { forbidden: true, visibleTabs: [], defaultTab: "pool" };
  }

  // Preserve TAB_ORDER rather than push order, so default is stable if push
  // order ever drifts (e.g. providers before templates for some role).
  const ordered = TAB_ORDER.filter((tab) => visibleTabs.includes(tab));
  const defaultTab = ordered[0] ?? "pool";

  return { forbidden: false, visibleTabs: ordered, defaultTab };
}
