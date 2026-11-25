import { useEffect, useRef, useState } from "react";
import { Eye, Paperclip, Trash2, X, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileTypeIcon } from "./FileTypeIcon";
import { useI18n } from "@/i18n/provider";
import { STORAGE_UPLOAD_MAX_BYTES } from "@/lib/uploadLimits";

export type DepositAttachmentValue =
  | { mode: "keep" }
  | { mode: "clear" }
  | { mode: "replace"; file: File };

export interface DepositAttachmentFieldProps {
  /** Existing storage path from the deposit row, if any. */
  existingPath: string | null | undefined;
  /** Current value (controlled). */
  value: DepositAttachmentValue;
  onChange: (next: DepositAttachmentValue) => void;
  /** Open the deposit's existing attachment preview (host page owns signed URL fetch). */
  onPreviewExisting?: () => void;
  disabled?: boolean;
}

interface StagedFile {
  file: File;
  previewUrl: string;
}

function isImageFile(file: File) {
  return file.type.toLowerCase().startsWith("image/");
}
function isPdfFile(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function DepositAttachmentField({
  existingPath,
  value,
  onChange,
  onPreviewExisting,
  disabled,
}: DepositAttachmentFieldProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [staged, setStaged] = useState<StagedFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sync staged file with the controlled value when reopening the dialog.
  useEffect(() => {
    if (value.mode !== "replace") {
      if (staged) {
        URL.revokeObjectURL(staged.previewUrl);
        setStaged(null);
      }
      if (inputRef.current) inputRef.current.value = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (staged) URL.revokeObjectURL(staged.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > STORAGE_UPLOAD_MAX_BYTES) {
      setError(t("deposits.attachmentTooLarge"));
      event.target.value = "";
      return;
    }
    if (!isImageFile(file) && !isPdfFile(file)) {
      setError(t("deposits.attachmentWrongType"));
      event.target.value = "";
      return;
    }
    setError(null);
    const previewUrl = URL.createObjectURL(file);
    setStaged({ file, previewUrl });
    onChange({ mode: "replace", file });
  };

  const handleClearSelection = () => {
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged(null);
    if (inputRef.current) inputRef.current.value = "";
    // "keep" is correct either way: with an existing file it reverts to it, without one
    // it leaves the deposit unattached.
    onChange({ mode: "keep" });
  };

  const handleRemoveExisting = () => {
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged(null);
    if (inputRef.current) inputRef.current.value = "";
    onChange({ mode: "clear" });
  };

  const cleared = value.mode === "clear";
  const showExistingCard = Boolean(existingPath) && !staged && !cleared;
  const showStaged = Boolean(staged);
  const showClearedState = cleared && !staged;
  const showEmptyDrop = !existingPath && !staged && !cleared;

  return (
    <div className="space-y-2">
      <Label>{t("deposits.attachment")}</Label>

      {/* Hidden file input is always rendered to keep ref stable; user clicks the button to trigger */}
      <Input
        ref={inputRef}
        type="file"
        accept="image/*,.pdf"
        className="hidden"
        onChange={handlePick}
        disabled={disabled}
      />

      {/* Existing attachment preview card */}
      {showExistingCard ? (
        <div className="flex items-center gap-3 rounded-md border p-3">
          <div className="flex size-10 items-center justify-center rounded bg-muted">
            <FileTypeIcon path={existingPath} className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{existingPath?.split("/").pop()}</p>
            <p className="text-xs text-muted-foreground">{t("deposits.currentAttachment")}</p>
          </div>
          {onPreviewExisting ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onPreviewExisting}
              disabled={disabled}
            >
              <Eye className="size-4" /> {t("common.preview")}
            </Button>
          ) : null}
          <Button
            title={t("common.delete")}
            aria-label={t("common.delete")}
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleRemoveExisting}
            disabled={disabled}
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      ) : null}

      {/* Staged new file */}
      {showStaged && staged ? (
        <div className="flex items-center gap-3 rounded-md border border-primary/40 bg-primary/5 p-3">
          <div className="flex size-10 items-center justify-center rounded bg-background">
            {isImageFile(staged.file) ? (
              <img
                src={staged.previewUrl}
                alt={staged.file.name}
                className="size-10 rounded object-cover"
              />
            ) : (
              <FileTypeIcon
                mimeType={staged.file.type}
                path={staged.file.name}
                className="h-5 w-5 text-primary"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{staged.file.name}</p>
            <p className="text-xs text-muted-foreground">
              {t("deposits.newAttachmentSelected")} · {(staged.file.size / 1024).toFixed(0)} KB
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleClearSelection}
            disabled={disabled}
          >
            <X className="size-4" /> {t("deposits.cancelSelection")}
          </Button>
        </div>
      ) : null}

      {/* Cleared state — was attached, now removed */}
      {showClearedState ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-destructive/40 bg-destructive/5 p-3 text-sm">
          <FileWarning className="size-5 text-destructive" />
          <span className="flex-1">{t("deposits.attachmentRemoved")}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange({ mode: "keep" })}
            disabled={disabled}
          >
            {t("common.undo")}
          </Button>
        </div>
      ) : null}

      {/* Empty drop / pick button */}
      {showEmptyDrop || cleared ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="flex w-full flex-col items-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground transition hover:border-primary hover:text-primary"
        >
          <Paperclip className="h-5 w-5" />
          {t("deposits.attachmentPickHint")}
        </button>
      ) : null}

      {/* Replace existing CTA when an attachment is already there */}
      {showExistingCard ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          {t("deposits.replaceAttachment")}
        </Button>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
