import { v } from "./boldMarkers";
import type { ClauseContext, ClauseText, ContractCopy } from "./clauses.types";
import type { ContractIssuer } from "./issuer";
import { formatKwdFromFils, toFils, totalValueFils } from "./schema";

export type { ClauseContext, ClauseText, ContractCopy } from "./clauses.types";

// The issuing company's legal identity stays Arabic on the English document
// (see contractIssuerFromCompany), matching the scans' letterhead and the
// html.test.ts "no Arabic outside company/address" rule.

/**
 * يبني سطر الطرف الأول الإنجليزي من بيانات الشركة صاحبة العقد.
 *
 * The seat sentence is dropped when the company has no address on file.
 */
function firstParty(issuer: ContractIssuer): string {
  const seat = issuer.address ? ` Whose premises are at: ${issuer.address}.` : "";
  return `First: Messrs. / ${issuer.name}.${seat} hereinafter referred to in this contract as (the First Party)`;
}

/**
 * يبني شريط التذييل الإنجليزي من عنوان الشركة وهاتفها، متجاوزاً الحقل الفارغ.
 */
function footer(issuer: ContractIssuer): string {
  const phone = issuer.phone ? `Tel: ${issuer.phone}` : "";
  return [issuer.address, phone].filter(Boolean).join(" – ");
}

/**
 * يكتب إجمالي قيمة العقد رقماً من الفلس، لا من ضرب عشري عائم.
 */
function totalKwd(ctx: ClauseContext): string {
  return formatKwdFromFils(totalValueFils(ctx));
}

/**
 * يكتب القيمة الشهرية رقماً من الفلس بثلاث خانات.
 */
function monthlyKwd(ctx: ClauseContext): string {
  return formatKwdFromFils(toFils(ctx.monthly_value));
}

/**
 * يبني سطر الافتتاح الإنجليزي بتاريخ العقد واسم اليوم.
 */
function opening(ctx: ClauseContext): string {
  return `On ${v(ctx.dayName)} corresponding to ${v(ctx.contract_date)} AD, it was agreed between the following parties:-`;
}

const CAPACITY =
  "Both parties acknowledge their legal capacity to contract and to dispose, and that their wills are free of any defect that would invalidate legal acts, and have agreed as follows:";

const PERSON_ORDINALS = ["first", "second", "third"] as const;

/**
 * يبني فقرات الطرف الثاني بالإنجليزية بحسب نوعه، ثم إقرار الأهلية القانونية.
 */
function secondParty(ctx: ClauseContext): string[] {
  if (ctx.second_party_type === "company") {
    const c = ctx.company;
    return [
      `Second Party: Company / ${v(c.company_name)}, having its seat at: ${v(c.company_address)}, legally represented by the authorized signatory Mr. / ${v(c.signatory_name)}, nationality: ${v(c.signatory_nationality)}, Civil ID: (${v(c.signatory_civil_id)}), residing at: ${v(c.signatory_address)}.`,
      CAPACITY,
    ];
  }
  const several = ctx.persons.length > 1;
  const lines = ctx.persons.map((person, index) => {
    const label = several ? `Second Party (${PERSON_ORDINALS[index]} person)` : "Second Party";
    return `${label}: Mr. / ${v(person.full_name)}, nationality: ${v(person.nationality)}, Civil ID: (${v(person.civil_id)}), residing at: ${v(person.residence_address)}.`;
  });
  return [...lines, CAPACITY];
}

/**
 * يبني التمهيد الإنجليزي: العقار والوحدات والنشاط والاسم التجاري.
 */
function preamble(ctx: ClauseContext): string {
  const property = ctx.multiPlot
    ? `the commercial complexes located in ${v(ctx.governorate)} Governorate, Block (${v(ctx.block)}) – Plots (${v(ctx.parcel)}), for the purpose of investing their units`
    : `the commercial complex located in ${v(ctx.governorate)} Governorate, Block (${v(ctx.block)}) – Plot (${v(ctx.parcel)}), for the purpose of investing its units`;
  const units = ctx.multiPlot ? ctx.unitList : `${ctx.unitList} in the said plot`;
  return `Whereas the First Party owns ${property} for profit in accordance with the Kuwaiti Commercial Law, and whereas the Second Party wishes to invest the units numbered ${units} for the purpose of operating a commercial activity (${v(ctx.activity)}) under the trade name (${v(ctx.trade_name)}), and after a full inspection that negates ignorance, and after reviewing the plans and the sketch of the unit subject to this contract, the wills of both parties have met to conclude this contract and they have agreed to contract in accordance with the following clauses:-`;
}

/**
 * يعيد البنود الثمانية عشر بترجمة أمينة للنص العربي المنقول من المسح.
 */
function clauses(ctx: ClauseContext): ClauseText[] {
  const increaseLine = ctx.increase
    ? `The two parties agreed to increase the investment value of the invested unit every ${v(ctx.increase.every_years)} years at the rate of ${v(ctx.increase.percent)}% of the last variable investment value.`
    : null;

  return [
    {
      number: 1,
      title: "Clause (1)",
      body: [
        "Without prejudice to the provisions and conditions of this contract, the preceding preamble and all correspondence and documentary evidence of the Second Party shall be an integral part of this contract and complementary and supplementary thereto.",
      ],
    },
    {
      number: 2,
      title: "Clause (2)",
      body: [
        `The Second Party has invested from the First Party the units numbered ${ctx.unitList}${ctx.multiPlot ? `, located on Plots (${v(ctx.parcel)}), Block (${v(ctx.block)}), in` : ` in Plot (${v(ctx.parcel)}), Block (${v(ctx.block)}), located in`} ${v(ctx.governorate)} Governorate, according to the attached plan, for the purpose of operating them in the activity of ${v(ctx.activity)} under the trade name (${v(ctx.trade_name)}).`,
      ],
    },
    {
      number: 3,
      title: "Clause (3)",
      body: [
        `The term of this contract is ${v(ctx.durationWords)} in the Gregorian calendar, commencing from the date of signing this contract, and the signature shall constitute actual handover of the invested unit, provided that the investment value shall fall due after the expiry of the grace period, and the contract may be terminated during its term subject to notifying the other party of vacating at least ${v(ctx.notice_months)} months in advance.`,
        "Should both parties wish to renew after the expiry of the contract term, they shall agree on the renewed term and the new investment value, and the Second Party undertakes in all cases to deliver the invested unit to the First Party immediately upon expiry of the original or renewed term whenever so requested.",
      ],
    },
    {
      number: 4,
      title: "Clause (4)",
      body: [
        `The two parties agreed that the total contract value for the invested premises shall be the amount of (${v(totalKwd(ctx))} KWD) only ${v(ctx.totalWords)} and no more – at a monthly value of (${v(monthlyKwd(ctx))} KWD) only ${v(ctx.monthlyWords)} and no more – and the Second Party shall pay the investment value in advance each Gregorian month no later than seven days from the first day of the due month at (${v(monthlyKwd(ctx))} KWD) only ${v(ctx.monthlyWords)} and no more.`,
        `The investment value for the invested premises shall be paid in advance for ${v(ctx.advance_months)} months upon signing this contract.`,
        ...(increaseLine ? [increaseLine] : []),
        `The Second Party shall be granted a grace period from the investment value of ${v(ctx.grace_months)} months, and in the event of vacating before the end of the contract term the Second Party shall pay the full investment value for the preceding grace period.`,
        `The two parties agreed that payment shall be made at the First Party's premises, and in the event of delay beyond the agreed due date the First Party shall have the right to terminate the contract unilaterally and vacate the unit without judgments or court orders, this being the terminating condition of the contract, with the Second Party obliged to pay delay interest at ${v(ctx.late_fee_percent)}% of the monthly investment value for each day of delay until complete vacating.`,
        `The Second Party shall, as part of the general expenses, pay the amount of (${v(ctx.service_charge_monthly)} KWD) Kuwaiti dinars monthly in return for providing cleaning services and their supplies, and this amount shall take the same rules as the investment value as to due date and place of payment.`,
      ],
    },
    {
      number: 5,
      title: "Clause (5)",
      body: [
        "The Second Party acknowledges that upon signing the contract it shall be obliged to take delivery of the invested unit subject to the contract under an official handover report signed by both parties and to commence decoration, finishing and insulation works, and if it fails to do so the Second Party shall be deemed to have taken delivery of the premises by operation of law, and they shall be under its hand and in its possession, and the term, value and all contractual conditions shall begin to run in accordance with the clauses of the contract.",
      ],
    },
    {
      number: 6,
      title: "Clause (6)",
      body: [
        "Upon signing this contract the Second Party shall pay one month of the monthly investment value to the First Party as a deposit for the invested premises, to be refunded without increase upon expiry or termination of the contract and delivery of the invested unit in good condition permitting its use and reinvestment, and the First Party may deduct from the deposit any financial dues relating to this contract or any damage to the invested unit arising from use, after notifying the Second Party in writing within (30 days) to repair the damage or pay the cost of repairs.",
      ],
    },
    {
      number: 7,
      title: "Clause (7)",
      body: [
        "The Second Party acknowledges that it has inspected the invested unit with a full inspection that negates ignorance in Sharia and law, and has accepted to invest it in the condition it is in, in accordance with the activities permitted by the competent authorities.",
      ],
    },
    {
      number: 8,
      title: "Clause (8)",
      body: [
        "a. The Second Party undertakes to use the invested unit subject to the contract for the licensed commercial activity, and may not change the activity except pursuant to written approval from the First Party together with the approval of the competent authorities.",
        "b. The Second Party undertakes to carry out finishing works after obtaining written approval from the First Party of the plans, and if the Second Party makes any improvements in the invested unit they shall belong exclusively to the First Party and the Second Party shall have no right upon vacating to claim their value, and the First Party may, if it does not wish to keep such improvements, require the Second Party to remove them at its own cost and expense.",
      ],
    },
    {
      number: 9,
      title: "Clause (9)",
      body: [
        "The contract shall be terminated of its own force with delivery of the unit if the Second Party is unable to use the unit for any reason, or if it is declared bankrupt or the legal entity is liquidated or destroyed, or if it is unable to meet the First Party's rights, or if the official authorities refuse to issue or renew the Second Party's legal licences, or if the Second Party refrains from issuing or renewing those licences or assigns them directly or indirectly.",
      ],
    },
    {
      number: 10,
      title: "Clause (10)",
      body: [
        "a. The Second Party undertakes to insure the unit and its movables with comprehensive insurance at an approved insurance company against natural and non-natural hazards, in particular fire, theft or water leakage, and to provide the First Party with a valid copy.",
        "b. Full liability shall rest with the Second Party without the slightest accountability of the First Party for all damage suffered by the Second Party from third parties or caused by the Second Party to third parties as a result of exploiting the invested unit.",
      ],
    },
    {
      number: 11,
      title: "Clause (11)",
      body: [
        "The Second Party undertakes not to place any advertisements or signs outside the invested plot except with written approval from the First Party and after obtaining the licences required for that from the competent government authorities, and in the event of breach the First Party may remove such advertisement at the Second Party's expense and without the slightest liability on it in this regard.",
      ],
    },
    {
      number: 12,
      title: "Clause (12)",
      body: [
        "It is agreed between the parties that this contract is an investment contract, and the Second Party may not assign this contract or transfer the right to a third party or admit a partner without referring to the First Party and obtaining prior written approval thereof.",
      ],
    },
    {
      number: 13,
      title: "Clause (13)",
      body: [
        "a. The Second Party shall bear the cost of electricity and water consumption and all fines and financial amounts for the premises subject to the investment during the contract term according to its activity, and undertakes to transfer the electricity and water meters, and must before the end of the contract produce a clearance relating to payment of all amounts due from the competent authorities.",
        "b. The Second Party shall bear all fees and expenses if it requests additional electrical loads exceeding the loads provided by the Ministry of Electricity and Water.",
        "c. The Second Party shall bear all expenses necessary for additional air-conditioning works without referring to the First Party.",
      ],
    },
    {
      number: 14,
      title: "Clause (14)",
      body: [
        "a. The Second Party undertakes to present the invested unit and the commercial licences to the First Party for periodic inspection and examination whenever so requested.",
        "b. The Second Party undertakes not to bring in heavy or large equipment or anything that would damage the unit except with written approval from the First Party.",
        "c. The Second Party undertakes not to close the invested unit for more than one month except with written approval from the First Party.",
        "d. The Second Party undertakes not to use the internal corridors of the complex and not to place any items in front of the invested unit or in the main entrance of the complex, and in the event of breach the contract shall be terminated of its own force, while always preserving the security and safety of the complex and observing good neighbourliness.",
        "e. The Second Party undertakes that the address stated at the head of this contract or the invested unit subject to the contract is the legally chosen domicile, and any notice or registered letter thereto shall be legally valid.",
      ],
    },
    {
      number: 15,
      title: "Clause (15)",
      body: [
        "In the relationship between the two parties, proofs, notices, warnings and postal correspondence of all kinds, telephone communications and signed faxes from their sender shall be accepted, and electronic mail shall be accepted in accordance with the customary and usual system between the two parties, and in general any means of communication that ensures both parties are duly informed of what the other party sends and that gives effect to this contract.",
      ],
    },
    {
      number: 16,
      title: "Clause (16)",
      body: [
        "Annexes, notifications, notices and correspondence signed by the representatives of the parties to this contract now and in the future shall be binding on both parties, provided that this is for the purpose of the nature and content of this contract.",
      ],
    },
    {
      number: 17,
      title: "Clause (17)",
      body: [
        "This contract is a commercial investment contract for profit; therefore the civil and commercial courts of Kuwait alone, to the exclusion of others, shall have jurisdiction over any dispute arising from the interpretation of this contract, taking into account that the provisions of Law No. (1978/35) concerning the lease of real estate and premises shall not apply, by agreement of both parties.",
      ],
    },
    {
      number: 18,
      title: "Clause (18)",
      body: [
        "All clauses of this contract are binding and constitute a single indivisible unit, and shall be performed and interpreted on the basis of and in accordance with the concept and requirements of the principle of good faith. This contract was drawn up in eighteen clauses including this clause and in two original copies, each party holding one copy to act pursuant thereto, and the Second Party acknowledges receipt of its copy upon signing this contract.",
      ],
    },
  ];
}

/**
 * يعدّ صفحة العقد بالصيغة الظاهرة على المسح: Page n of 5.
 */
function pageCounter(n: number, of: number): string {
  return `Page ${n} of ${of}`;
}

export const CONTRACT_COPY_EN: ContractCopy = {
  footer,
  title: "Investment Contract",
  opening,
  firstParty,
  secondPartyHeading: "Second:",
  secondParty,
  capacityStatement: CAPACITY,
  preambleTitle: "{Preamble}",
  preamble,
  clauses,
  signatures: {
    firstParty: "The First Party",
    secondParty: "The Second Party",
    authorizedSignatory: "Authorized signatory:-",
    name: "Name:-",
    signature: "Signature:-",
  },
  pageCounter,
};
