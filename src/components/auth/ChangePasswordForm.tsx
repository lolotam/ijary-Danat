import { useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useI18n } from "@/i18n/provider";

/**
 * نموذج تعيين كلمة مرور جديدة.
 *
 * One form for both callers: the emailed reset link and the forced change a
 * temporary password carries (FR-032). The fields and their rules live here;
 * what happens with the new password is the caller's business, so the caller
 * passes an `onSubmit` and gets back the message to show.
 */

const passwordSchema = z
  .object({
    password: z.string().min(8),
    confirmPassword: z.string().min(8),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "mismatch",
  });

export interface ChangePasswordPayload {
  currentPassword?: string;
  password: string;
}

export interface ChangePasswordFormProps {
  /**
   * يطلب كلمة المرور الحالية قبل التعيين عند التغيير الطوعي (غير الإجباري).
   */
  requireCurrentPassword?: boolean;
  /**
   * ينفّذ التغيير ويعيد رسالة الخطأ جاهزة للعرض، أو null عند النجاح.
   *
   * The message is a translated string rather than a code, so the form stays
   * free of the server's error vocabulary.
   */
  onSubmit: (values: ChangePasswordPayload) => Promise<string | null>;
}

/**
 * يعرض نموذج تعيين كلمة مرور جديدة والتحقق من تطابقها وطولها الأدنى.
 */
export function ChangePasswordForm({
  requireCurrentPassword = false,
  onSubmit,
}: ChangePasswordFormProps) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * يتحقق من الحقول ثم يسلّم كلمة المرور الجديدة إلى المستدعي.
   */
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (requireCurrentPassword && currentPassword.length === 0) {
      setError(t("passwordReset.currentPasswordRequired"));
      return;
    }

    const parsed = passwordSchema.safeParse({ password, confirmPassword });
    if (!parsed.success) {
      setError(
        parsed.error.issues.some((issue) => issue.message === "mismatch")
          ? t("passwordReset.mismatch")
          : t("passwordReset.weak"),
      );
      return;
    }

    setSubmitting(true);
    let failure: string | null;
    try {
      failure = await onSubmit({
        ...(requireCurrentPassword ? { currentPassword } : {}),
        password: parsed.data.password,
      });
    } finally {
      setSubmitting(false);
    }
    if (failure) {
      setError(failure);
      return;
    }
    setCurrentPassword("");
    setPassword("");
    setConfirmPassword("");
  }

  return (
    <form className="grid max-w-md gap-4" onSubmit={handleSubmit}>
      {requireCurrentPassword ? (
        <div className="grid gap-2">
          <Label htmlFor="current-password">{t("passwordReset.currentPassword")}</Label>
          <PasswordInput
            id="current-password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </div>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="new-password">{t("passwordReset.newPassword")}</Label>
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
        <Label htmlFor="confirm-password">{t("passwordReset.confirmPassword")}</Label>
        <PasswordInput
          id="confirm-password"
          autoComplete="new-password"
          minLength={8}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
        />
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={submitting} className="w-fit">
        {submitting ? t("common.loading") : t("passwordReset.submit")}
      </Button>
    </form>
  );
}
