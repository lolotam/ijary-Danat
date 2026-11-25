/**
 * @vitest-environment jsdom
 *
 * تبقى معاينة الرسالة «غير معروفة» ما دامت تُحمَّل، فلا يُفتح الإرسال قبل أوانه.
 *
 * Review finding on PR #224 (audit M10). Every edit to the template, body,
 * contract or locale gives the preview queries a new key; while they refetch
 * their data is undefined. Reporting `[]` then told the dialog nothing was
 * unresolved and re-enabled Send until the new preview arrived — a fast click
 * sent literal {{placeholders}}. The panel must report `null` while resolving.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@tanstack/react-start", async (original) => ({
  ...(await original<typeof import("@tanstack/react-start")>()),
  useServerFn: () => mocks.resolve,
}));

const { MessagePreviewPanel } = await import("@/components/admin/MessagePreviewPanel");

/** نتيجة معاينة بمتغير واحد غير محلول. */
function resolved(missing: string[]) {
  return { subject: "s", body: "b", variables: {}, missing };
}

let container: HTMLDivElement;
let root: Root;
let reports: Array<string[] | null>;

/** يركّب اللوحة بجسم معيّن ويسجّل كل ما تبلّغ به. */
function render(body: string): void {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MessagePreviewPanel
            tenantId="tenant-1"
            templateCode={null}
            contractId={null}
            channel="email"
            body={body}
            onUnresolvedChange={(keys) => reports.push(keys)}
          />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  );
}

/** ينتظر استقرار الوعود والتأثيرات. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  reports = [];
  mocks.resolve.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("preview pending state", () => {
  it("reports null — not [] — while the preview is still resolving", async () => {
    mocks.resolve.mockReturnValue(new Promise(() => {}));
    render("Hello {{tenant_name}}");
    await settle();

    expect(reports.at(-1)).toBeNull();
    expect(reports).not.toContainEqual([]);
  });

  it("reports the unresolved keys once the preview answers", async () => {
    mocks.resolve.mockResolvedValue(resolved(["tenant_name"]));
    render("Hello {{tenant_name}}");
    await settle();

    expect(reports.at(-1)).toEqual(["tenant_name"]);
  });

  it("goes back to null — never [] — when an edit triggers a refetch", async () => {
    mocks.resolve.mockResolvedValue(resolved(["tenant_name"]));
    render("Hello {{tenant_name}}");
    await settle();
    reports = [];

    mocks.resolve.mockReturnValue(new Promise(() => {}));
    render("Hi {{tenant_name}}");
    await settle();

    expect(reports).not.toContainEqual([]);
    expect(reports.at(-1)).toBeNull();
  });
});
