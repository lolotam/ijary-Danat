import "./lib/error-capture";

import { captureException, wrapFetchWithSentry } from "@sentry/tanstackstart-react";

import { initSentryServer } from "./instrument.server";
import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

// Before anything below can throw or serve a request.
initSentryServer();

type ServerEntry = {
  fetch: (request: Request, ...passthrough: unknown[]) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  const error = consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`);
  // The wrapper outside only ever sees the finished 500; this is the one place
  // the real SSR exception is still in hand.
  captureException(error);
  console.error(error);
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

import { validateEnv } from "./lib/env.server";

/**
 * نقطة دخول الخادم ملفوفة بـ Sentry حتى تُقاس الطلبات وتُلتقط أخطاء
 * دوال الخادم قبل أن يحوّلها الالتقاط أدناه إلى صفحة 500.
 *
 * `passthrough` keeps whatever the host hands after the request (Cloudflare's
 * env/ctx, nothing under Bun) flowing to the framework untouched.
 */
export default wrapFetchWithSentry({
  async fetch(request: Request, ...passthrough: unknown[]) {
    try {
      validateEnv();
      const handler = await getServerEntry();
      const response = await handler.fetch(request, ...passthrough);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      // Same reason as above: returning the fallback page hides the throw from
      // wrapFetchWithSentry.
      captureException(error);
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
});
