import * as React from "react";
const __css =
  "\n.ds-dialog-overlay{position:fixed;inset:0;z-index:50;background:rgb(0 0 0 / 0.8)}\n.ds-dialog{position:fixed;left:50%;top:50%;z-index:50;display:grid;width:100%;max-width:32rem;transform:translate(-50%,-50%);gap:16px;border:1px solid var(--border);background:var(--background);padding:24px;box-shadow:var(--shadow-lg);border-radius:var(--radius-lg);box-sizing:border-box}\n.ds-dialog-close{position:absolute;inset-inline-end:16px;top:16px;border-radius:var(--radius-sm);opacity:.7;cursor:pointer;background:none;border:none;padding:2px;color:var(--foreground);transition:opacity .15s}\n.ds-dialog-close:hover{opacity:1}\n.ds-dialog-header{display:flex;flex-direction:column;gap:6px}\n.ds-dialog-title{font:600 1.125rem/1 var(--font-sans);letter-spacing:-0.01em;margin:0}\n.ds-dialog-desc{font-size:0.875rem;color:var(--muted-foreground);margin:0}\n.ds-dialog-footer{display:flex;justify-content:flex-end;gap:8px}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-dialog")) {
  const s = document.createElement("style");
  s.id = "ds-css-dialog";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Dialog({ open, onOpenChange, children }) {
  if (!open) return null;
  return (
    <div>
      <div className="ds-dialog-overlay" onClick={() => onOpenChange && onOpenChange(false)}></div>
      <div className="ds-dialog" role="dialog" aria-modal="true">
        {children}
        <button
          type="button"
          className="ds-dialog-close"
          aria-label="Close"
          onClick={() => onOpenChange && onOpenChange(false)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
export function DialogHeader({ children, className = "" }) {
  return <div className={"ds-dialog-header " + className}>{children}</div>;
}
export function DialogTitle({ children, className = "" }) {
  return <h2 className={"ds-dialog-title " + className}>{children}</h2>;
}
export function DialogDescription({ children, className = "" }) {
  return <p className={"ds-dialog-desc " + className}>{children}</p>;
}
export function DialogFooter({ children, className = "" }) {
  return <div className={"ds-dialog-footer " + className}>{children}</div>;
}
