import type { Json } from "@/integrations/supabase/database.types";

export interface GatewayConfig {
  apiKey: string;
  baseUrl: string;
}

export function gatewayConfigFromEnv(): GatewayConfig {
  const apiKey = process.env.MYFATOORAH_API_KEY;
  // `||`, not `??`: compose sets unset vars to "" and an empty base URL is never valid.
  const baseUrl = process.env.MYFATOORAH_BASE_URL || "https://api.myfatoorah.com";
  if (!apiKey) {
    throw new Error("MyFatoorah is not configured. Set MYFATOORAH_API_KEY.");
  }
  return { apiKey, baseUrl };
}

/**
 * A bare `fetch` has no timeout. If MyFatoorah accepts the connection and then
 * never replies, the request hangs for as long as the socket stays open — the
 * server function never returns, and the caller's UI waits forever with nothing
 * to report. Twenty seconds is well past the gateway's normal sub-second
 * response while still bounding the failure.
 */
const GATEWAY_TIMEOUT_MS = 20_000;

async function gatewayRequest(config: GatewayConfig, path: string, init: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    // A timeout and a DNS failure both arrive here. Name which one, because
    // "MyFatoorah request failed" alone sends the next person to the wrong log.
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `did not respond within ${GATEWAY_TIMEOUT_MS / 1000}s`
        : `could not be reached: ${error instanceof Error ? error.message : String(error)}`;
    throw new Error(`MyFatoorah ${reason}`, { cause: error });
  }
  const responseText = await response.text();
  let responseBody: Json;
  try {
    responseBody = JSON.parse(responseText) as Json;
  } catch {
    responseBody = { message: responseText || response.statusText };
  }
  if (!response.ok) {
    throw new Error(
      `MyFatoorah request failed (${response.status}): ${responseText || response.statusText}`,
    );
  }
  return responseBody;
}

export async function postToGateway(config: GatewayConfig, path: string, payload: Json) {
  return gatewayRequest(config, path, { method: "POST", body: JSON.stringify(payload) });
}

export async function getFromGateway(config: GatewayConfig, path: string) {
  return gatewayRequest(config, path, { method: "GET" });
}
