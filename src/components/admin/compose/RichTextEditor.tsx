import { useEffect, useState } from "react";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table/kit";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyleKit } from "@tiptap/extension-text-style/text-style-kit";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Highlighter,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Palette,
  PilcrowLeft,
  PilcrowRight,
  Redo,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo,
} from "lucide-react";

import { SignatureAwareTable } from "@/components/admin/compose/signatureTable";
import { TextDirection } from "@/components/admin/compose/textDirection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const FONT_FAMILIES = [
  { value: "Arial, sans-serif", labelKey: "inbox.editor.fontSans" },
  { value: "Georgia, serif", labelKey: "inbox.editor.fontSerif" },
  { value: "'Courier New', monospace", labelKey: "inbox.editor.fontMono" },
] as const;

const FONT_SIZES = ["12px", "14px", "16px", "20px", "28px"] as const;

const COLORS = [
  "#000000",
  "#666666",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
] as const;

/**
 * محرّر نصوص غنيّ لنافذة إنشاء البريد، مبني على TipTap.
 *
 * `immediatelyRender: false` is required, not cosmetic. TanStack Start renders
 * this on the server, and TipTap builds its ProseMirror view eagerly by
 * default — which needs a `document` that does not exist there. The failure
 * surfaces as a hydration mismatch rather than a clear crash.
 *
 * Table and Image are registered for the signature's sake rather than to give
 * the admin table-authoring tools; no table buttons appear in the toolbar.
 * ProseMirror discards nodes its schema does not know, so without them an
 * inserted signature — a `<table>` with an `<img>` logo — comes back as a flat
 * run of text with the logo gone.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyleKit,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      // The bundled table node is switched off so the signature-aware one can
      // take the `table` name; rows, cells and headers still come from the kit.
      TableKit.configure({ table: false }),
      SignatureAwareTable,
      Image,
      TextDirection,
    ],
    content: value,
    immediatelyRender: false,
    onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
    editorProps: {
      attributes: {
        class: "prose prose-sm dark:prose-invert max-w-none min-h-[240px] p-4 focus:outline-none",
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
      },
    },
  });

  // Only when the value genuinely diverges. Calling setContent on every render
  // resets the selection, so the caret jumps to the start on each keystroke.
  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  if (!editor) {
    // The server pass and the first client render before the view is built.
    return <div className="min-h-[280px] rounded-lg border bg-background" />;
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <EditorToolbar editor={editor} t={t} />
      <EditorContent editor={editor} />
    </div>
  );
}

/**
 * شريط أدوات المحرّر — كل زرّ يحمل تسمية وصفية للقارئ الآلي.
 */
function EditorToolbar({ editor, t }: { editor: Editor; t: (key: string) => string }) {
  const [linkUrl, setLinkUrl] = useState("");

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/30 p-2">
      <ToolbarButton
        icon={Undo}
        label={t("inbox.editor.undo")}
        onClick={() => editor.chain().focus().undo().run()}
      />
      <ToolbarButton
        icon={Redo}
        label={t("inbox.editor.redo")}
        onClick={() => editor.chain().focus().redo().run()}
      />
      <Separator orientation="vertical" className="mx-1 h-6" />

      <Select onValueChange={(font) => editor.chain().focus().setFontFamily(font).run()}>
        <SelectTrigger className="h-8 w-[7.5rem] text-xs" aria-label={t("inbox.editor.font")}>
          <SelectValue placeholder={t("inbox.editor.font")} />
        </SelectTrigger>
        <SelectContent>
          {FONT_FAMILIES.map((font) => (
            <SelectItem key={font.value} value={font.value} style={{ fontFamily: font.value }}>
              {t(font.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select onValueChange={(size) => editor.chain().focus().setFontSize(size).run()}>
        <SelectTrigger className="h-8 w-[5.5rem] text-xs" aria-label={t("inbox.editor.size")}>
          <SelectValue placeholder={t("inbox.editor.size")} />
        </SelectTrigger>
        <SelectContent>
          {FONT_SIZES.map((size) => (
            <SelectItem key={size} value={size}>
              {size}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Separator orientation="vertical" className="mx-1 h-6" />

      <ToolbarButton
        icon={Bold}
        label={t("inbox.editor.bold")}
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        icon={Italic}
        label={t("inbox.editor.italic")}
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        icon={Underline}
        label={t("inbox.editor.underline")}
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <ToolbarButton
        icon={Strikethrough}
        label={t("inbox.editor.strike")}
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <Separator orientation="vertical" className="mx-1 h-6" />

      <ColorPopover
        icon={Palette}
        label={t("inbox.editor.color")}
        onPick={(color) => editor.chain().focus().setColor(color).run()}
      />
      <ColorPopover
        icon={Highlighter}
        label={t("inbox.editor.highlight")}
        onPick={(color) => editor.chain().focus().setBackgroundColor(color).run()}
      />
      <Separator orientation="vertical" className="mx-1 h-6" />

      <ToolbarButton
        icon={AlignLeft}
        label={t("inbox.editor.alignLeft")}
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
      />
      <ToolbarButton
        icon={AlignCenter}
        label={t("inbox.editor.alignCenter")}
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
      />
      <ToolbarButton
        icon={AlignRight}
        label={t("inbox.editor.alignRight")}
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
      />
      <ToolbarButton
        icon={AlignJustify}
        label={t("inbox.editor.alignJustify")}
        onClick={() => editor.chain().focus().setTextAlign("justify").run()}
      />
      <Separator orientation="vertical" className="mx-1 h-6" />

      <ToolbarButton
        icon={List}
        label={t("inbox.editor.bulletList")}
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        icon={ListOrdered}
        label={t("inbox.editor.orderedList")}
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <Separator orientation="vertical" className="mx-1 h-6" />

      {/*
        A Popover, not window.prompt(). Native dialogs block every subsequent
        browser event and hard-freeze this project's browser automation.
      */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("inbox.editor.link")}
            aria-label={t("inbox.editor.link")}
          >
            <LinkIcon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 space-y-2">
          <Input
            dir="ltr"
            value={linkUrl}
            placeholder="https://example.com"
            onChange={(event) => setLinkUrl(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!linkUrl.trim()}
              onClick={() => {
                editor.chain().focus().setLink({ href: linkUrl.trim() }).run();
                setLinkUrl("");
              }}
            >
              {t("common.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => editor.chain().focus().unsetLink().run()}
            >
              {t("inbox.editor.unlink")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <ToolbarButton
        icon={RemoveFormatting}
        label={t("inbox.editor.clearFormat")}
        onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
      />
      <Separator orientation="vertical" className="mx-1 h-6" />

      {/*
        Per-block direction. Gmail's Arabic compose has this, and without it a
        bilingual mailbox can only write one direction per message.
      */}
      <ToolbarButton
        icon={PilcrowRight}
        label={t("inbox.editor.rtl")}
        onClick={() => editor.chain().focus().updateAttributes("paragraph", { dir: "rtl" }).run()}
      />
      <ToolbarButton
        icon={PilcrowLeft}
        label={t("inbox.editor.ltr")}
        onClick={() => editor.chain().focus().updateAttributes("paragraph", { dir: "ltr" }).run()}
      />
    </div>
  );
}

/**
 * زرّ في شريط الأدوات، بتسمية مرئية للقارئ الآلي وحالة نشطة.
 */
function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  active = false,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn("h-8 w-8", active && "bg-muted")}
      onClick={onClick}
    >
      <Icon className="size-4" />
    </Button>
  );
}

/**
 * منتقي لون مصغّر — يُستخدم للون النص وللتظليل معًا.
 */
function ColorPopover({
  icon: Icon,
  label,
  onPick,
}: {
  icon: React.ElementType;
  label: string;
  onPick: (color: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title={label}
          aria-label={label}
        >
          <Icon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <div className="grid grid-cols-4 gap-1">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              className="size-6 rounded border border-muted-foreground/20 transition-transform hover:scale-110"
              style={{ backgroundColor: color }}
              onClick={() => onPick(color)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
