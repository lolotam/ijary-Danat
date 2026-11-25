/** Best-effort message from a server-fn / fetch rejection. */
export function knetErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      data?: unknown;
      body?: unknown;
      response?: { status?: number; data?: unknown };
    };
    for (const value of [
      candidate.message,
      candidate.data,
      candidate.body,
      candidate.response?.data,
    ]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return String(error ?? "");
}

/**
 * Whether a failed KNET-link request was the chronological-order refusal.
 *
 * useServerFn historically dropped Response.status/body, so a correct 409 used
 * to surface as the generic "could not load the data" toast. createPayment now
 * throws Error with the chronological wording; keep multi-shape checks so older
 * deployments and Response-shaped errors still map correctly.
 */
export function isChronologicalOrderRefusal(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    response?: { status?: number };
  } | null;
  if (candidate?.status === 409 || candidate?.response?.status === 409) return true;
  return knetErrorMessage(error).toLowerCase().includes("chronological");
}

/**
 * Map a createPayment / KNET-link failure to a dictionary key.
 *
 * Allowlist only — raw server/framework strings must never reach the toast.
 * Unrecognised shapes fall back to the generic failure key.
 */
export function knetToastKey(error: unknown): string {
  if (isChronologicalOrderRefusal(error)) {
    return "invoices.knetLinkOutOfOrder";
  }
  const message = knetErrorMessage(error).toLowerCase();
  if (message.includes("payable balance")) {
    return "invoices.knetLinkNoBalance";
  }
  if (message.includes("not authorized to pay")) {
    return "invoices.knetLinkNotAuthorized";
  }
  if (message.includes("permission to create payment")) {
    return "invoices.knetLinkNoPermission";
  }
  return "invoices.knetLinkFailed";
}

/**
 * يحوّل فشل تعليم الفاتورة كمدفوعة إلى مفتاح قاموس للواجهة.
 *
 * Separate from {@link knetToastKey}: the same chronological Error must toast
 * `invoices.markPaidOutOfOrder` here and keep `invoices.knetLinkOutOfOrder`
 * for the KNET-link button beside it.
 */
export function markPaidToastKey(error: unknown): string {
  if (isChronologicalOrderRefusal(error)) {
    return "invoices.markPaidOutOfOrder";
  }
  return "common.error";
}
