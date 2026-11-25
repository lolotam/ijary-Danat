import { createFileRoute } from "@tanstack/react-router";
import { AtSign, KeyRound, Mail, Phone, UserRound } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { SectionCard } from "@/components/shared/SectionCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { LtrText } from "@/components/ui/ltr-text";
import { usePortalIdentity } from "@/hooks/usePortalData";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

export const Route = createFileRoute("/portal/profile")({ component: PortalProfilePage });

const passwordSchema = z
  .object({
    password: z.string().min(8),
    confirmPassword: z.string().min(8),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "mismatch",
  });

function PortalProfilePage() {
  const { locale, t } = useI18n();
  const identity = usePortalIdentity();
  const tenant = identity.data?.tenant ?? null;
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!tenant) return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    const parsed = passwordSchema.safeParse({ password, confirmPassword });
    if (!parsed.success) {
      setError(
        parsed.error.issues.some((issue) => issue.message === "mismatch")
          ? t("portal.profile.passwordMismatch")
          : t("portal.profile.passwordRequirements"),
      );
      return;
    }
    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({
      password: parsed.data.password,
    });
    setSubmitting(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setPassword("");
    setConfirmPassword("");
    setMessage(t("portal.profile.passwordChanged"));
  }

  const fields = [
    {
      label: t("portal.profile.name"),
      value: tenantDisplayName(tenant, locale),
      icon: UserRound,
      tile: "from-blue-500 to-blue-700 shadow-blue-500/30",
      ltr: false,
    },
    {
      label: t("portal.profile.code"),
      value: tenant.code,
      icon: UserRound,
      tile: "from-slate-500 to-slate-700 shadow-slate-500/30",
      ltr: false,
    },
    {
      label: t("portal.profile.email"),
      value: tenant.email ?? "—",
      icon: Mail,
      tile: "from-emerald-500 to-emerald-700 shadow-emerald-500/30",
      // Email is Latin/punctuation; force LTR so @ and domain stay ordered in Arabic UI.
      ltr: true,
    },
    {
      label: t("portal.profile.mobile"),
      value: tenant.mobile ?? tenant.whatsapp ?? "—",
      icon: Phone,
      tile: "from-amber-500 to-orange-600 shadow-amber-500/30",
      // Phone digits must stay LTR under the RTL label; LtrText isolates direction only.
      ltr: true,
    },
    {
      label: t("portal.profile.username"),
      // Tenants created before usernames existed sign in by email; show an em dash
      // rather than inventing a value that was never stored.
      value: identity.data?.profile.username ?? "—",
      icon: AtSign,
      tile: "from-violet-500 to-purple-700 shadow-violet-500/30",
      ltr: true,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("portal.profile.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("portal.profile.readOnly")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => {
          const Icon = field.icon;
          return (
            <Card
              key={field.label}
              className="transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <CardContent className="flex items-center gap-4 p-5">
                <div
                  className={`grid size-10 place-items-center rounded-lg bg-gradient-to-br text-white shadow-md ${field.tile}`}
                >
                  <Icon className="size-5" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{field.label}</p>
                  <p className="mt-1 font-bold">
                    {field.ltr ? <LtrText>{field.value}</LtrText> : field.value}
                  </p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <KeyRound className="size-5" />
            {t("portal.profile.changePassword")}
          </span>
        }
        gradient="from-indigo-600 to-purple-700"
        bodyClassName="p-5"
      >
        <form className="grid max-w-lg gap-4" onSubmit={changePassword}>
          <div className="grid gap-2">
            <Label htmlFor="new-password">{t("portal.profile.newPassword")}</Label>
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm-password">{t("portal.profile.confirmPassword")}</Label>
            <PasswordInput
              id="confirm-password"
              autoComplete="new-password"
              minLength={8}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {message && <p className="text-sm text-emerald-700">{message}</p>}
          <Button type="submit" disabled={submitting} className="w-fit">
            {submitting ? t("common.loading") : t("portal.profile.updatePassword")}
          </Button>
        </form>
      </SectionCard>
    </div>
  );
}
