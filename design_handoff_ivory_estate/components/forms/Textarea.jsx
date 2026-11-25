import * as React from "react";
const __css =
  "\n.ds-textarea{display:flex;min-height:60px;width:100%;border-radius:var(--radius-md);border:1px solid var(--input);background:transparent;padding:8px 12px;font:400 0.875rem/1.25rem var(--font-sans);color:var(--foreground);box-shadow:var(--shadow-sm);outline:none;box-sizing:border-box;resize:vertical}\n.ds-textarea::placeholder{color:var(--muted-foreground)}\n.ds-textarea:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-textarea:disabled{cursor:not-allowed;opacity:.5}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-textarea")) {
  const s = document.createElement("style");
  s.id = "ds-css-textarea";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Textarea({ className = "", ...props }) {
  return <textarea className={"ds-textarea " + className} {...props} />;
}
