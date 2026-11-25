import * as React from "react";
const __css =
  "\n.ds-radio-group{display:grid;gap:8px}\n.ds-radio{aspect-ratio:1;height:16px;width:16px;border-radius:9999px;border:1px solid var(--primary);color:var(--primary);box-shadow:var(--shadow);cursor:pointer;background:transparent;padding:0;display:grid;place-content:center;outline:none}\n.ds-radio:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-radio:disabled{cursor:not-allowed;opacity:.5}\n.ds-radio-dot{width:9px;height:9px;border-radius:9999px;background:var(--primary)}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-radio")) {
  const s = document.createElement("style");
  s.id = "ds-css-radio";
  s.textContent = __css;
  document.head.appendChild(s);
}

const RadioCtx = React.createContext(null);
export function RadioGroup({
  value,
  defaultValue,
  onValueChange,
  className = "",
  children,
  ...props
}) {
  const [internal, setInternal] = React.useState(defaultValue);
  const val = value !== undefined ? value : internal;
  const set = (v) => {
    setInternal(v);
    onValueChange && onValueChange(v);
  };
  return (
    <div role="radiogroup" className={"ds-radio-group " + className} {...props}>
      <RadioCtx.Provider value={{ val, set }}>{children}</RadioCtx.Provider>
    </div>
  );
}
export function RadioGroupItem({ value, className = "", ...props }) {
  const ctx = React.useContext(RadioCtx) || {};
  const checked = ctx.val === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={"ds-radio " + className}
      onClick={() => ctx.set && ctx.set(value)}
      {...props}
    >
      {checked && <span className="ds-radio-dot"></span>}
    </button>
  );
}
