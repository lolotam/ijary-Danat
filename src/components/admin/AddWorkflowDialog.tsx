import { zodResolver } from "@hookform/resolvers/zod";
import { ShieldAlert } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { RecipientTargetsPicker } from "@/components/admin/RecipientTargetsPicker";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useCreateWorkflow } from "@/hooks/useCronJobs";
import { useI18n } from "@/i18n/provider";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";

const KEY_RE = /^[a-z0-9-]+$/;

const workflowFormSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(KEY_RE, "Key must be lowercase letters, digits, and hyphens only."),
  kind: z.enum(["scheduled", "event"]),
  name_ar: z.string().trim().min(1).max(200),
  name_en: z.string().trim().min(1).max(200),
  description_ar: z.string().trim().max(1000),
  description_en: z.string().trim().max(1000),
  recipient_targets: z.array(z.enum(["admin", "company", "tenant"])).min(1),
});

type WorkflowForm = z.infer<typeof workflowFormSchema>;

const emptyForm = (): WorkflowForm => ({
  key: "",
  kind: "event",
  name_ar: "",
  name_en: "",
  description_ar: "",
  description_en: "",
  recipient_targets: ["admin", "company"],
});

/**
 * Creates a registry-only cron_jobs row.
 *
 * Nothing will dispatch the new key until a developer wires it into the JOBS
 * map or a sender — this dialog says so plainly because a table badge is not
 * enough warning at the moment of creation. There is no cron-expression field:
 * nowhere to store one, and nothing would read it.
 */
export function AddWorkflowDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const createWorkflow = useCreateWorkflow();
  const form = useForm<WorkflowForm>({
    resolver: zodResolver(workflowFormSchema),
    defaultValues: emptyForm(),
  });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(emptyForm());
    onOpenChange(next);
  }

  async function onSubmit(values: WorkflowForm) {
    try {
      await createWorkflow.mutateAsync({
        key: values.key,
        kind: values.kind,
        name_ar: values.name_ar,
        name_en: values.name_en,
        description_ar: values.description_ar || null,
        description_en: values.description_en || null,
        recipient_targets: values.recipient_targets,
      });
      toast.success(t("workflows.created"));
      handleOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  const recipientTargets = form.watch("recipient_targets");
  const kind = form.watch("kind");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("workflows.addTitle")}</DialogTitle>
          <DialogDescription>{t("workflows.addDescription")}</DialogDescription>
        </DialogHeader>

        {/* Same shape as the managerial-role warning on the Users screen, whose
            opacity-based amber survives dark mode — a flat bg-amber-50 does not. */}
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden="true" />
          <span>{t("workflows.addNotWiredWarning")}</span>
        </div>

        <form className="grid gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="space-y-2">
            <Label required htmlFor="workflow-key">
              {t("workflows.fieldKey")}
            </Label>
            <Input
              id="workflow-key"
              dir="ltr"
              className="font-mono"
              placeholder="my-custom-workflow"
              {...form.register("key")}
            />
            {form.formState.errors.key ? (
              <p className="text-xs text-destructive">{form.formState.errors.key.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("workflows.fieldKeyHint")}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label required>{t("workflows.fieldKind")}</Label>
            <RadioGroup
              value={kind}
              onValueChange={(value) =>
                form.setValue("kind", value as "scheduled" | "event", { shouldValidate: true })
              }
              className="flex flex-wrap gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="scheduled" id="kind-scheduled" />
                <Label htmlFor="kind-scheduled" className="font-normal">
                  {t("workflows.kindScheduled")}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="event" id="kind-event" />
                <Label htmlFor="kind-event" className="font-normal">
                  {t("workflows.kindEvent")}
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label required>{t("workflows.recipients")}</Label>
            <RecipientTargetsPicker
              value={recipientTargets}
              supported={["admin", "company", "tenant"]}
              disabled={createWorkflow.isPending}
              onChange={(next: WorkflowRecipientTarget[]) =>
                form.setValue("recipient_targets", next, { shouldValidate: true })
              }
            />
            {form.formState.errors.recipient_targets ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.recipient_targets.message}
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label required htmlFor="workflow-name-ar">
                {t("workflows.fieldNameAr")}
              </Label>
              <Input id="workflow-name-ar" dir="rtl" {...form.register("name_ar")} />
              {form.formState.errors.name_ar ? (
                <p className="text-xs text-destructive">{form.formState.errors.name_ar.message}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label required htmlFor="workflow-name-en">
                {t("workflows.fieldNameEn")}
              </Label>
              <Input id="workflow-name-en" dir="ltr" {...form.register("name_en")} />
              {form.formState.errors.name_en ? (
                <p className="text-xs text-destructive">{form.formState.errors.name_en.message}</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="workflow-desc-ar">{t("workflows.fieldDescriptionAr")}</Label>
            <Textarea
              id="workflow-desc-ar"
              dir="rtl"
              rows={2}
              {...form.register("description_ar")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workflow-desc-en">{t("workflows.fieldDescriptionEn")}</Label>
            <Textarea
              id="workflow-desc-en"
              dir="ltr"
              rows={2}
              {...form.register("description_en")}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={createWorkflow.isPending}>
              {createWorkflow.isPending ? t("common.loading") : t("workflows.addSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
