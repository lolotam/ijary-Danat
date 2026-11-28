import { useEffect, useMemo, useState } from "react";

import { translatorFor } from "@/i18n/dictionary";
import { buildContractHtml } from "@/lib/contractBuilder/html";
import type { ContractIssuer } from "@/lib/contractBuilder/issuer";
import {
  contractBuilderDraftSchema,
  type ContractBuilderValues,
  type ContractLocale,
} from "@/lib/contractBuilder/schema";

/**
 * يؤخر بناء الصفحات أثناء الكتابة، ويعزل HTML دون صلاحيات سكربت أو أصل مشترك.
 *
 * `issuer` is the signed-in company's first-party data; the PDF route reads
 * the same fields on the server, so preview and download print one company.
 */
export function ContractPreview({
  values,
  locale,
  issuer,
}: {
  values: ContractBuilderValues;
  locale: ContractLocale;
  issuer: ContractIssuer;
}) {
  const [draft, setDraft] = useState({ values, locale });
  useEffect(() => {
    const timer = setTimeout(() => setDraft({ values, locale }), 300);
    return () => clearTimeout(timer);
  }, [values, locale]);
  const srcDoc = useMemo(() => {
    const parsed = contractBuilderDraftSchema.safeParse(draft.values);
    const fragment = parsed.success ? buildContractHtml(parsed.data, draft.locale, issuer) : "";
    return `<!doctype html><html lang="${draft.locale}" dir="${draft.locale === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"></head><body>${fragment}</body></html>`;
  }, [draft, issuer]);
  // The contract's own language, not the interface's: the preview is titled
  // in the language of the document it shows, as it was before.
  const t = translatorFor(locale);
  return (
    <iframe
      title={t("contractPreview.contractPreview")}
      sandbox=""
      srcDoc={srcDoc}
      className="h-[80vh] w-full rounded border bg-white"
    />
  );
}
