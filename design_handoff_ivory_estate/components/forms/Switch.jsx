import * as React from "react";
const __css =
  "\n.ds-switch{display:inline-flex;height:20px;width:36px;flex-shrink:0;cursor:pointer;align-items:center;border-radius:9999px;border:2px solid transparent;box-shadow:var(--shadow-sm);transition:background-color .15s;padding:0;outline:none}\n.ds-switch:focus-visible{box-shadow:0 0 0 2px var(--ring)}\n.ds-switch[data-state=checked]{background:var(--primary)}\n.ds-switch[data-state=unchecked]{background:var(--input)}\n.ds-switch:disabled{cursor:not-allowed;opacity:.5}\n.ds-switch-thumb{pointer-events:none;display:block;height:16px;width:16px;border-radius:9999px;background:var(--background);box-shadow:var(--shadow-lg);transition:transform .15s;transform:translateX(0)}\n.ds-switch[data-state=checked] .ds-switch-thumb{transform:translateX(16px)}\n[dir=rtl] .ds-switch[data-state=checked] .ds-switch-thumb{transform:translateX(-16px)}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-switch")) {
  const s = document.createElement("style");
  s.id = "ds-css-switch";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Switch({
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
      role="switch"
      aria-checked={isChecked}
      data-state={isChecked ? "checked" : "unchecked"}
      className={"ds-switch " + className}
      onClick={() => {
        const n = !isChecked;
        setInternal(n);
        onCheckedChange && onCheckedChange(n);
      }}
      {...props}
    >
      <span className="ds-switch-thumb"></span>
    </button>
  );
}
