import type { CaptureResult } from "posthog-js";
import { describe, expect, test } from "vitest";

import { redactEventUrls, redactReplayRequestUrl, redactUrl } from "./posthogPrivacy";

const TENANT = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

describe("redactUrl", () => {
  test.each([
    [
      "portal preview keeps the route, drops tenant and contract",
      `https://danat-future.com/portal?tenant=${TENANT}&contract=${TENANT}`,
      "https://danat-future.com/portal",
    ],
    [
      "payment callback drops the gateway payment ID",
      "https://danat-future.com/portal/payments/callback?paymentId=07074528937",
      "https://danat-future.com/portal/payments/callback",
    ],
    [
      "payment-request path segment becomes :id",
      "https://danat-future.com/portal/payments/callback/PREQ-2026-0042",
      "https://danat-future.com/portal/payments/callback/:id",
    ],
    [
      "admin record UUID becomes :id, sub-route kept",
      `https://danat-future.com/admin/tenants/${TENANT}/documents`,
      "https://danat-future.com/admin/tenants/:id/documents",
    ],
    [
      "recovery-link token in the hash is dropped",
      "https://danat-future.com/reset-password#access_token=eyJhbGciOi&type=recovery",
      "https://danat-future.com/reset-password",
    ],
    ["a bare $pathname stays relative", `/admin/units/${TENANT}`, "/admin/units/:id"],
    ["route names are left alone", "/admin/settings/backup", "/admin/settings/backup"],
    ["an unparseable URL is dropped, not passed through", "http://[::1", ""],
    ["PostHog's $direct referrer sentinel is not a URL", "$direct", "$direct"],
  ])("%s", (_scenario, input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe("redactEventUrls", () => {
  test("cleans URL properties in the event and both person-property bags", () => {
    const portalUrl = `https://danat-future.com/portal?tenant=${TENANT}`;
    const event: CaptureResult = {
      uuid: "event-1",
      event: "$pageview",
      properties: {
        $current_url: portalUrl,
        $pathname: `/admin/tenants/${TENANT}`,
        $browser: "Chrome",
      },
      $set: { $current_url: portalUrl },
      $set_once: { $initial_current_url: portalUrl, $initial_referrer: "$direct" },
    };

    const cleaned = redactEventUrls(event);

    expect(cleaned).toEqual({
      ...event,
      properties: {
        $current_url: "https://danat-future.com/portal",
        $pathname: "/admin/tenants/:id",
        $browser: "Chrome",
      },
      $set: { $current_url: "https://danat-future.com/portal" },
      $set_once: {
        $initial_current_url: "https://danat-future.com/portal",
        $initial_referrer: "$direct",
      },
    });
  });

  // Production, 2026-09-25: the first live check found the tenant UUID in
  // $web_vitals_FCP_event.navigationURL and .$current_url — one level down,
  // where a top-level-only redaction never looked.
  test("cleans the URLs web vitals nest inside each metric object", () => {
    const portalUrl = `https://danat-future.com/portal?tenant=${TENANT}`;
    // An LCP entry inside the metric's `entries` array (Codex review, PR #257).
    const signedImage =
      "https://supabase.danat-future.com/storage/v1/object/sign/landing/hero.webp?token=eyJhbGciOi";
    const event: CaptureResult = {
      uuid: "event-2",
      event: "$web_vitals",
      properties: {
        $web_vitals_FCP_value: 412,
        $web_vitals_FCP_event: {
          name: "FCP",
          value: 412,
          navigationURL: portalUrl,
          $current_url: portalUrl,
          entries: [{ name: "lcp", url: signedImage }],
        },
      },
    };

    expect(redactEventUrls(event)?.properties.$web_vitals_FCP_event).toEqual({
      name: "FCP",
      value: 412,
      navigationURL: "https://danat-future.com/portal",
      $current_url: "https://danat-future.com/portal",
      entries: [
        {
          name: "lcp",
          url: "https://supabase.danat-future.com/storage/v1/object/sign/landing/hero.webp",
        },
      ],
    });
  });

  test("leaves session-replay snapshots to the replay hook, untouched here", () => {
    const snapshot: CaptureResult = {
      uuid: "event-3",
      event: "$snapshot",
      properties: { $snapshot_data: [{ type: 4, data: { href: `/portal?tenant=${TENANT}` } }] },
    };

    expect(redactEventUrls(snapshot)).toBe(snapshot);
  });

  test("passes an event already dropped by an earlier hook through as null", () => {
    expect(redactEventUrls(null)).toBeNull();
  });
});

describe("redactReplayRequestUrl", () => {
  test("cleans the recorded URL and keeps the rest of the request", () => {
    const request = {
      name: `https://supabase.danat-future.com/rest/v1/invoices?tenant_id=eq.${TENANT}`,
      entryType: "resource",
      duration: 120,
    } as Parameters<typeof redactReplayRequestUrl>[0];

    expect(redactReplayRequestUrl(request)).toEqual({
      ...request,
      name: "https://supabase.danat-future.com/rest/v1/invoices",
    });
  });
});
