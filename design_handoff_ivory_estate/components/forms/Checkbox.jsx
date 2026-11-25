import * as React from "react";
const __css =
  "\n.ds-checkbox{display:grid;place-content:center;height:16px;width:16px;flex-shrink:0;border-radius:var(--radius-sm);border:1px solid var(--primary);background:transparent;box-shadow:var(--shadow);cursor:pointer;padding:0;outline:none}\n.ds-checkbox:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-checkbox[data-state=checked]{background:var(--primary);color:var(--primary-foreground)}\n.ds-checkbox:disabled{cursor:not-allowed;opacity:.5}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-checkbox")) {
  const s = document.createElement("style");
  s.id = "ds-css-checkbox";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Checkbox({
  checked,
  defaultChecked = false,
  onCheckedChange,
  className = "",
  ...props
}) {
  const [internal, setInternal] = React.useState(defaultChecked);
  const isChecked = checked !== undefined ? checked : internal;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isChecked}
      data-state={isChecked ? "checked" : "unchecked"}
      className={"ds-checkbox " + className}
      onClick={() => {
        const n = !isChecked;
        setInternal(n);
        onCheckedChange && onCheckedChange(n);
      }}
      {...props}
    >
      {isChecked && (
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
      )}
    </button>
  );
}
