import * as React from "react";
const __css =
  "\n.ds-tabs-list{display:inline-flex;height:36px;align-items:center;justify-content:center;border-radius:var(--radius-lg);background:var(--muted);padding:4px;color:var(--muted-foreground);box-sizing:border-box}\n.ds-tabs-trigger{display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;border-radius:var(--radius-md);padding:4px 12px;font:500 0.875rem/1.25rem var(--font-sans);cursor:pointer;transition:all .15s;border:none;background:transparent;color:inherit;outline:none}\n.ds-tabs-trigger[data-state=active]{background:var(--background);color:var(--foreground);box-shadow:var(--shadow)}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-tabs")) {
  const s = document.createElement("style");
  s.id = "ds-css-tabs";
  s.textContent = __css;
  document.head.appendChild(s);
}

const TabsCtx = React.createContext(null);
export function Tabs({ value, defaultValue, onValueChange, children, className = "", ...props }) {
  const [internal, setInternal] = React.useState(defaultValue);
  const val = value !== undefined ? value : internal;
  const set = (v) => {
    setInternal(v);
    onValueChange && onValueChange(v);
  };
  return (
    <div className={className} {...props}>
      <TabsCtx.Provider value={{ val, set }}>{children}</TabsCtx.Provider>
    </div>
  );
}
export function TabsList({ className = "", children }) {
  return (
    <div className={"ds-tabs-list " + className} role="tablist">
      {children}
    </div>
  );
}
export function TabsTrigger({ value, className = "", children }) {
  const ctx = React.useContext(TabsCtx) || {};
  return (
    <button
      type="button"
      role="tab"
      data-state={ctx.val === value ? "active" : "inactive"}
      className={"ds-tabs-trigger " + className}
      onClick={() => ctx.set && ctx.set(value)}
    >
      {children}
    </button>
  );
}
export function TabsContent({ value, className = "", children }) {
  const ctx = React.useContext(TabsCtx) || {};
  if (ctx.val !== value) return null;
  return (
    <div className={className} style={{ marginTop: 8 }}>
      {children}
    </div>
  );
}
