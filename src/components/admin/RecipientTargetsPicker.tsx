import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/i18n/provider";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";
import { cn } from "@/lib/utils";

const ALL_TARGETS: WorkflowRecipientTarget[] = ["admin", "company", "tenant"];

/**
 * Multi-select pill strip for who a workflow may notify.
 *
 * Unsupported targets stay visible but disabled so the admin can see the
 * full addressable set without a silent no-op pill. The last selected pill
 * cannot be cleared — the DB constraint is cardinality > 0, and the UI
 * should make that state unreachable rather than toast a constraint error.
 */
export function RecipientTargetsPicker({
  value,
  supported,
  disabled,
  onChange,
}: {
  value: WorkflowRecipientTarget[];
  supported: WorkflowRecipientTarget[];
  disabled: boolean;
  onChange: (next: WorkflowRecipientTarget[]) => void;
}) {
  const { t } = useI18n();

  const labels: Record<WorkflowRecipientTarget, string> = {
    admin: t("workflows.recipientAdmin"),
    company: t("workflows.recipientCompany"),
    tenant: t("workflows.recipientTenant"),
  };

  function handleChange(next: string[]) {
    // Refuse emptying the selection — cardinality(recipient_targets) > 0.
    if (next.length === 0) return;
    onChange(next as WorkflowRecipientTarget[]);
  }

  return (
    <ToggleGroup
      type="multiple"
      value={value}
      onValueChange={handleChange}
      disabled={disabled}
      className="flex flex-wrap justify-start gap-1"
      size="sm"
      variant="outline"
    >
      {ALL_TARGETS.map((target) => {
        const isSupported = supported.includes(target);
        const isSelected = value.includes(target);
        return (
          <ToggleGroupItem
            key={target}
            value={target}
            disabled={disabled || !isSupported}
            title={!isSupported ? t("workflows.recipientUnsupported") : undefined}
            aria-label={labels[target]}
            className={cn(
              "h-auto min-w-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90",
              !isSupported && "opacity-40",
            )}
          >
            <span className={cn(!isSelected && "text-muted-foreground")}>{labels[target]}</span>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
