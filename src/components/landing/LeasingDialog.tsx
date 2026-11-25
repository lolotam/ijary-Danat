import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { usePostHog } from "posthog-js/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { submitContactInquiry } from "@/fns/submitContactInquiry";
import { submitLeasingInquiry } from "@/fns/submitLeasingInquiry";
import { useI18n } from "@/i18n/provider";
import {
  landingInquirySchema,
  toContactInquiry,
  toLeasingInquiry,
  type LandingInquiryValues,
} from "@/lib/landingInquiryForm";

interface LeasingDialogProps {
  leasingDialogOpen: boolean;
  setLeasingDialogOpen: (open: boolean) => void;
}

/**
 * نموذج طلب التأجير أو الطلب العام، مع حالة الإرسال ورسالة النجاح.
 *
 * Only the open flag lives in the page, because the leasing section's button
 * opens it; the form, its validation and the submit status are this dialog's.
 */
export function LeasingDialog({ leasingDialogOpen, setLeasingDialogOpen }: LeasingDialogProps) {
  const { t, locale } = useI18n();
  const posthog = usePostHog();
  const [leasingStatus, setLeasingStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle",
  );

  // Forms hook
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<LandingInquiryValues>({
    resolver: zodResolver(useMemo(() => landingInquirySchema(locale), [locale])),
    defaultValues: {
      name: "",
      request_type: "leasing",
      company_name: "",
      business_activity: "",
      phone: "",
      email: "",
      preferred_size: "",
      preferred_contact_method: "phone",
      message: "",
      consent: false,
      website: "",
    },
  });

  // Drives which fields the leasing dialog shows; the two retail-only fields
  // are hidden for a general request.
  const requestType = watch("request_type");

  // Submit contact/leasing inquiry. Routes by request_type:
  // - "leasing" → leasing_inquiries table → Inbox "Leads" tab
  // - "general" → contact_inquiries table → Inbox "Visitor messages" tab
  const onSubmitLeasing = async (data: LandingInquiryValues) => {
    setLeasingStatus("loading");
    try {
      if (data.request_type === "general") {
        await submitContactInquiry({
          data: toContactInquiry(data, locale, t("landingPage.generalRequestFromContactForm")),
        });
      } else {
        await submitLeasingInquiry({ data: toLeasingInquiry(data, locale) });
      }
      posthog.capture("leasing_inquiry_submitted", {
        request_type: data.request_type,
        preferred_contact_method: data.preferred_contact_method,
      });
      setLeasingStatus("success");
      reset();
      setTimeout(() => {
        setLeasingDialogOpen(false);
        setLeasingStatus("idle");
      }, 3000);
    } catch (err) {
      console.error(err);
      setLeasingStatus("error");
    }
  };

  return (
    <Dialog open={leasingDialogOpen} onOpenChange={setLeasingDialogOpen}>
      {/*
        Centred by `inset-0` + `m-auto` instead of the base DialogContent's
        `translate-x-[-50%] translate-y-[-50%]`, matching the Gmail compose
        window. Auto margins cannot be defeated by a transform because they
        do not use one.

        `h-fit` is what makes the vertical centring work here, and it is the
        one difference from compose. Auto margins centre vertically only
        against a *definite* height; compose has `h-[92vh]`, but this dialog
        is content-sized, and `top: 0; bottom: 0` with `height: auto` would
        stretch it to the full viewport rather than centre it. `max-h-[90vh]`
        with `overflow-y-auto` still keeps a long form scrollable.

        `w-[92vw]` replaces the base `w-full` so the form keeps a margin on
        narrow screens; `max-w-lg` still caps it on desktop.
      */}
      <DialogContent className="fixed inset-0 m-auto h-fit max-h-[90vh] w-[92vw] max-w-lg translate-x-0 translate-y-0 overflow-y-auto border border-border bg-background text-foreground">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold text-foreground">
            {t("landing.leasing.form.title")}
          </DialogTitle>
          {/*
            Follows the request type, like the fields below it. This was a
            hard-coded retail-leasing sentence, so choosing "General request"
            hid the retail fields but still told the visitor to describe a
            corporate retail requirement — the form said one thing and asked
            for another.
          */}
          <DialogDescription className="text-muted-foreground/80">
            {t(
              requestType === "general"
                ? "landing.leasing.form.description.general"
                : "landing.leasing.form.description.leasing",
            )}
          </DialogDescription>
        </DialogHeader>

        {leasingStatus === "success" ? (
          <div className="space-y-4 py-12 text-center" role="status" aria-live="polite">
            <CheckCircle className="h-16 w-16 text-accent mx-auto" />
            <h3 className="text-xl font-bold text-foreground">
              {t("landing.leasing.form.success")}
            </h3>
          </div>
        ) : (
          <form noValidate onSubmit={handleSubmit(onSubmitLeasing)} className="space-y-4 mt-4">
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="hidden"
              {...register("website")}
            />
            <div className="space-y-1">
              <Label htmlFor="request_type">
                {t("landing.leasing.form.requestType")} <span className="text-destructive">*</span>
              </Label>
              <select
                id="request_type"
                {...register("request_type")}
                className="flex h-10 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-foreground"
              >
                <option value="leasing">{t("landing.leasing.form.requestType.leasing")}</option>
                <option value="general">{t("landing.leasing.form.requestType.general")}</option>
              </select>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="name">
                  {t("landing.leasing.form.name")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="name"
                  required
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "name-error" : undefined}
                  {...register("name")}
                  className="bg-muted border-border text-foreground"
                />
                {errors.name && (
                  <p id="name-error" role="alert" className="text-xs text-destructive">
                    {t("landingPage.nameIsRequired")}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <Label htmlFor="company_name">{t("landing.leasing.form.company")}</Label>
                <Input
                  id="company_name"
                  {...register("company_name")}
                  className="bg-muted border-border text-foreground"
                />
              </div>

              {/* Retail-specific — meaningless on a general enquiry, and
                  contact_inquiries has nowhere to put them. Hidden rather
                  than dropped: anything already typed is still appended to
                  the general message body by composeGeneralRequestMessage. */}
              {requestType !== "general" && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="business_activity">{t("landing.leasing.form.activity")}</Label>
                    <Input
                      id="business_activity"
                      {...register("business_activity")}
                      className="bg-muted border-border text-foreground"
                      placeholder={t("landingPage.perfumesCafeApparel")}
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="preferred_size">{t("landing.leasing.form.size")}</Label>
                    <Input
                      id="preferred_size"
                      {...register("preferred_size")}
                      className="bg-muted border-border text-foreground"
                      placeholder={t("landingPage.50100")}
                    />
                  </div>
                </>
              )}

              <div className="space-y-1">
                <Label htmlFor="phone">
                  {t("landing.leasing.form.phone")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="phone"
                  dir="ltr"
                  required
                  aria-invalid={Boolean(errors.phone)}
                  aria-describedby={errors.phone ? "phone-error" : undefined}
                  {...register("phone")}
                  className="bg-muted border-border text-foreground text-left"
                  placeholder="+965 5xxxxxxx"
                />
                {errors.phone && (
                  <p id="phone-error" role="alert" className="text-xs text-destructive">
                    {t("landingPage.enterAPhoneNumberWith")}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <Label htmlFor="email">
                  {t("landing.leasing.form.email")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="email"
                  type="email"
                  required
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? "email-error" : undefined}
                  {...register("email")}
                  className="bg-muted border-border text-foreground"
                  placeholder="name@example.com"
                />
                {errors.email && (
                  <p id="email-error" role="alert" className="text-xs text-destructive">
                    {t("landingPage.enterAValidEmailAddress")}
                  </p>
                )}
              </div>

              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="preferred_contact_method">
                  {t("landing.leasing.form.contactMethod")}
                </Label>
                <select
                  id="preferred_contact_method"
                  {...register("preferred_contact_method")}
                  className="w-full rounded-md border border-border bg-muted p-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="phone">{t("landing.leasing.form.contactMethod.phone")}</option>
                  <option value="email">{t("landing.leasing.form.contactMethod.email")}</option>
                  <option value="whatsapp">
                    {t("landing.leasing.form.contactMethod.whatsapp")}
                  </option>
                </select>
              </div>

              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="message">{t("landing.leasing.form.message")}</Label>
                <Textarea
                  id="message"
                  aria-invalid={Boolean(errors.message)}
                  aria-describedby={errors.message ? "message-error" : undefined}
                  {...register("message")}
                  className="bg-muted border-border text-foreground"
                  rows={3}
                />
                {errors.message && (
                  <p id="message-error" role="alert" className="text-xs text-destructive">
                    {t("landingPage.messageTooLong")}
                  </p>
                )}
              </div>

              <div className="md:col-span-2 flex items-start gap-2 pt-2">
                <input
                  type="checkbox"
                  id="consent"
                  required
                  aria-invalid={Boolean(errors.consent)}
                  aria-describedby={errors.consent ? "consent-error" : undefined}
                  {...register("consent")}
                  className="h-4 w-4 rounded border-border text-accent focus:ring-ring mt-0.5 bg-muted"
                />
                <Label htmlFor="consent" className="text-xs text-muted-foreground leading-snug">
                  {t("landing.leasing.form.consent")} <span className="text-destructive">*</span>
                </Label>
              </div>
              {errors.consent && (
                <p
                  id="consent-error"
                  role="alert"
                  className="text-xs text-destructive md:col-span-2"
                >
                  {t("landingPage.consentIsRequired")}
                </p>
              )}
            </div>

            {leasingStatus === "error" && (
              <div
                role="alert"
                className="rounded border border-destructive/30 bg-destructive/10 p-3 text-center text-xs font-semibold text-destructive"
              >
                {t("landing.leasing.form.error")}
              </div>
            )}

            <DialogFooter className="pt-4">
              <Button
                type="submit"
                disabled={leasingStatus === "loading"}
                className="w-full bg-[#d4af37] py-3.5 font-bold text-[#171204]"
              >
                {leasingStatus === "loading"
                  ? t("landing.leasing.form.submitting")
                  : t("landing.leasing.form.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
