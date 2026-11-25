import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * قائمة إجراءات البطاقة خلف شيفرون في الزاوية النهائية العلوية.
 *
 * `end-2` is logical so the corner follows the language (right in English,
 * left in Arabic) with no locale branch. The translucent surface keeps the
 * chevron readable when it sits on a photo.
 */
export function CardActionsMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="absolute top-2 end-2 z-10 size-8 bg-background/85 pointer-coarse:size-11"
          aria-label={label}
        >
          <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
