import * as React from "react";
const __css =
  "\n.ds-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;border-radius:9999px;font:500 0.875rem/1.25rem var(--font-sans);cursor:pointer;transition:background-color .15s,color .15s;border:1px solid transparent;outline:none}\n.ds-btn:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-btn:disabled{pointer-events:none;opacity:.5;cursor:not-allowed}\n.ds-btn svg{width:16px;height:16px;flex-shrink:0;pointer-events:none}\n.ds-btn--default{background:var(--primary);color:var(--primary-foreground);box-shadow:var(--shadow)}\n.ds-btn--default:hover{background:color-mix(in oklab,var(--primary) 90%,transparent)}\n.ds-btn--destructive{background:var(--destructive);color:var(--destructive-foreground);box-shadow:var(--shadow-sm)}\n.ds-btn--destructive:hover{background:color-mix(in oklab,var(--destructive) 90%,transparent)}\n.ds-btn--outline{border-width:1.5px;border-color:var(--foreground);background:var(--background);color:var(--foreground);box-shadow:var(--shadow-sm)}\n.ds-btn--outline:hover{background:var(--accent);color:var(--accent-foreground)}\n.ds-btn--secondary{background:var(--secondary);color:var(--secondary-foreground);box-shadow:var(--shadow-sm)}\n.ds-btn--secondary:hover{background:color-mix(in oklab,var(--secondary) 80%,transparent)}\n.ds-btn--ghost{background:transparent;color:var(--foreground)}\n.ds-btn--ghost:hover{background:var(--accent);color:var(--accent-foreground)}\n.ds-btn--gold{background:var(--accent);color:var(--accent-foreground);box-shadow:var(--shadow);font-weight:600}\n.ds-btn--gold:hover{background:color-mix(in oklab,var(--accent) 88%,#fff)}\n.ds-btn--link{background:transparent;color:var(--primary);text-underline-offset:4px}\n.ds-btn--link:hover{text-decoration:underline}\n.ds-btn--size-default{height:38px;padding:8px 20px}\n.ds-btn--size-sm{height:32px;padding:0 12px;font-size:0.75rem}\n.ds-btn--size-lg{height:48px;padding:0 34px;font-size:0.9375rem}\n.ds-btn--size-icon{height:36px;width:36px;padding:0}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-button")) {
  const s = document.createElement("style");
  s.id = "ds-css-button";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Button({
  variant = "default",
  size = "default",
  className = "",
  children,
  ...props
}) {
  return (
    <button
      className={"ds-btn ds-btn--" + variant + " ds-btn--size-" + size + " " + className}
      {...props}
    >
      {children}
    </button>
  );
}
