import { describe, expect, it } from "vitest";

import {
  resolveNotificationsPageAccess,
  type NotificationsPageAccessInput,
} from "./notificationsPageAccess";

const none: NotificationsPageAccessInput = {
  canReadNotifications: false,
  canReadReports: false,
  canManageIntegrations: false,
  canManageWorkflows: false,
};

describe("resolveNotificationsPageAccess", () => {
  it("every grant → pool, templates, providers, jobs; default pool", () => {
    const access = resolveNotificationsPageAccess({
      canReadNotifications: true,
      canReadReports: true,
      canManageIntegrations: true,
      canManageWorkflows: true,
    });

    expect(access.forbidden).toBe(false);
    expect(access.visibleTabs).toEqual(["pool", "templates", "providers", "jobs"]);
    expect(access.defaultTab).toBe("pool");
  });

  it("readonly (both reads, no manage grants) → pool, templates, jobs; default pool", () => {
    const access = resolveNotificationsPageAccess({
      ...none,
      canReadNotifications: true,
      canReadReports: true,
    });

    expect(access.forbidden).toBe(false);
    expect(access.visibleTabs).toEqual(["pool", "templates", "jobs"]);
    expect(access.defaultTab).toBe("pool");
  });

  it("accountant (reports only) → jobs ONLY; default jobs; not forbidden", () => {
    const access = resolveNotificationsPageAccess({ ...none, canReadReports: true });

    expect(access.forbidden).toBe(false);
    expect(access.visibleTabs).toEqual(["jobs"]);
    expect(access.defaultTab).toBe("jobs");
  });

  it("settings.integrations alone opens the page on the providers tab", () => {
    // Before migration 230 the page entry was the OR of the two reads, which
    // would have locked this role out of the one tab it was granted.
    const access = resolveNotificationsPageAccess({ ...none, canManageIntegrations: true });

    expect(access.forbidden).toBe(false);
    expect(access.visibleTabs).toEqual(["providers"]);
    expect(access.defaultTab).toBe("providers");
  });

  it("workflows.manage alone opens the page on the jobs tab", () => {
    const access = resolveNotificationsPageAccess({ ...none, canManageWorkflows: true });

    expect(access.forbidden).toBe(false);
    expect(access.visibleTabs).toEqual(["jobs"]);
  });

  it("no grant at all → forbidden, no tabs", () => {
    const access = resolveNotificationsPageAccess(none);

    expect(access.forbidden).toBe(true);
    expect(access.visibleTabs).toEqual([]);
  });

  it("notifications only → pool + templates; default pool", () => {
    const access = resolveNotificationsPageAccess({ ...none, canReadNotifications: true });

    expect(access.forbidden).toBe(false);
    expect(access.visibleTabs).toEqual(["pool", "templates"]);
    expect(access.defaultTab).toBe("pool");
  });
});
