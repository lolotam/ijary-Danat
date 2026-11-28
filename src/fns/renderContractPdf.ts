import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { readContractIssuer } from "@/fns/contractIssuer.server";
import { buildContractHtml } from "@/lib/contractBuilder/html";
import { contractBuilderSchema } from "@/lib/contractBuilder/schema";
import { contractPdfFilename } from "@/lib/contractBuilder/filename";
export { contractPdfFilename } from "@/lib/contractBuilder/filename";
import { renderHtmlToPdf, wrapHtmlForPdf } from "@/lib/serverPdf";
import { requirePermission } from "@/fns/requirePermission";

export const renderContractPdfInput = z.object({
  values: contractBuilderSchema,
  locale: z.enum(["ar", "en"]),
});

/**
 * يبني ترويسة Content-Disposition بملف ASCII احتياطي واسم UTF-8 حتى تُقبل الأحرف العربية.
 *
 * `filename=` is a ByteString; a raw Arabic trade name throws in `new Response`.
 */
function contentDispositionAttachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * يصنّع PDF عقد الاستثمار ويُرجعه كمرفق ثنائي بعد التحقق من صلاحية القراءة.
 */
export const renderContractPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => renderContractPdfInput.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "contracts.read",
      attempted: "contract.render_pdf",
      refusal: "You do not have permission to read contracts.",
    });

    const issuer = await readContractIssuer();
    const pdf = await renderHtmlToPdf(
      wrapHtmlForPdf(buildContractHtml(data.values, data.locale, issuer), {
        arabic: data.locale === "ar",
      }),
    );

    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": contentDispositionAttachment(contractPdfFilename(data.values)),
      },
    });
  });
