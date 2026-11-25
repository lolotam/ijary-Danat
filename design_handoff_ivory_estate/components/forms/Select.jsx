import * as React from "react";
const __css =
  "\n.ds-select{position:relative;display:inline-block;width:100%}\n.ds-select-trigger{display:flex;height:36px;width:100%;align-items:center;justify-content:space-between;white-space:nowrap;border-radius:var(--radius-md);border:1px solid var(--input);background:transparent;padding:8px 12px;font:400 0.875rem/1.25rem var(--font-sans);color:var(--foreground);box-shadow:var(--shadow-sm);cursor:pointer;outline:none;box-sizing:border-box;gap:8px}\n.ds-select-trigger:focus{box-shadow:0 0 0 1px var(--ring)}\n.ds-select-trigger[data-placeholder=true]{color:var(--muted-foreground)}\n.ds-select-content{position:absolute;top:calc(100% + 4px);inset-inline-start:0;z-index:50;min-width:8rem;width:100%;overflow:hidden;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--popover);color:var(--popover-foreground);box-shadow:var(--shadow-md);padding:4px;box-sizing:border-box}\n.ds-select-item{position:relative;display:flex;width:100%;cursor:default;user-select:none;align-items:center;border-radius:var(--radius-sm);padding:6px 32px 6px 8px;font-size:0.875rem;outline:none;box-sizing:border-box}\n[dir=rtl] .ds-select-item{padding:6px 8px 6px 32px}\n.ds-select-item:hover{background:var(--accent);color:var(--accent-foreground)}\n.ds-select-check{position:absolute;inset-inline-end:8px;display:flex;height:14px;width:14px;align-items:center;justify-content:center}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-select")) {
  const s = document.createElement("style");
  s.id = "ds-css-select";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Select({
  options = [],
  value,
  defaultValue,
  placeholder = "اختر",
  onValueChange,
  className = "",
  disabled,
}) {
  const [internal, setInternal] = React.useState(defaultValue);
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  const val = value !== undefined ? value : internal;
  React.useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const selected = options.find((o) => o.value === val);
  return (
    <div className={"ds-select " + className} ref={ref}>
      <button
        type="button"
        disabled={disabled}
        className="ds-select-trigger"
        data-placeholder={!selected}
        onClick={() => setOpen(!open)}
      >
        <span>{selected ? selected.label : placeholder}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ opacity: 0.5 }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="ds-select-content" role="listbox">
          {options.map((o) => (
            <div
              key={o.value}
              className="ds-select-item"
              role="option"
              aria-selected={o.value === val}
              onClick={() => {
                setInternal(o.value);
                onValueChange && onValueChange(o.value);
                setOpen(false);
              }}
            >
              {o.value === val && (
                <span className="ds-select-check">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
              )}
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
