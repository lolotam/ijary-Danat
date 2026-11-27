import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { RESEND_WEBHOOK_SECRET_NAME } from "@/fns/emailSenderStatus";
import { respondToResendWebhook } from "@/fns/resendWebhook";
import { decodeByteaHex } from "@/gateways/connectionStore.server";
import { decryptSecret } from "@/lib/secrets.server";

const companyIdSchema = z.string().uuid();

/**
 * يقرأ سرّ توقيع ويب هوك Resend الخاص بالشركة من `company_secrets`.
 *
 * The secret belongs to the company's own sender, so it lives beside that
 * sender's credential (owner_kind `email`, owner_id the provider row). A
 * company that never configured a sender has no secret here — its mail goes
 * through the platform's default sender and its own endpoint stays closed.
 */
async function readCompanyWebhookSecret(companyId: string): Promise<string | null> {
  const db = companyClient(companyId, { allowSuspended: true });

  const provider = await db
    .from("provider_configs")
    .select("*")
    .eq("provider", "resend")
    .eq("is_enabled", true)
    .maybeSingle();
  if (provider.error) throw new Error(`provider_configs read failed: ${provider.error.message}`);
  if (!provider.data) return null;

  // Zero means the row still uses the platform's environment reference, and no
  // company secret is stored for it — hence no webhook secret either.
  const version = provider.data.secrets_version;

  const secrets = await db
    .from("company_secrets")
    .select("ciphertext, iv, auth_tag, key_version")
    .eq("owner_kind", "email")
    .eq("owner_id", provider.data.id)
    .eq("name", RESEND_WEBHOOK_SECRET_NAME)
    .eq("version", version);
  if (secrets.error) throw new Error(`company secret read failed: ${secrets.error.message}`);

  const row = secrets.data?.[0];
  if (!row) return null;
  return decryptSecret({
    ciphertext: decodeByteaHex(row.ciphertext),
    iv: decodeByteaHex(row.iv),
    authTag: decodeByteaHex(row.auth_tag),
    keyVersion: row.key_version,
  });
}

/**
 * يستقبل أحداث تسليم البريد لمُرسّل شركة اختارته لنفسها.
 *
 * The company comes from the URL, never from the payload: a payload is the
 * sender's to write, and one company must never be able to move another
 * company's notification by naming it in the body.
 */
export async function handleCompanyResendWebhook(
  request: Request,
  companyId: string,
): Promise<Response> {
  const parsed = companyIdSchema.safeParse(companyId);
  if (!parsed.success) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const secret = await readCompanyWebhookSecret(parsed.data);
  if (!secret) {
    // The endpoint exists for every company, but a company without its own
    // sender has no secret to verify with; answering 503 says the endpoint is
    // not configured here rather than that the request was wrong.
    return Response.json({ error: "Webhook secret is not configured." }, { status: 503 });
  }

  return respondToResendWebhook(request, {
    kind: "company",
    companyId: parsed.data,
    secret,
  });
}

export const Route = createFileRoute("/api/public/webhooks/resend/$companyId")({
  server: {
    handlers: {
      POST: ({ request, params }) => handleCompanyResendWebhook(request, params.companyId),
    },
  },
});
