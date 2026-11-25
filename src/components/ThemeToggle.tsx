import { Moon, Sun } from "lucide-react";
import { useTheme } from "./ThemeProvider";

/**
 * يبدّل بين الوضع المضيء والمظلم، مع هدف لمس أكبر على الأجهزة اللمسية.
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const label =
    theme === "dark" ? "تفعيل الوضع المضيء / Use light mode" : "تفعيل الوضع المظلم / Use dark mode";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="relative flex size-10 pointer-coarse:size-11 shrink-0 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors duration-200 hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={label}
      title={label}
    >
      <div className="relative h-5 w-5 flex items-center justify-center overflow-hidden">
        {/* Sun Icon */}
        <span
          className={`absolute flex items-center justify-center transition-all duration-300 ${
            theme === "dark" ? "rotate-90 scale-0 opacity-0" : "rotate-0 scale-100 opacity-100"
          }`}
        >
          <Sun className="h-4.5 w-4.5 text-amber-500" />
        </span>
        {/* Moon Icon */}
        <span
          className={`absolute flex items-center justify-center transition-all duration-300 ${
            theme === "dark" ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-0 opacity-0"
          }`}
        >
          <Moon className="h-4.5 w-4.5 text-gold-soft" />
        </span>
      </div>
    </button>
  );
}
