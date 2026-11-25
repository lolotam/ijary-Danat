import { useEffect, useMemo, useState } from "react";

import { translatorFor } from "@/i18n/dictionary";
import { buildContractHtml, CONTRACT_LOGO_PUBLIC_URL } from "@/lib/contractBuilder/html";
import {
  contractBuilderDraftSchema,
  type ContractBuilderValues,
  type ContractLocale,
} from "@/lib/contractBuilder/schema";

/** يؤخر بناء الصفحات أثناء الكتابة، ويعزل HTML دون صلاحيات سكربت أو أصل مشترك. */
export function ContractPreview({
  values,
  locale,
}: {
  values: ContractBuilderValues;
  locale: ContractLocale;
}) {
  const [draft, setDraft] = useState({ values, locale });
  useEffect(() => {
    const timer = setTimeout(() => setDraft({ values, locale }), 300);
    return () => clearTimeout(timer);
  }, [values, locale]);
  const srcDoc = useMemo(() => {
    const parsed = contractBuilderDraftSchema.safeParse(draft.values);
    const fragment = parsed.success
      ? buildContractHtml(parsed.data, draft.locale, CONTRACT_LOGO_PUBLIC_URL)
      : "";
    return `<!doctype html><html lang="${draft.locale}" dir="${draft.locale === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"></head><body>${fragment}</body></html>`;
  }, [draft]);
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
