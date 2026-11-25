import type { ContractBuilderValues } from "./schema";

/** حقول التواصل الخاصة بإنشاء الحساب، وهي محذوفة من سياق البنود عمداً. */
export type ContactField = "contact_mobile" | "contact_whatsapp" | "contact_email";

/**
 * The printed text is built only from this context, and it cannot carry the
 * contact fields — the omission is in the type, so a clause that tried to
 * print a tenant's phone or email would not compile.
 */
export type ClauseContext = Omit<ContractBuilderValues, ContactField> & {
  totalWords: string;
  monthlyWords: string;
  durationWords: string;
  dayName: string;
  /** "3 (الرقم الآلي 12345) و 4" — see `formatUnitList` for the multi-plot form. */
  unitList: string;
  /** Units span several plots: the preamble and clause 2 switch to plural wording. */
  multiPlot: boolean;
};

export type ClauseText = {
  number: number;
  title: string;
  /** Paragraphs; sub-items as separate strings prefixed "أ-" / "a.". */
  body: string[];
};

export type ContractCopy = {
  companyName: string;
  officeAddress: string;
  footer: string;
  title: string;
  opening(ctx: ClauseContext): string;
  firstParty: string;
  secondPartyHeading: string;
  /** Second-party lines by mode, always ending with `capacityStatement`. */
  secondParty(ctx: ClauseContext): string[];
  capacityStatement: string;
  preambleTitle: string;
  preamble(ctx: ClauseContext): string;
  clauses(ctx: ClauseContext): ClauseText[];
  signatures: {
    firstParty: string;
    secondParty: string;
    authorizedSignatory: string;
    name: string;
    signature: string;
  };
  pageCounter(n: number, of: number): string;
};
