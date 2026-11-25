import * as React from "react";
const __css =
  "\n.ds-input{display:flex;height:36px;width:100%;border-radius:var(--radius-md);border:1px solid var(--input);background:transparent;padding:4px 12px;font:400 0.875rem/1.25rem var(--font-sans);color:var(--foreground);box-shadow:var(--shadow-sm);transition:border-color .15s,box-shadow .15s;outline:none;box-sizing:border-box}\n.ds-input::placeholder{color:var(--muted-foreground)}\n.ds-input:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-input:disabled{cursor:not-allowed;opacity:.5}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-input")) {
  const s = document.createElement("style");
  s.id = "ds-css-input";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Input({ className = "", ...props }) {
  return <input className={"ds-input " + className} {...props} />;
}
