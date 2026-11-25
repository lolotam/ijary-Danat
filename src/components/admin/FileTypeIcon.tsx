import { FileText, File, Image as ImageIcon } from "lucide-react";

export interface FileTypeIconProps {
  mimeType?: string | null;
  path?: string | null;
  className?: string;
}

function isPdf(mimeType?: string | null, path?: string | null): boolean {
  if (mimeType === "application/pdf") return true;
  if (path && path.toLowerCase().endsWith(".pdf")) return true;
  return false;
}

function isImage(mimeType?: string | null, path?: string | null): boolean {
  if (mimeType && mimeType.toLowerCase().startsWith("image/")) return true;
  if (path) {
    const ext = path.toLowerCase().split(".").pop() ?? "";
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return true;
  }
  return false;
}

export function FileTypeIcon({ mimeType, path, className }: FileTypeIconProps) {
  if (isPdf(mimeType, path)) {
    return <FileText className={className ?? "h-5 w-5"} aria-label="PDF" />;
  }
  if (isImage(mimeType, path)) {
    return <ImageIcon className={className ?? "h-5 w-5"} aria-label="Image" />;
  }
  return <File className={className ?? "h-5 w-5"} aria-label="File" />;
}

export function getFileKind(
  mimeType?: string | null,
  path?: string | null,
): "pdf" | "image" | "other" {
  if (isPdf(mimeType, path)) return "pdf";
  if (isImage(mimeType, path)) return "image";
  return "other";
}
