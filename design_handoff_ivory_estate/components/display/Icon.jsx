import * as React from "react";
let lucideLoading = null;
function ensureLucide(cb) {
  if (typeof window === "undefined") return;
  if (window.lucide) {
    cb();
    return;
  }
  if (!lucideLoading) {
    lucideLoading = new Promise((res) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/lucide@0.462.0/dist/umd/lucide.min.js";
      s.onload = res;
      document.head.appendChild(s);
    });
  }
  lucideLoading.then(cb);
}
const pascal = (n) =>
  String(n)
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
export function Icon({ name, size = 16, strokeWidth = 2, className = "", style }) {
  const [, force] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    if (!window.lucide) ensureLucide(force);
  }, []);
  const icons = (typeof window !== "undefined" && window.lucide && window.lucide.icons) || {};
  const data = icons[pascal(name)] || icons[name];
  const nodes = Array.isArray(data) ? (Array.isArray(data[2]) ? data[2] : data) : null;
  const kids = nodes
    ? nodes.map((node, i) => {
        const tag = node[0],
          attrs = node[1] || {};
        return React.createElement(tag, Object.assign({ key: i }, attrs));
      })
    : null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {kids}
    </svg>
  );
}
