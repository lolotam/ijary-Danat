import { useFieldArray } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { CONTRACT_LIMITS, EMPTY_PERSON } from "@/lib/contractBuilder/schema";
import { BuilderField, type BuilderFormProps } from "./ContractBuilderField";

const PERSON_FIELDS = ["full_name", "nationality", "civil_id", "residence_address"] as const;
const COMPANY_FIELDS = ["company_name", "company_address"] as const;
const SIGNATORY_FIELDS = [
  "signatory_name",
  "signatory_nationality",
  "signatory_civil_id",
  "signatory_address",
] as const;

/**
 * يعرض بيانات الطرف الثاني بحسب نوعه: أفراد حتى ثلاثة، أو شركة ومفوضها بالتوقيع.
 *
 * The hidden branch's inputs unmount but its values stay in the form
 * (react-hook-form keeps them: `shouldUnregister` is off), so flipping the
 * mode back restores what was typed; only the active branch is validated
 * (`refineSecondParty` in schema.ts).
 */
export function SecondPartyFields({ form, t }: BuilderFormProps) {
  const persons = useFieldArray({ control: form.control, name: "persons" });
  const mode = form.watch("second_party_type");
  return (
    <fieldset className="space-y-3">
      <legend>{t("contractBuilder.persons")}</legend>
      <label className="grid gap-1 text-sm">
        {t("contractBuilder.secondPartyType")}
        <select
          aria-label={t("contractBuilder.secondPartyType")}
          className="h-9 rounded border bg-background px-3"
          {...form.register("second_party_type", {
            onChange: (event: { target: { value: string } }) => {
              // A company contract starts with no persons; switching to
              // individual must still offer one empty person to fill.
              if (event.target.value === "individual" && persons.fields.length === 0) {
                persons.append({ ...EMPTY_PERSON });
              }
            },
          })}
        >
          <option value="individual">{t("contractBuilder.secondPartyType.individual")}</option>
          <option value="company">{t("contractBuilder.secondPartyType.company")}</option>
        </select>
      </label>
      {mode === "individual" ? (
        <>
          {persons.fields.map((person, index) => (
            <div key={person.id} className="space-y-2 rounded border p-3">
              <p className="text-sm font-medium">
                {t(`contractBuilder.personOrdinal.${index + 1}`)}
              </p>
              {PERSON_FIELDS.map((key) => (
                <BuilderField
                  key={key}
                  form={form}
                  t={t}
                  name={`persons.${index}.${key}`}
                  label={key}
                  inputMode={key === "civil_id" ? "numeric" : undefined}
                />
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={persons.fields.length === 1}
                onClick={() => persons.remove(index)}
              >
                {t("contractBuilder.removePerson")}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={persons.fields.length >= CONTRACT_LIMITS.persons}
            onClick={() => persons.append({ ...EMPTY_PERSON })}
          >
            {t("contractBuilder.addPerson")}
          </Button>
        </>
      ) : (
        <div className="space-y-2 rounded border p-3">
          {COMPANY_FIELDS.map((key) => (
            <BuilderField key={key} form={form} t={t} name={`company.${key}`} label={key} />
          ))}
          <p className="pt-2 text-sm font-medium">{t("contractBuilder.signatoryHeading")}</p>
          {SIGNATORY_FIELDS.map((key) => (
            <BuilderField
              key={key}
              form={form}
              t={t}
              name={`company.${key}`}
              label={key}
              inputMode={key === "signatory_civil_id" ? "numeric" : undefined}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}

/**
 * يعرض بيانات التواصل لإنشاء حساب المستأجر، مع تنبيه بأنها لا تُطبع في العقد.
 */
export function ContactFields({ form, t }: BuilderFormProps) {
  return (
    <fieldset className="space-y-2 rounded border border-dashed p-3">
      <legend>{t("contractBuilder.contactHeading")}</legend>
      <p className="text-sm text-muted-foreground">{t("contractBuilder.contactNotPrinted")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <BuilderField
          form={form}
          t={t}
          name="contact_mobile"
          label="contact_mobile"
          type="tel"
          inputMode="tel"
        />
        <BuilderField
          form={form}
          t={t}
          name="contact_whatsapp"
          label="contact_whatsapp"
          type="tel"
          inputMode="tel"
        />
        <BuilderField
          form={form}
          t={t}
          name="contact_email"
          label="contact_email"
          type="email"
          inputMode="email"
        />
      </div>
    </fieldset>
  );
}
