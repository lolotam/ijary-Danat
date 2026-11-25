/* @ds-bundle: {"format":4,"namespace":"DanatAlMustaqbalDesignSystem_110f06","components":[{"name":"Alert","sourcePath":"components/display/Alert.jsx"},{"name":"AlertTitle","sourcePath":"components/display/Alert.jsx"},{"name":"AlertDescription","sourcePath":"components/display/Alert.jsx"},{"name":"Avatar","sourcePath":"components/display/Avatar.jsx"},{"name":"Badge","sourcePath":"components/display/Badge.jsx"},{"name":"Card","sourcePath":"components/display/Card.jsx"},{"name":"CardHeader","sourcePath":"components/display/Card.jsx"},{"name":"CardTitle","sourcePath":"components/display/Card.jsx"},{"name":"CardDescription","sourcePath":"components/display/Card.jsx"},{"name":"CardContent","sourcePath":"components/display/Card.jsx"},{"name":"CardFooter","sourcePath":"components/display/Card.jsx"},{"name":"Icon","sourcePath":"components/display/Icon.jsx"},{"name":"Logo","sourcePath":"components/display/Logo.jsx"},{"name":"Progress","sourcePath":"components/display/Progress.jsx"},{"name":"Separator","sourcePath":"components/display/Separator.jsx"},{"name":"Skeleton","sourcePath":"components/display/Skeleton.jsx"},{"name":"Table","sourcePath":"components/display/Table.jsx"},{"name":"TableHeader","sourcePath":"components/display/Table.jsx"},{"name":"TableBody","sourcePath":"components/display/Table.jsx"},{"name":"TableRow","sourcePath":"components/display/Table.jsx"},{"name":"TableHead","sourcePath":"components/display/Table.jsx"},{"name":"TableCell","sourcePath":"components/display/Table.jsx"},{"name":"Button","sourcePath":"components/forms/Button.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Label","sourcePath":"components/forms/Label.jsx"},{"name":"RadioGroup","sourcePath":"components/forms/RadioGroup.jsx"},{"name":"RadioGroupItem","sourcePath":"components/forms/RadioGroup.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Textarea","sourcePath":"components/forms/Textarea.jsx"},{"name":"Breadcrumb","sourcePath":"components/navigation/Breadcrumb.jsx"},{"name":"PortalNav","sourcePath":"components/navigation/PortalNav.jsx"},{"name":"SidebarNav","sourcePath":"components/navigation/SidebarNav.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"},{"name":"TabsList","sourcePath":"components/navigation/Tabs.jsx"},{"name":"TabsTrigger","sourcePath":"components/navigation/Tabs.jsx"},{"name":"TabsContent","sourcePath":"components/navigation/Tabs.jsx"},{"name":"Dialog","sourcePath":"components/overlay/Dialog.jsx"},{"name":"DialogHeader","sourcePath":"components/overlay/Dialog.jsx"},{"name":"DialogTitle","sourcePath":"components/overlay/Dialog.jsx"},{"name":"DialogDescription","sourcePath":"components/overlay/Dialog.jsx"},{"name":"DialogFooter","sourcePath":"components/overlay/Dialog.jsx"},{"name":"Tooltip","sourcePath":"components/overlay/Tooltip.jsx"}],"sourceHashes":{"components/display/Alert.jsx":"566f9d2affd9","components/display/Avatar.jsx":"f2b23adcf3ea","components/display/Badge.jsx":"b0ced121ca63","components/display/Card.jsx":"e3e639692ca7","components/display/Icon.jsx":"a54d60f167fa","components/display/Logo.jsx":"7530a0edd392","components/display/Progress.jsx":"184941336810","components/display/Separator.jsx":"b4bc958586e9","components/display/Skeleton.jsx":"4108f6ea3db8","components/display/Table.jsx":"633403cab4d6","components/forms/Button.jsx":"e35cd0ceb1cd","components/forms/Checkbox.jsx":"297fbe4a73c5","components/forms/Input.jsx":"69554a28d337","components/forms/Label.jsx":"62714979e279","components/forms/RadioGroup.jsx":"a8518733c641","components/forms/Select.jsx":"10db3a037802","components/forms/Switch.jsx":"7bdfd38bc9af","components/forms/Textarea.jsx":"6086359100d4","components/navigation/Breadcrumb.jsx":"539ea90068e4","components/navigation/PortalNav.jsx":"0f41c59d9454","components/navigation/SidebarNav.jsx":"8c6ca89b8601","components/navigation/Tabs.jsx":"2b01ffd6592e","components/overlay/Dialog.jsx":"b8532dbf99bf","components/overlay/Tooltip.jsx":"2cb6eb3305a2","ui_kits/admin/AdminScreens.jsx":"6ee93202587e","ui_kits/admin/AdminShell.jsx":"a896dc9be0b7","ui_kits/admin/data.js":"37348c10fc5f","ui_kits/auth/Auth.jsx":"056d50b5ef2e","ui_kits/landing/Landing.jsx":"408d7ad86e3b","ui_kits/landing/dict.js":"eae032990ac5","ui_kits/portal/Portal.jsx":"48fc7371c679"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {
  const __ds_ns = (window.DanatAlMustaqbalDesignSystem_110f06 =
    window.DanatAlMustaqbalDesignSystem_110f06 || {});

  const __ds_scope = {};

  __ds_ns.__errors = __ds_ns.__errors || [];

  // components/display/Alert.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-alert{position:relative;width:100%;border-radius:var(--radius-lg);border:1px solid var(--border);padding:12px 16px;font-size:0.875rem;box-sizing:border-box}\n.ds-alert--default{background:var(--background);color:var(--foreground)}\n.ds-alert--destructive{border-color:color-mix(in oklab,var(--destructive) 50%,transparent);color:var(--destructive)}\n.ds-alert--success{border-color:color-mix(in oklab,var(--success) 50%,transparent);color:var(--success);background:color-mix(in oklab,var(--success) 6%,transparent)}\n.ds-alert-title{margin:0 0 4px;font-weight:500;line-height:1}\n.ds-alert-desc{font-size:0.875rem;line-height:1.6}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-alert")) {
        const s = document.createElement("style");
        s.id = "ds-css-alert";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Alert({ variant = "default", className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              role: "alert",
              className: "ds-alert ds-alert--" + variant + " " + className,
            },
            props,
          ),
          children,
        );
      }
      function AlertTitle({ className = "", children }) {
        return /*#__PURE__*/ React.createElement(
          "h5",
          {
            className: "ds-alert-title " + className,
          },
          children,
        );
      }
      function AlertDescription({ className = "", children }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            className: "ds-alert-desc " + className,
          },
          children,
        );
      }
      Object.assign(__ds_scope, { Alert, AlertTitle, AlertDescription });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Alert.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Avatar.jsx
  try {
    (() => {
      const __css =
        "\n.ds-avatar{position:relative;display:flex;height:40px;width:40px;flex-shrink:0;overflow:hidden;border-radius:9999px}\n.ds-avatar img{aspect-ratio:1;height:100%;width:100%;object-fit:cover}\n.ds-avatar-fallback{display:flex;height:100%;width:100%;align-items:center;justify-content:center;border-radius:9999px;background:var(--muted);color:var(--muted-foreground);font:500 0.875rem/1 var(--font-sans)}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-avatar")) {
        const s = document.createElement("style");
        s.id = "ds-css-avatar";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Avatar({ src, fallback, size = 40, className = "" }) {
        const [err, setErr] = React.useState(false);
        return /*#__PURE__*/ React.createElement(
          "span",
          {
            className: "ds-avatar " + className,
            style: {
              height: size,
              width: size,
            },
          },
          src && !err
            ? /*#__PURE__*/ React.createElement("img", {
                src: src,
                alt: "",
                onError: () => setErr(true),
              })
            : /*#__PURE__*/ React.createElement(
                "span",
                {
                  className: "ds-avatar-fallback",
                },
                fallback,
              ),
        );
      }
      Object.assign(__ds_scope, { Avatar });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Avatar.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Badge.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-badge{display:inline-flex;align-items:center;border-radius:var(--radius-md);border:1px solid transparent;padding:2px 10px;font:600 0.75rem/1.3 var(--font-sans);transition:background-color .15s}\n.ds-badge--default{background:var(--primary);color:var(--primary-foreground);box-shadow:var(--shadow)}\n.ds-badge--secondary{background:var(--secondary);color:var(--secondary-foreground)}\n.ds-badge--destructive{background:var(--destructive);color:var(--destructive-foreground);box-shadow:var(--shadow)}\n.ds-badge--outline{border-color:var(--border);color:var(--foreground);background:transparent}\n.ds-badge--success{background:color-mix(in oklab,var(--success) 15%,transparent);color:var(--success);border-color:color-mix(in oklab,var(--success) 40%,transparent)}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-badge")) {
        const s = document.createElement("style");
        s.id = "ds-css-badge";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Badge({ variant = "default", className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "span",
          _extends(
            {
              className: "ds-badge ds-badge--" + variant + " " + className,
            },
            props,
          ),
          children,
        );
      }
      Object.assign(__ds_scope, { Badge });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Badge.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Card.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-card{border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--card);color:var(--card-foreground);box-shadow:var(--shadow)}\n.ds-card-header{display:flex;flex-direction:column;gap:6px;padding:24px}\n.ds-card-title{font:600 1rem/1 var(--font-sans);letter-spacing:-0.01em}\n.ds-card-desc{font-size:0.875rem;color:var(--muted-foreground)}\n.ds-card-content{padding:0 24px 24px}\n.ds-card-footer{display:flex;align-items:center;padding:0 24px 24px}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-card")) {
        const s = document.createElement("style");
        s.id = "ds-css-card";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Card({ className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className: "ds-card " + className,
            },
            props,
          ),
          children,
        );
      }
      function CardHeader({ className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className: "ds-card-header " + className,
            },
            props,
          ),
          children,
        );
      }
      function CardTitle({ className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className: "ds-card-title " + className,
            },
            props,
          ),
          children,
        );
      }
      function CardDescription({ className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className: "ds-card-desc " + className,
            },
            props,
          ),
          children,
        );
      }
      function CardContent({ className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className: "ds-card-content " + className,
            },
            props,
          ),
          children,
        );
      }
      function CardFooter({ className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className: "ds-card-footer " + className,
            },
            props,
          ),
          children,
        );
      }
      Object.assign(__ds_scope, {
        Card,
        CardHeader,
        CardTitle,
        CardDescription,
        CardContent,
        CardFooter,
      });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Card.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Icon.jsx
  try {
    (() => {
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
      function Icon({ name, size = 16, strokeWidth = 2, className = "", style }) {
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
              return React.createElement(
                tag,
                Object.assign(
                  {
                    key: i,
                  },
                  attrs,
                ),
              );
            })
          : null;
        return /*#__PURE__*/ React.createElement(
          "svg",
          {
            width: size,
            height: size,
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: strokeWidth,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            className: className,
            style: style,
            "aria-hidden": "true",
          },
          kids,
        );
      }
      Object.assign(__ds_scope, { Icon });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Icon.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Logo.jsx
  try {
    (() => {
      const __css =
        "\n.ds-logo{display:flex;align-items:center;gap:12px}\n.ds-logo-tile{display:grid;place-items:center;border-radius:var(--radius-md);background:var(--ink);color:var(--accent);font-weight:700;font-family:var(--font-sans);overflow:hidden;flex-shrink:0}\n.ds-logo-tile img{width:100%;height:100%;object-fit:cover;display:block}\n.ds-logo-name{font:600 0.875rem/1.2 var(--font-sans);color:var(--foreground)}\n.ds-logo-sub{font:400 0.6875rem/1.2 var(--font-sans);color:var(--gold-deep);letter-spacing:0.08em}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-logo")) {
        const s = document.createElement("style");
        s.id = "ds-css-logo";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Logo({
        size = 44,
        src,
        name = "دانة المستقبل العقارية",
        subName = "DANAT AL MUSTAQBAL",
        showName = true,
        onDark,
      }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            className: "ds-logo",
          },
          /*#__PURE__*/ React.createElement(
            "div",
            {
              className: "ds-logo-tile",
              style: {
                height: size,
                width: size,
                fontSize: size * 0.44,
                borderRadius: Math.round(size * 0.23),
              },
            },
            src
              ? /*#__PURE__*/ React.createElement("img", {
                  src: src,
                  alt: "",
                })
              : "د",
          ),
          showName &&
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  lineHeight: 1.25,
                },
              },
              /*#__PURE__*/ React.createElement(
                "span",
                {
                  className: "ds-logo-name",
                  style: onDark
                    ? {
                        color: "var(--ink-foreground)",
                      }
                    : null,
                },
                name,
              ),
              subName &&
                /*#__PURE__*/ React.createElement(
                  "span",
                  {
                    className: "ds-logo-sub",
                  },
                  subName,
                ),
            ),
        );
      }
      Object.assign(__ds_scope, { Logo });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Logo.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Progress.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-progress{position:relative;height:8px;width:100%;overflow:hidden;border-radius:9999px;background:color-mix(in oklab,var(--primary) 20%,transparent)}\n.ds-progress-bar{height:100%;background:var(--primary);transition:width .3s;border-radius:9999px}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-progress")) {
        const s = document.createElement("style");
        s.id = "ds-css-progress";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Progress({ value = 0, className = "", ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className: "ds-progress " + className,
              role: "progressbar",
              "aria-valuenow": value,
            },
            props,
          ),
          /*#__PURE__*/ React.createElement("div", {
            className: "ds-progress-bar",
            style: {
              width: (value || 0) + "%",
            },
          }),
        );
      }
      Object.assign(__ds_scope, { Progress });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Progress.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Separator.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-separator{flex-shrink:0;background:var(--border)}\n.ds-separator--h{height:1px;width:100%}\n.ds-separator--v{height:100%;width:1px}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-separator")) {
        const s = document.createElement("style");
        s.id = "ds-css-separator";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Separator({ orientation = "horizontal", className = "", ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className:
                "ds-separator ds-separator--" +
                (orientation === "horizontal" ? "h" : "v") +
                " " +
                className,
            },
            props,
          ),
        );
      }
      Object.assign(__ds_scope, { Separator });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Separator.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Skeleton.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n@keyframes ds-pulse{50%{opacity:.5}}\n.ds-skeleton{animation:ds-pulse 2s cubic-bezier(.4,0,.6,1) infinite;border-radius:var(--radius-md);background:color-mix(in oklab,var(--primary) 10%,transparent)}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-skeleton")) {
        const s = document.createElement("style");
        s.id = "ds-css-skeleton";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Skeleton({ className = "", style, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className: "ds-skeleton " + className,
              style: style,
            },
            props,
          ),
        );
      }
      Object.assign(__ds_scope, { Skeleton });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Skeleton.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Table.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-table-wrap{position:relative;width:100%;overflow:auto}\n.ds-table{width:100%;caption-side:bottom;font-size:0.875rem;border-collapse:collapse}\n.ds-table thead tr{border-bottom:1px solid var(--border)}\n.ds-table tbody tr{border-bottom:1px solid var(--border);transition:background-color .15s}\n.ds-table tbody tr:last-child{border-bottom:0}\n.ds-table tbody tr:hover{background:color-mix(in oklab,var(--muted) 50%,transparent)}\n.ds-table th{height:40px;padding:0 8px;text-align:start;vertical-align:middle;font-weight:500;color:var(--muted-foreground)}\n.ds-table td{padding:8px;vertical-align:middle}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-table")) {
        const s = document.createElement("style");
        s.id = "ds-css-table";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Table({ className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            className: "ds-table-wrap",
          },
          /*#__PURE__*/ React.createElement(
            "table",
            _extends(
              {
                className: "ds-table " + className,
              },
              props,
            ),
            children,
          ),
        );
      }
      function TableHeader(props) {
        return /*#__PURE__*/ React.createElement("thead", props);
      }
      function TableBody(props) {
        return /*#__PURE__*/ React.createElement("tbody", props);
      }
      function TableRow(props) {
        return /*#__PURE__*/ React.createElement("tr", props);
      }
      function TableHead(props) {
        return /*#__PURE__*/ React.createElement("th", props);
      }
      function TableCell(props) {
        return /*#__PURE__*/ React.createElement("td", props);
      }
      Object.assign(__ds_scope, { Table, TableHeader, TableBody, TableRow, TableHead, TableCell });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Table.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Button.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;border-radius:9999px;font:500 0.875rem/1.25rem var(--font-sans);cursor:pointer;transition:background-color .15s,color .15s;border:1px solid transparent;outline:none}\n.ds-btn:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-btn:disabled{pointer-events:none;opacity:.5;cursor:not-allowed}\n.ds-btn svg{width:16px;height:16px;flex-shrink:0;pointer-events:none}\n.ds-btn--default{background:var(--primary);color:var(--primary-foreground);box-shadow:var(--shadow)}\n.ds-btn--default:hover{background:color-mix(in oklab,var(--primary) 90%,transparent)}\n.ds-btn--destructive{background:var(--destructive);color:var(--destructive-foreground);box-shadow:var(--shadow-sm)}\n.ds-btn--destructive:hover{background:color-mix(in oklab,var(--destructive) 90%,transparent)}\n.ds-btn--outline{border-width:1.5px;border-color:var(--foreground);background:var(--background);color:var(--foreground);box-shadow:var(--shadow-sm)}\n.ds-btn--outline:hover{background:var(--accent);color:var(--accent-foreground)}\n.ds-btn--secondary{background:var(--secondary);color:var(--secondary-foreground);box-shadow:var(--shadow-sm)}\n.ds-btn--secondary:hover{background:color-mix(in oklab,var(--secondary) 80%,transparent)}\n.ds-btn--ghost{background:transparent;color:var(--foreground)}\n.ds-btn--ghost:hover{background:var(--accent);color:var(--accent-foreground)}\n.ds-btn--gold{background:var(--accent);color:var(--accent-foreground);box-shadow:var(--shadow);font-weight:600}\n.ds-btn--gold:hover{background:color-mix(in oklab,var(--accent) 88%,#fff)}\n.ds-btn--link{background:transparent;color:var(--primary);text-underline-offset:4px}\n.ds-btn--link:hover{text-decoration:underline}\n.ds-btn--size-default{height:38px;padding:8px 20px}\n.ds-btn--size-sm{height:32px;padding:0 12px;font-size:0.75rem}\n.ds-btn--size-lg{height:48px;padding:0 34px;font-size:0.9375rem}\n.ds-btn--size-icon{height:36px;width:36px;padding:0}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-button")) {
        const s = document.createElement("style");
        s.id = "ds-css-button";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Button({
        variant = "default",
        size = "default",
        className = "",
        children,
        ...props
      }) {
        return /*#__PURE__*/ React.createElement(
          "button",
          _extends(
            {
              className: "ds-btn ds-btn--" + variant + " ds-btn--size-" + size + " " + className,
            },
            props,
          ),
          children,
        );
      }
      Object.assign(__ds_scope, { Button });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Button.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Checkbox.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-checkbox{display:grid;place-content:center;height:16px;width:16px;flex-shrink:0;border-radius:var(--radius-sm);border:1px solid var(--primary);background:transparent;box-shadow:var(--shadow);cursor:pointer;padding:0;outline:none}\n.ds-checkbox:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-checkbox[data-state=checked]{background:var(--primary);color:var(--primary-foreground)}\n.ds-checkbox:disabled{cursor:not-allowed;opacity:.5}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-checkbox")) {
        const s = document.createElement("style");
        s.id = "ds-css-checkbox";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Checkbox({
        checked,
        defaultChecked = false,
        onCheckedChange,
        className = "",
        ...props
      }) {
        const [internal, setInternal] = React.useState(defaultChecked);
        const isChecked = checked !== undefined ? checked : internal;
        return /*#__PURE__*/ React.createElement(
          "button",
          _extends(
            {
              type: "button",
              role: "checkbox",
              "aria-checked": isChecked,
              "data-state": isChecked ? "checked" : "unchecked",
              className: "ds-checkbox " + className,
              onClick: () => {
                const n = !isChecked;
                setInternal(n);
                onCheckedChange && onCheckedChange(n);
              },
            },
            props,
          ),
          isChecked &&
            /*#__PURE__*/ React.createElement(
              "svg",
              {
                width: "14",
                height: "14",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: "2",
                strokeLinecap: "round",
                strokeLinejoin: "round",
              },
              /*#__PURE__*/ React.createElement("path", {
                d: "M20 6 9 17l-5-5",
              }),
            ),
        );
      }
      Object.assign(__ds_scope, { Checkbox });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Checkbox.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Input.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-input{display:flex;height:36px;width:100%;border-radius:var(--radius-md);border:1px solid var(--input);background:transparent;padding:4px 12px;font:400 0.875rem/1.25rem var(--font-sans);color:var(--foreground);box-shadow:var(--shadow-sm);transition:border-color .15s,box-shadow .15s;outline:none;box-sizing:border-box}\n.ds-input::placeholder{color:var(--muted-foreground)}\n.ds-input:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-input:disabled{cursor:not-allowed;opacity:.5}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-input")) {
        const s = document.createElement("style");
        s.id = "ds-css-input";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Input({ className = "", ...props }) {
        return /*#__PURE__*/ React.createElement(
          "input",
          _extends(
            {
              className: "ds-input " + className,
            },
            props,
          ),
        );
      }
      Object.assign(__ds_scope, { Input });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Input.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Label.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-label{font:500 0.875rem/1 var(--font-sans);color:var(--foreground);display:inline-block}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-label")) {
        const s = document.createElement("style");
        s.id = "ds-css-label";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Label({ className = "", children, ...props }) {
        return /*#__PURE__*/ React.createElement(
          "label",
          _extends(
            {
              className: "ds-label " + className,
            },
            props,
          ),
          children,
        );
      }
      Object.assign(__ds_scope, { Label });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Label.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/RadioGroup.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-radio-group{display:grid;gap:8px}\n.ds-radio{aspect-ratio:1;height:16px;width:16px;border-radius:9999px;border:1px solid var(--primary);color:var(--primary);box-shadow:var(--shadow);cursor:pointer;background:transparent;padding:0;display:grid;place-content:center;outline:none}\n.ds-radio:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-radio:disabled{cursor:not-allowed;opacity:.5}\n.ds-radio-dot{width:9px;height:9px;border-radius:9999px;background:var(--primary)}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-radio")) {
        const s = document.createElement("style");
        s.id = "ds-css-radio";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      const RadioCtx = React.createContext(null);
      function RadioGroup({
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
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              role: "radiogroup",
              className: "ds-radio-group " + className,
            },
            props,
          ),
          /*#__PURE__*/ React.createElement(
            RadioCtx.Provider,
            {
              value: {
                val,
                set,
              },
            },
            children,
          ),
        );
      }
      function RadioGroupItem({ value, className = "", ...props }) {
        const ctx = React.useContext(RadioCtx) || {};
        const checked = ctx.val === value;
        return /*#__PURE__*/ React.createElement(
          "button",
          _extends(
            {
              type: "button",
              role: "radio",
              "aria-checked": checked,
              className: "ds-radio " + className,
              onClick: () => ctx.set && ctx.set(value),
            },
            props,
          ),
          checked &&
            /*#__PURE__*/ React.createElement("span", {
              className: "ds-radio-dot",
            }),
        );
      }
      Object.assign(__ds_scope, { RadioGroup, RadioGroupItem });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/RadioGroup.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Select.jsx
  try {
    (() => {
      const __css =
        "\n.ds-select{position:relative;display:inline-block;width:100%}\n.ds-select-trigger{display:flex;height:36px;width:100%;align-items:center;justify-content:space-between;white-space:nowrap;border-radius:var(--radius-md);border:1px solid var(--input);background:transparent;padding:8px 12px;font:400 0.875rem/1.25rem var(--font-sans);color:var(--foreground);box-shadow:var(--shadow-sm);cursor:pointer;outline:none;box-sizing:border-box;gap:8px}\n.ds-select-trigger:focus{box-shadow:0 0 0 1px var(--ring)}\n.ds-select-trigger[data-placeholder=true]{color:var(--muted-foreground)}\n.ds-select-content{position:absolute;top:calc(100% + 4px);inset-inline-start:0;z-index:50;min-width:8rem;width:100%;overflow:hidden;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--popover);color:var(--popover-foreground);box-shadow:var(--shadow-md);padding:4px;box-sizing:border-box}\n.ds-select-item{position:relative;display:flex;width:100%;cursor:default;user-select:none;align-items:center;border-radius:var(--radius-sm);padding:6px 32px 6px 8px;font-size:0.875rem;outline:none;box-sizing:border-box}\n[dir=rtl] .ds-select-item{padding:6px 8px 6px 32px}\n.ds-select-item:hover{background:var(--accent);color:var(--accent-foreground)}\n.ds-select-check{position:absolute;inset-inline-end:8px;display:flex;height:14px;width:14px;align-items:center;justify-content:center}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-select")) {
        const s = document.createElement("style");
        s.id = "ds-css-select";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Select({
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
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            className: "ds-select " + className,
            ref: ref,
          },
          /*#__PURE__*/ React.createElement(
            "button",
            {
              type: "button",
              disabled: disabled,
              className: "ds-select-trigger",
              "data-placeholder": !selected,
              onClick: () => setOpen(!open),
            },
            /*#__PURE__*/ React.createElement(
              "span",
              null,
              selected ? selected.label : placeholder,
            ),
            /*#__PURE__*/ React.createElement(
              "svg",
              {
                width: "16",
                height: "16",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: "2",
                strokeLinecap: "round",
                strokeLinejoin: "round",
                style: {
                  opacity: 0.5,
                },
              },
              /*#__PURE__*/ React.createElement("path", {
                d: "m6 9 6 6 6-6",
              }),
            ),
          ),
          open &&
            /*#__PURE__*/ React.createElement(
              "div",
              {
                className: "ds-select-content",
                role: "listbox",
              },
              options.map((o) =>
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    key: o.value,
                    className: "ds-select-item",
                    role: "option",
                    "aria-selected": o.value === val,
                    onClick: () => {
                      setInternal(o.value);
                      onValueChange && onValueChange(o.value);
                      setOpen(false);
                    },
                  },
                  o.value === val &&
                    /*#__PURE__*/ React.createElement(
                      "span",
                      {
                        className: "ds-select-check",
                      },
                      /*#__PURE__*/ React.createElement(
                        "svg",
                        {
                          width: "14",
                          height: "14",
                          viewBox: "0 0 24 24",
                          fill: "none",
                          stroke: "currentColor",
                          strokeWidth: "2",
                          strokeLinecap: "round",
                          strokeLinejoin: "round",
                        },
                        /*#__PURE__*/ React.createElement("path", {
                          d: "M20 6 9 17l-5-5",
                        }),
                      ),
                    ),
                  o.label,
                ),
              ),
            ),
        );
      }
      Object.assign(__ds_scope, { Select });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Select.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Switch.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-switch{display:inline-flex;height:20px;width:36px;flex-shrink:0;cursor:pointer;align-items:center;border-radius:9999px;border:2px solid transparent;box-shadow:var(--shadow-sm);transition:background-color .15s;padding:0;outline:none}\n.ds-switch:focus-visible{box-shadow:0 0 0 2px var(--ring)}\n.ds-switch[data-state=checked]{background:var(--primary)}\n.ds-switch[data-state=unchecked]{background:var(--input)}\n.ds-switch:disabled{cursor:not-allowed;opacity:.5}\n.ds-switch-thumb{pointer-events:none;display:block;height:16px;width:16px;border-radius:9999px;background:var(--background);box-shadow:var(--shadow-lg);transition:transform .15s;transform:translateX(0)}\n.ds-switch[data-state=checked] .ds-switch-thumb{transform:translateX(16px)}\n[dir=rtl] .ds-switch[data-state=checked] .ds-switch-thumb{transform:translateX(-16px)}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-switch")) {
        const s = document.createElement("style");
        s.id = "ds-css-switch";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Switch({
        checked,
        defaultChecked = false,
        onCheckedChange,
        className = "",
        ...props
      }) {
        const [internal, setInternal] = React.useState(defaultChecked);
        const isChecked = checked !== undefined ? checked : internal;
        return /*#__PURE__*/ React.createElement(
          "button",
          _extends(
            {
              type: "button",
              role: "switch",
              "aria-checked": isChecked,
              "data-state": isChecked ? "checked" : "unchecked",
              className: "ds-switch " + className,
              onClick: () => {
                const n = !isChecked;
                setInternal(n);
                onCheckedChange && onCheckedChange(n);
              },
            },
            props,
          ),
          /*#__PURE__*/ React.createElement("span", {
            className: "ds-switch-thumb",
          }),
        );
      }
      Object.assign(__ds_scope, { Switch });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Switch.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Textarea.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-textarea{display:flex;min-height:60px;width:100%;border-radius:var(--radius-md);border:1px solid var(--input);background:transparent;padding:8px 12px;font:400 0.875rem/1.25rem var(--font-sans);color:var(--foreground);box-shadow:var(--shadow-sm);outline:none;box-sizing:border-box;resize:vertical}\n.ds-textarea::placeholder{color:var(--muted-foreground)}\n.ds-textarea:focus-visible{box-shadow:0 0 0 1px var(--ring)}\n.ds-textarea:disabled{cursor:not-allowed;opacity:.5}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-textarea")) {
        const s = document.createElement("style");
        s.id = "ds-css-textarea";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Textarea({ className = "", ...props }) {
        return /*#__PURE__*/ React.createElement(
          "textarea",
          _extends(
            {
              className: "ds-textarea " + className,
            },
            props,
          ),
        );
      }
      Object.assign(__ds_scope, { Textarea });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Textarea.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/navigation/Breadcrumb.jsx
  try {
    (() => {
      const __css =
        "\n.ds-breadcrumb{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:0.875rem;color:var(--muted-foreground);list-style:none;margin:0;padding:0}\n.ds-breadcrumb li{display:inline-flex;align-items:center;gap:6px}\n.ds-breadcrumb a{color:inherit;text-decoration:none;transition:color .15s}\n.ds-breadcrumb a:hover{color:var(--foreground)}\n.ds-breadcrumb .ds-breadcrumb-page{color:var(--foreground)}\n[dir=rtl] .ds-breadcrumb svg{transform:scaleX(-1)}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-breadcrumb")) {
        const s = document.createElement("style");
        s.id = "ds-css-breadcrumb";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Breadcrumb({ items = [], className = "" }) {
        return /*#__PURE__*/ React.createElement(
          "nav",
          {
            "aria-label": "breadcrumb",
          },
          /*#__PURE__*/ React.createElement(
            "ol",
            {
              className: "ds-breadcrumb " + className,
            },
            items.map((it, i) =>
              /*#__PURE__*/ React.createElement(
                React.Fragment,
                {
                  key: i,
                },
                /*#__PURE__*/ React.createElement(
                  "li",
                  null,
                  i < items.length - 1
                    ? /*#__PURE__*/ React.createElement(
                        "a",
                        {
                          href: it.href || "#",
                        },
                        it.label,
                      )
                    : /*#__PURE__*/ React.createElement(
                        "span",
                        {
                          className: "ds-breadcrumb-page",
                          "aria-current": "page",
                        },
                        it.label,
                      ),
                ),
                i < items.length - 1 &&
                  /*#__PURE__*/ React.createElement(
                    "li",
                    {
                      "aria-hidden": "true",
                    },
                    /*#__PURE__*/ React.createElement(
                      "svg",
                      {
                        width: "14",
                        height: "14",
                        viewBox: "0 0 24 24",
                        fill: "none",
                        stroke: "currentColor",
                        strokeWidth: "2",
                        strokeLinecap: "round",
                        strokeLinejoin: "round",
                      },
                      /*#__PURE__*/ React.createElement("path", {
                        d: "m9 18 6-6-6-6",
                      }),
                    ),
                  ),
              ),
            ),
          ),
        );
      }
      Object.assign(__ds_scope, { Breadcrumb });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/navigation/Breadcrumb.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/navigation/PortalNav.jsx
  try {
    (() => {
      const __css =
        "\n.ds-portalnav{display:flex;gap:4px;overflow-x:auto;padding:0}\n.ds-portalnav-link{display:flex;flex-shrink:0;align-items:center;gap:8px;border-radius:var(--radius-lg);padding:8px 12px;font:500 0.75rem/1.3 var(--font-sans);color:var(--muted-foreground);text-decoration:none;transition:background-color .15s,color .15s}\n.ds-portalnav-link:hover{background:var(--muted);color:var(--foreground)}\n.ds-portalnav-link[data-active=true]{background:var(--primary);color:var(--primary-foreground)}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-portalnav")) {
        const s = document.createElement("style");
        s.id = "ds-css-portalnav";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function PortalNav({ items, activeKey, onNavigate, className = "" }) {
        const defaults = [
          {
            key: "dashboard",
            label: "لوحتي",
            icon: "home",
          },
          {
            key: "lease",
            label: "عقدي",
            icon: "building-2",
          },
          {
            key: "invoices",
            label: "فواتيري",
            icon: "file-text",
          },
          {
            key: "payments",
            label: "مدفوعاتي",
            icon: "credit-card",
          },
          {
            key: "receipts",
            label: "إيصالاتي",
            icon: "receipt-text",
          },
          {
            key: "profile",
            label: "الملف الشخصي",
            icon: "user-round",
          },
        ];
        const list = items || defaults;
        return /*#__PURE__*/ React.createElement(
          "nav",
          {
            className: "ds-portalnav " + className,
          },
          list.map((it) =>
            /*#__PURE__*/ React.createElement(
              "a",
              {
                key: it.key,
                href: "#",
                className: "ds-portalnav-link",
                "data-active": activeKey === it.key,
                onClick: (e) => {
                  e.preventDefault();
                  onNavigate && onNavigate(it.key);
                },
              },
              /*#__PURE__*/ React.createElement(__ds_scope.Icon, {
                name: it.icon,
                size: 16,
              }),
              it.label,
            ),
          ),
        );
      }
      Object.assign(__ds_scope, { PortalNav });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/navigation/PortalNav.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/navigation/SidebarNav.jsx
  try {
    (() => {
      const __css =
        "\n.ds-sidebar{display:flex;flex-direction:column;gap:8px;width:256px;min-height:100%;background:var(--sidebar);color:var(--sidebar-foreground);border-inline-end:1px solid var(--sidebar-border);padding:8px;box-sizing:border-box}\n.ds-sidebar-label{padding:8px;font:500 0.75rem/1 var(--font-sans);color:color-mix(in oklab,var(--sidebar-foreground) 70%,transparent)}\n.ds-sidebar-menu{display:flex;flex-direction:column;gap:4px;list-style:none;margin:0;padding:0}\n.ds-sidebar-btn{display:flex;width:100%;align-items:center;gap:8px;border-radius:var(--radius-md);padding:8px;font:400 0.875rem/1.25rem var(--font-sans);color:inherit;text-decoration:none;transition:background-color .15s;box-sizing:border-box}\n.ds-sidebar-btn:hover{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground)}\n.ds-sidebar-btn[data-active=true]{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground);font-weight:500}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-sidebarnav")) {
        const s = document.createElement("style");
        s.id = "ds-css-sidebarnav";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function SidebarNav({ groups, activeKey, onNavigate, className = "" }) {
        const defaultGroups = [
          {
            label: "لوحة التحكم",
            items: [
              {
                key: "dashboard",
                label: "لوحة التحكم",
                icon: "layout-dashboard",
              },
              {
                key: "invoices",
                label: "فواتير الإيجار",
                icon: "file-text",
              },
              {
                key: "tenants",
                label: "المستأجرون",
                icon: "users",
              },
              {
                key: "properties",
                label: "العقارات والمباني",
                icon: "building-2",
              },
              {
                key: "units",
                label: "الوحدات",
                icon: "home",
              },
              {
                key: "contracts",
                label: "العقود",
                icon: "scroll-text",
              },
              {
                key: "payments",
                label: "المدفوعات",
                icon: "credit-card",
              },
              {
                key: "deposits",
                label: "الإيداعات البنكية",
                icon: "banknote",
              },
              {
                key: "expenses",
                label: "المصروفات",
                icon: "receipt",
              },
              {
                key: "electricity",
                label: "الكهرباء",
                icon: "zap",
              },
            ],
          },
          {
            label: "إعدادات الشركة والنظام",
            items: [
              {
                key: "reports",
                label: "التقارير",
                icon: "bar-chart-3",
              },
              {
                key: "audit",
                label: "سجل التدقيق",
                icon: "shield-check",
              },
              {
                key: "settings",
                label: "إعدادات الشركة والنظام",
                icon: "settings",
              },
            ],
          },
        ];
        const gs = groups || defaultGroups;
        return /*#__PURE__*/ React.createElement(
          "nav",
          {
            className: "ds-sidebar " + className,
          },
          gs.map((g, gi) =>
            /*#__PURE__*/ React.createElement(
              "div",
              {
                key: gi,
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  className: "ds-sidebar-label",
                },
                g.label,
              ),
              /*#__PURE__*/ React.createElement(
                "ul",
                {
                  className: "ds-sidebar-menu",
                },
                g.items.map((it) =>
                  /*#__PURE__*/ React.createElement(
                    "li",
                    {
                      key: it.key,
                    },
                    /*#__PURE__*/ React.createElement(
                      "a",
                      {
                        href: "#",
                        className: "ds-sidebar-btn",
                        "data-active": activeKey === it.key,
                        onClick: (e) => {
                          e.preventDefault();
                          onNavigate && onNavigate(it.key);
                        },
                      },
                      /*#__PURE__*/ React.createElement(__ds_scope.Icon, {
                        name: it.icon,
                        size: 16,
                      }),
                      /*#__PURE__*/ React.createElement("span", null, it.label),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      }
      Object.assign(__ds_scope, { SidebarNav });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/navigation/SidebarNav.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/navigation/Tabs.jsx
  try {
    (() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e];
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
                }
                return n;
              }),
          _extends.apply(null, arguments)
        );
      }
      const __css =
        "\n.ds-tabs-list{display:inline-flex;height:36px;align-items:center;justify-content:center;border-radius:var(--radius-lg);background:var(--muted);padding:4px;color:var(--muted-foreground);box-sizing:border-box}\n.ds-tabs-trigger{display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;border-radius:var(--radius-md);padding:4px 12px;font:500 0.875rem/1.25rem var(--font-sans);cursor:pointer;transition:all .15s;border:none;background:transparent;color:inherit;outline:none}\n.ds-tabs-trigger[data-state=active]{background:var(--background);color:var(--foreground);box-shadow:var(--shadow)}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-tabs")) {
        const s = document.createElement("style");
        s.id = "ds-css-tabs";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      const TabsCtx = React.createContext(null);
      function Tabs({ value, defaultValue, onValueChange, children, className = "", ...props }) {
        const [internal, setInternal] = React.useState(defaultValue);
        const val = value !== undefined ? value : internal;
        const set = (v) => {
          setInternal(v);
          onValueChange && onValueChange(v);
        };
        return /*#__PURE__*/ React.createElement(
          "div",
          _extends(
            {
              className: className,
            },
            props,
          ),
          /*#__PURE__*/ React.createElement(
            TabsCtx.Provider,
            {
              value: {
                val,
                set,
              },
            },
            children,
          ),
        );
      }
      function TabsList({ className = "", children }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            className: "ds-tabs-list " + className,
            role: "tablist",
          },
          children,
        );
      }
      function TabsTrigger({ value, className = "", children }) {
        const ctx = React.useContext(TabsCtx) || {};
        return /*#__PURE__*/ React.createElement(
          "button",
          {
            type: "button",
            role: "tab",
            "data-state": ctx.val === value ? "active" : "inactive",
            className: "ds-tabs-trigger " + className,
            onClick: () => ctx.set && ctx.set(value),
          },
          children,
        );
      }
      function TabsContent({ value, className = "", children }) {
        const ctx = React.useContext(TabsCtx) || {};
        if (ctx.val !== value) return null;
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            className: className,
            style: {
              marginTop: 8,
            },
          },
          children,
        );
      }
      Object.assign(__ds_scope, { Tabs, TabsList, TabsTrigger, TabsContent });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/navigation/Tabs.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/overlay/Dialog.jsx
  try {
    (() => {
      const __css =
        "\n.ds-dialog-overlay{position:fixed;inset:0;z-index:50;background:rgb(0 0 0 / 0.8)}\n.ds-dialog{position:fixed;left:50%;top:50%;z-index:50;display:grid;width:100%;max-width:32rem;transform:translate(-50%,-50%);gap:16px;border:1px solid var(--border);background:var(--background);padding:24px;box-shadow:var(--shadow-lg);border-radius:var(--radius-lg);box-sizing:border-box}\n.ds-dialog-close{position:absolute;inset-inline-end:16px;top:16px;border-radius:var(--radius-sm);opacity:.7;cursor:pointer;background:none;border:none;padding:2px;color:var(--foreground);transition:opacity .15s}\n.ds-dialog-close:hover{opacity:1}\n.ds-dialog-header{display:flex;flex-direction:column;gap:6px}\n.ds-dialog-title{font:600 1.125rem/1 var(--font-sans);letter-spacing:-0.01em;margin:0}\n.ds-dialog-desc{font-size:0.875rem;color:var(--muted-foreground);margin:0}\n.ds-dialog-footer{display:flex;justify-content:flex-end;gap:8px}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-dialog")) {
        const s = document.createElement("style");
        s.id = "ds-css-dialog";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Dialog({ open, onOpenChange, children }) {
        if (!open) return null;
        return /*#__PURE__*/ React.createElement(
          "div",
          null,
          /*#__PURE__*/ React.createElement("div", {
            className: "ds-dialog-overlay",
            onClick: () => onOpenChange && onOpenChange(false),
          }),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              className: "ds-dialog",
              role: "dialog",
              "aria-modal": "true",
            },
            children,
            /*#__PURE__*/ React.createElement(
              "button",
              {
                type: "button",
                className: "ds-dialog-close",
                "aria-label": "Close",
                onClick: () => onOpenChange && onOpenChange(false),
              },
              /*#__PURE__*/ React.createElement(
                "svg",
                {
                  width: "16",
                  height: "16",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                },
                /*#__PURE__*/ React.createElement("path", {
                  d: "M18 6 6 18",
                }),
                /*#__PURE__*/ React.createElement("path", {
                  d: "m6 6 12 12",
                }),
              ),
            ),
          ),
        );
      }
      function DialogHeader({ children, className = "" }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            className: "ds-dialog-header " + className,
          },
          children,
        );
      }
      function DialogTitle({ children, className = "" }) {
        return /*#__PURE__*/ React.createElement(
          "h2",
          {
            className: "ds-dialog-title " + className,
          },
          children,
        );
      }
      function DialogDescription({ children, className = "" }) {
        return /*#__PURE__*/ React.createElement(
          "p",
          {
            className: "ds-dialog-desc " + className,
          },
          children,
        );
      }
      function DialogFooter({ children, className = "" }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            className: "ds-dialog-footer " + className,
          },
          children,
        );
      }
      Object.assign(__ds_scope, {
        Dialog,
        DialogHeader,
        DialogTitle,
        DialogDescription,
        DialogFooter,
      });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/overlay/Dialog.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/overlay/Tooltip.jsx
  try {
    (() => {
      const __css =
        "\n.ds-tooltip-wrap{position:relative;display:inline-flex}\n.ds-tooltip{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);z-index:50;overflow:hidden;border-radius:var(--radius-md);background:var(--primary);color:var(--primary-foreground);padding:6px 12px;font-size:0.75rem;white-space:nowrap;pointer-events:none}\n";
      if (typeof document !== "undefined" && !document.getElementById("ds-css-tooltip")) {
        const s = document.createElement("style");
        s.id = "ds-css-tooltip";
        s.textContent = __css;
        document.head.appendChild(s);
      }
      function Tooltip({ content, children }) {
        const [show, setShow] = React.useState(false);
        return /*#__PURE__*/ React.createElement(
          "span",
          {
            className: "ds-tooltip-wrap",
            onMouseEnter: () => setShow(true),
            onMouseLeave: () => setShow(false),
          },
          children,
          show &&
            /*#__PURE__*/ React.createElement(
              "span",
              {
                className: "ds-tooltip",
                role: "tooltip",
              },
              content,
            ),
        );
      }
      Object.assign(__ds_scope, { Tooltip });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/overlay/Tooltip.jsx",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/admin/AdminScreens.jsx
  try {
    (() => {
      const {
        Card,
        Badge,
        Button,
        Input,
        Label,
        Select,
        Table,
        TableHeader,
        TableBody,
        TableRow,
        TableHead,
        TableCell,
        Dialog,
        DialogHeader,
        DialogTitle,
        DialogDescription,
        DialogFooter,
        Icon,
      } = window.DanatAlMustaqbalDesignSystem_110f06;
      function StatusBadge({ s }) {
        return s === "paid"
          ? /*#__PURE__*/ React.createElement(
              Badge,
              {
                variant: "success",
              },
              "\u0645\u062F\u0641\u0648\u0639\u0629",
            )
          : s === "overdue"
            ? /*#__PURE__*/ React.createElement(
                Badge,
                {
                  variant: "destructive",
                },
                "\u0645\u062A\u0623\u062E\u0631\u0629",
              )
            : /*#__PURE__*/ React.createElement(
                Badge,
                {
                  variant: "secondary",
                },
                "\u0642\u064A\u062F \u0627\u0644\u0633\u062F\u0627\u062F",
              );
      }
      function AdminDashboard() {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            style: {
              display: "grid",
              gap: 32,
            },
          },
          /*#__PURE__*/ React.createElement(
            "div",
            null,
            /*#__PURE__*/ React.createElement(
              "h1",
              {
                style: {
                  fontSize: 24,
                  fontWeight: 700,
                  margin: 0,
                },
              },
              "\u0644\u0648\u062D\u0629 \u0627\u0644\u062A\u062D\u0643\u0645",
            ),
            /*#__PURE__*/ React.createElement(
              "p",
              {
                style: {
                  margin: "4px 0 0",
                  fontSize: 14,
                  color: "var(--muted-foreground)",
                },
              },
              "\u0646\u0638\u0631\u0629 \u0639\u0627\u0645\u0629 \u0639\u0644\u0649 \u0627\u0644\u0645\u0624\u0634\u0631\u0627\u062A \u0627\u0644\u0631\u0626\u064A\u0633\u064A\u0629.",
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(4,1fr)",
              },
            },
            window.adminData.stats.map((c) =>
              /*#__PURE__*/ React.createElement(
                Card,
                {
                  key: c.label,
                  style: {
                    padding: 20,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      fontSize: 12,
                      color: "var(--muted-foreground)",
                    },
                  },
                  c.label,
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      marginTop: 8,
                      fontSize: 30,
                      fontWeight: 700,
                    },
                  },
                  c.value,
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      marginTop: 4,
                      fontSize: 11,
                      color: "var(--muted-foreground)",
                    },
                  },
                  c.sub,
                ),
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            Card,
            {
              style: {
                padding: 24,
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  fontWeight: 600,
                  marginBottom: 12,
                },
              },
              "\u0623\u062D\u062F\u062B \u0627\u0644\u0641\u0648\u0627\u062A\u064A\u0631",
            ),
            /*#__PURE__*/ React.createElement(InvoiceTable, {
              rows: window.adminData.invoices.slice(0, 4),
            }),
          ),
        );
      }
      function InvoiceTable({ rows }) {
        return /*#__PURE__*/ React.createElement(
          Table,
          null,
          /*#__PURE__*/ React.createElement(
            TableHeader,
            null,
            /*#__PURE__*/ React.createElement(
              TableRow,
              null,
              /*#__PURE__*/ React.createElement(
                TableHead,
                null,
                "\u0631\u0642\u0645 \u0627\u0644\u0641\u0627\u062A\u0648\u0631\u0629",
              ),
              /*#__PURE__*/ React.createElement(
                TableHead,
                null,
                "\u0627\u0644\u0645\u0633\u062A\u0623\u062C\u0631",
              ),
              /*#__PURE__*/ React.createElement(
                TableHead,
                null,
                "\u0627\u0644\u0648\u062D\u062F\u0629",
              ),
              /*#__PURE__*/ React.createElement(
                TableHead,
                null,
                "\u0627\u0644\u0645\u0628\u0644\u063A (\u062F.\u0643)",
              ),
              /*#__PURE__*/ React.createElement(
                TableHead,
                null,
                "\u0627\u0644\u0627\u0633\u062A\u062D\u0642\u0627\u0642",
              ),
              /*#__PURE__*/ React.createElement(
                TableHead,
                null,
                "\u0627\u0644\u062D\u0627\u0644\u0629",
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            TableBody,
            null,
            rows.map((r) =>
              /*#__PURE__*/ React.createElement(
                TableRow,
                {
                  key: r.id,
                },
                /*#__PURE__*/ React.createElement(
                  TableCell,
                  {
                    style: {
                      fontWeight: 500,
                    },
                    dir: "ltr",
                  },
                  r.id,
                ),
                /*#__PURE__*/ React.createElement(TableCell, null, r.tenant),
                /*#__PURE__*/ React.createElement(TableCell, null, r.unit),
                /*#__PURE__*/ React.createElement(
                  TableCell,
                  {
                    dir: "ltr",
                  },
                  r.amount,
                ),
                /*#__PURE__*/ React.createElement(
                  TableCell,
                  {
                    dir: "ltr",
                  },
                  r.due,
                ),
                /*#__PURE__*/ React.createElement(
                  TableCell,
                  null,
                  /*#__PURE__*/ React.createElement(StatusBadge, {
                    s: r.status,
                  }),
                ),
              ),
            ),
          ),
        );
      }
      function AdminInvoices() {
        const [filter, setFilter] = React.useState("all");
        const [q, setQ] = React.useState("");
        const [open, setOpen] = React.useState(false);
        const rows = window.adminData.invoices.filter(
          (r) =>
            (filter === "all" || r.status === filter) &&
            (q === "" || r.tenant.includes(q) || r.id.includes(q)),
        );
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            style: {
              display: "grid",
              gap: 24,
            },
          },
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 16,
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              null,
              /*#__PURE__*/ React.createElement(
                "h1",
                {
                  style: {
                    fontSize: 24,
                    fontWeight: 700,
                    margin: 0,
                  },
                },
                "\u0641\u0648\u0627\u062A\u064A\u0631 \u0627\u0644\u0625\u064A\u062C\u0627\u0631",
              ),
              /*#__PURE__*/ React.createElement(
                "p",
                {
                  style: {
                    margin: "4px 0 0",
                    fontSize: 14,
                    color: "var(--muted-foreground)",
                  },
                },
                "\u0625\u0635\u062F\u0627\u0631 \u0648\u0645\u062A\u0627\u0628\u0639\u0629 \u0641\u0648\u0627\u062A\u064A\u0631 \u0627\u0644\u0625\u064A\u062C\u0627\u0631 \u0627\u0644\u0634\u0647\u0631\u064A\u0629.",
              ),
            ),
            /*#__PURE__*/ React.createElement(
              Button,
              {
                onClick: () => setOpen(true),
              },
              /*#__PURE__*/ React.createElement(Icon, {
                name: "plus",
              }),
              " \u0641\u0627\u062A\u0648\u0631\u0629 \u062C\u062F\u064A\u062F\u0629",
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "flex",
                gap: 12,
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  position: "relative",
                  width: 280,
                },
              },
              /*#__PURE__*/ React.createElement(Input, {
                placeholder: "\u0628\u062D\u062B",
                value: q,
                onChange: (e) => setQ(e.target.value),
                style: {
                  paddingInlineStart: 34,
                },
              }),
              /*#__PURE__*/ React.createElement(
                "span",
                {
                  style: {
                    position: "absolute",
                    insetInlineStart: 10,
                    top: 10,
                    color: "var(--muted-foreground)",
                  },
                },
                /*#__PURE__*/ React.createElement(Icon, {
                  name: "search",
                  size: 16,
                }),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  width: 180,
                },
              },
              /*#__PURE__*/ React.createElement(Select, {
                value: filter,
                onValueChange: setFilter,
                options: [
                  {
                    value: "all",
                    label: "الكل",
                  },
                  {
                    value: "paid",
                    label: "مدفوعة",
                  },
                  {
                    value: "pending",
                    label: "قيد السداد",
                  },
                  {
                    value: "overdue",
                    label: "متأخرة",
                  },
                ],
              }),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            Card,
            {
              style: {
                padding: "8px 16px 16px",
              },
            },
            rows.length
              ? /*#__PURE__*/ React.createElement(InvoiceTable, {
                  rows: rows,
                })
              : /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      padding: 32,
                      textAlign: "center",
                      fontSize: 14,
                      color: "var(--muted-foreground)",
                    },
                  },
                  "\u0644\u0627 \u062A\u0648\u062C\u062F \u0628\u064A\u0627\u0646\u0627\u062A \u0644\u0639\u0631\u0636\u0647\u0627.",
                ),
          ),
          /*#__PURE__*/ React.createElement(
            Dialog,
            {
              open: open,
              onOpenChange: setOpen,
            },
            /*#__PURE__*/ React.createElement(
              DialogHeader,
              null,
              /*#__PURE__*/ React.createElement(
                DialogTitle,
                null,
                "\u0641\u0627\u062A\u0648\u0631\u0629 \u062C\u062F\u064A\u062F\u0629",
              ),
              /*#__PURE__*/ React.createElement(
                DialogDescription,
                null,
                "\u0623\u062F\u062E\u0644 \u0628\u064A\u0627\u0646\u0627\u062A \u0627\u0644\u0641\u0627\u062A\u0648\u0631\u0629 \u0627\u0644\u0634\u0647\u0631\u064A\u0629.",
              ),
            ),
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "grid",
                  gap: 12,
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "grid",
                    gap: 6,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  Label,
                  null,
                  "\u0627\u0644\u0645\u0633\u062A\u0623\u062C\u0631",
                ),
                /*#__PURE__*/ React.createElement(Select, {
                  placeholder: "\u0627\u062E\u062A\u0631",
                  options: window.adminData.invoices.map((r) => ({
                    value: r.id,
                    label: r.tenant,
                  })),
                }),
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      display: "grid",
                      gap: 6,
                    },
                  },
                  /*#__PURE__*/ React.createElement(
                    Label,
                    null,
                    "\u0627\u0644\u0645\u0628\u0644\u063A (\u062F.\u0643)",
                  ),
                  /*#__PURE__*/ React.createElement(Input, {
                    dir: "ltr",
                    placeholder: "0.000",
                  }),
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      display: "grid",
                      gap: 6,
                    },
                  },
                  /*#__PURE__*/ React.createElement(
                    Label,
                    null,
                    "\u062A\u0627\u0631\u064A\u062E \u0627\u0644\u0627\u0633\u062A\u062D\u0642\u0627\u0642",
                  ),
                  /*#__PURE__*/ React.createElement(Input, {
                    dir: "ltr",
                    type: "date",
                  }),
                ),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              DialogFooter,
              null,
              /*#__PURE__*/ React.createElement(
                Button,
                {
                  variant: "outline",
                  onClick: () => setOpen(false),
                },
                "\u0625\u0644\u063A\u0627\u0621",
              ),
              /*#__PURE__*/ React.createElement(
                Button,
                {
                  onClick: () => setOpen(false),
                },
                "\u062D\u0641\u0638 \u0627\u0644\u062A\u063A\u064A\u064A\u0631\u0627\u062A",
              ),
            ),
          ),
        );
      }
      function ModulePlaceholder({ title }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            style: {
              display: "grid",
              gap: 8,
              placeItems: "center",
              padding: "96px 0",
              textAlign: "center",
            },
          },
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "grid",
                placeItems: "center",
                width: 48,
                height: 48,
                borderRadius: "var(--radius-lg)",
                background: "var(--muted)",
                color: "var(--muted-foreground)",
              },
            },
            /*#__PURE__*/ React.createElement(Icon, {
              name: "wrench",
              size: 22,
            }),
          ),
          /*#__PURE__*/ React.createElement(
            "h2",
            {
              style: {
                margin: "8px 0 0",
                fontSize: 18,
                fontWeight: 600,
              },
            },
            "\u0647\u0630\u0647 \u0627\u0644\u0648\u062D\u062F\u0629 \u0642\u064A\u062F \u0627\u0644\u062A\u0637\u0648\u064A\u0631",
          ),
          /*#__PURE__*/ React.createElement(
            "p",
            {
              style: {
                margin: 0,
                fontSize: 14,
                color: "var(--muted-foreground)",
              },
            },
            "\u0633\u064A\u062A\u0645 \u062A\u0633\u0644\u064A\u0645 \u0634\u0627\u0634\u0629 \xAB",
            title,
            "\xBB \u0636\u0645\u0646 \u0627\u0644\u0645\u0631\u062D\u0644\u0629 \u0627\u0644\u0645\u062E\u0635\u0635\u0629 \u0644\u0647\u0627 \u0641\u064A \u062E\u0627\u0631\u0637\u0629 \u0627\u0644\u0637\u0631\u064A\u0642.",
          ),
        );
      }
      Object.assign(window, {
        AdminDashboard,
        AdminInvoices,
        ModulePlaceholder,
      });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/admin/AdminScreens.jsx",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/admin/AdminShell.jsx
  try {
    (() => {
      const { Button, SidebarNav, Logo, Icon } = window.DanatAlMustaqbalDesignSystem_110f06;
      const moduleLabels = {
        dashboard: "لوحة التحكم",
        invoices: "فواتير الإيجار",
        tenants: "المستأجرون",
        properties: "العقارات والمباني",
        units: "الوحدات",
        contracts: "العقود",
        payments: "المدفوعات",
        deposits: "الإيداعات البنكية",
        expenses: "المصروفات",
        electricity: "الكهرباء",
        reports: "التقارير",
        audit: "سجل التدقيق",
        settings: "إعدادات الشركة والنظام",
      };
      function AdminShell() {
        const [screen, setScreen] = React.useState("invoices");
        const [collapsed, setCollapsed] = React.useState(false);
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            dir: "rtl",
            style: {
              display: "flex",
              minHeight: "100vh",
              width: "100%",
            },
          },
          !collapsed &&
            /*#__PURE__*/ React.createElement(SidebarNav, {
              activeKey: screen,
              onNavigate: setScreen,
              className: "admin-sidebar",
            }),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                flex: 1,
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
              },
            },
            /*#__PURE__*/ React.createElement(
              "header",
              {
                style: {
                  height: 56,
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 12px",
                  gap: 8,
                  background: "var(--background)",
                  position: "sticky",
                  top: 0,
                  zIndex: 30,
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    variant: "ghost",
                    size: "icon",
                    onClick: () => setCollapsed(!collapsed),
                  },
                  /*#__PURE__*/ React.createElement(Icon, {
                    name: "panel-right",
                  }),
                ),
                /*#__PURE__*/ React.createElement(Logo, {
                  src: "../../assets/logo.png",
                  size: 32,
                  subName: null,
                }),
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  "button",
                  {
                    style: {
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border)",
                      background: "none",
                      padding: "4px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    },
                  },
                  "English",
                ),
                /*#__PURE__*/ React.createElement(
                  "span",
                  {
                    style: {
                      fontSize: 12,
                      color: "var(--muted-foreground)",
                    },
                  },
                  "\u0645\u0631\u062D\u0628\u064B\u0627 \u0628\u0643\u060C admin",
                ),
                /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    variant: "outline",
                    size: "sm",
                  },
                  "\u062A\u0633\u062C\u064A\u0644 \u0627\u0644\u062E\u0631\u0648\u062C",
                ),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              "main",
              {
                style: {
                  flex: 1,
                  padding: 24,
                },
              },
              screen === "dashboard"
                ? /*#__PURE__*/ React.createElement(AdminDashboard, null)
                : screen === "invoices"
                  ? /*#__PURE__*/ React.createElement(AdminInvoices, null)
                  : /*#__PURE__*/ React.createElement(ModulePlaceholder, {
                      title: moduleLabels[screen],
                    }),
            ),
          ),
        );
      }
      window.AdminShell = AdminShell;
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/admin/AdminShell.jsx",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/admin/data.js
  try {
    (() => {
      window.adminData = {
        invoices: [
          {
            id: "INV-2026-0341",
            tenant: "أحمد الكندري",
            unit: "برج السالمية — A-12",
            amount: "250.000",
            due: "2026-07-01",
            status: "paid",
          },
          {
            id: "INV-2026-0342",
            tenant: "شركة الخليج للتجارة",
            unit: "مجمع حولي التجاري — B-03",
            amount: "780.000",
            due: "2026-07-01",
            status: "overdue",
          },
          {
            id: "INV-2026-0343",
            tenant: "فاطمة العنزي",
            unit: "برج السالمية — A-07",
            amount: "320.000",
            due: "2026-07-01",
            status: "paid",
          },
          {
            id: "INV-2026-0344",
            tenant: "يوسف المطيري",
            unit: "عمارة الجابرية — C-02",
            amount: "210.000",
            due: "2026-07-01",
            status: "pending",
          },
          {
            id: "INV-2026-0345",
            tenant: "مؤسسة النخيل",
            unit: "مجمع حولي التجاري — B-11",
            amount: "645.000",
            due: "2026-07-01",
            status: "pending",
          },
          {
            id: "INV-2026-0346",
            tenant: "منيرة الرشيدي",
            unit: "عمارة الجابرية — C-08",
            amount: "185.000",
            due: "2026-07-01",
            status: "paid",
          },
        ],
        stats: [
          {
            label: "فواتير الإيجار",
            value: "46",
            sub: "صادرة هذا الشهر",
          },
          {
            label: "المدفوعات",
            value: "12,480.000",
            sub: "د.ك محصلة",
          },
          {
            label: "المستأجرون",
            value: "128",
            sub: "نشط",
          },
          {
            label: "الوحدات",
            value: "214",
            sub: "86% إشغال",
          },
        ],
      };
    })();
  } catch (e) {
    __ds_ns.__errors.push({ path: "ui_kits/admin/data.js", error: String((e && e.message) || e) });
  }

  // ui_kits/auth/Auth.jsx
  try {
    (() => {
      const { Button, Input, Label, Logo } = window.DanatAlMustaqbalDesignSystem_110f06;
      function Auth() {
        const [error, setError] = React.useState(null);
        const [u, setU] = React.useState("");
        const [p, setP] = React.useState("");
        const submit = (e) => {
          e.preventDefault();
          setError(u && p ? null : "بيانات الدخول غير صحيحة.");
        };
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            dir: "rtl",
            style: {
              minHeight: "100vh",
              display: "grid",
              placeItems: "center",
              background: "var(--background)",
              padding: 16,
            },
          },
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                width: "100%",
                maxWidth: 448,
                borderRadius: "var(--radius-xl)",
                border: "1px solid var(--border)",
                background: "var(--card)",
                padding: 32,
                boxShadow: "var(--shadow-sm)",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                },
              },
              /*#__PURE__*/ React.createElement(Logo, {
                src: "../../assets/logo.png",
                name: "Danat Al Mustaqbal",
                subName: null,
              }),
              /*#__PURE__*/ React.createElement(
                "button",
                {
                  style: {
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border)",
                    background: "none",
                    padding: "4px 12px",
                    fontSize: 12,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  },
                },
                "English",
              ),
            ),
            /*#__PURE__*/ React.createElement(
              "h1",
              {
                style: {
                  margin: "32px 0 0",
                  fontSize: 24,
                  fontWeight: 700,
                },
              },
              "\u062A\u0633\u062C\u064A\u0644 \u0627\u0644\u062F\u062E\u0648\u0644",
            ),
            /*#__PURE__*/ React.createElement(
              "p",
              {
                style: {
                  margin: "8px 0 0",
                  fontSize: 14,
                  color: "var(--muted-foreground)",
                },
              },
              "\u0623\u062F\u062E\u0644 \u0627\u0633\u0645 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645 \u0648\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u0645\u062E\u0635\u0635\u0629 \u0644\u0643 \u0645\u0646 \u0642\u0628\u0644 \u0627\u0644\u0625\u062F\u0627\u0631\u0629.",
            ),
            /*#__PURE__*/ React.createElement(
              "form",
              {
                style: {
                  marginTop: 24,
                  display: "grid",
                  gap: 16,
                },
                onSubmit: submit,
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "grid",
                    gap: 6,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  Label,
                  {
                    htmlFor: "u",
                  },
                  "\u0627\u0633\u0645 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645",
                ),
                /*#__PURE__*/ React.createElement(Input, {
                  id: "u",
                  dir: "ltr",
                  value: u,
                  onChange: (e) => setU(e.target.value),
                }),
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "grid",
                    gap: 6,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  Label,
                  {
                    htmlFor: "p",
                  },
                  "\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631",
                ),
                /*#__PURE__*/ React.createElement(Input, {
                  id: "p",
                  type: "password",
                  dir: "ltr",
                  value: p,
                  onChange: (e) => setP(e.target.value),
                }),
              ),
              error &&
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      borderRadius: "var(--radius-md)",
                      border: "1px solid color-mix(in oklab,var(--destructive) 40%,transparent)",
                      background: "color-mix(in oklab,var(--destructive) 10%,transparent)",
                      padding: "8px 12px",
                      fontSize: 14,
                      color: "var(--destructive)",
                    },
                  },
                  error,
                ),
              /*#__PURE__*/ React.createElement(
                Button,
                {
                  type: "submit",
                  style: {
                    marginTop: 8,
                  },
                },
                "\u062F\u062E\u0648\u0644",
              ),
            ),
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  marginTop: 24,
                  textAlign: "center",
                },
              },
              /*#__PURE__*/ React.createElement(
                "a",
                {
                  href: "../landing/index.html",
                  style: {
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                  },
                },
                "\u0627\u0644\u0639\u0648\u062F\u0629 \u0644\u0644\u0631\u0626\u064A\u0633\u064A\u0629",
              ),
            ),
            /*#__PURE__*/ React.createElement(
              "p",
              {
                style: {
                  marginTop: 24,
                  fontSize: 11,
                  color: "var(--muted-foreground)",
                },
              },
              "\u0627\u0644\u062D\u0633\u0627\u0628\u0627\u062A \u062A\u064F\u0646\u0634\u0623 \u0645\u0646 \u0642\u0628\u0644 \u0627\u0644\u0625\u062F\u0627\u0631\u0629 \u0641\u0642\u0637.",
            ),
          ),
        );
      }
      window.Auth = Auth;
    })();
  } catch (e) {
    __ds_ns.__errors.push({ path: "ui_kits/auth/Auth.jsx", error: String((e && e.message) || e) });
  }

  // ui_kits/landing/Landing.jsx
  try {
    (() => {
      const { Button, Input, Textarea, Card, Alert, AlertDescription, Logo, Icon } =
        window.DanatAlMustaqbalDesignSystem_110f06;
      function Landing() {
        const [locale, setLocale] = React.useState("ar");
        const t = window.landingDict[locale];
        const [status, setStatus] = React.useState("idle");
        const submit = (e) => {
          e.preventDefault();
          setStatus("loading");
          setTimeout(() => setStatus("success"), 700);
        };
        const inputStyle = {
          background: "var(--background)",
        };
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            dir: t.dir,
            style: {
              minHeight: "100vh",
            },
          },
          /*#__PURE__*/ React.createElement(
            "header",
            {
              style: {
                background: "var(--ink)",
                color: "var(--ink-foreground)",
                position: "sticky",
                top: 0,
                zIndex: 40,
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  margin: "0 auto",
                  display: "flex",
                  height: 64,
                  maxWidth: 1280,
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 16px",
                },
              },
              /*#__PURE__*/ React.createElement(Logo, {
                src: "../../assets/logo.png",
                name: t.brand,
                subName: t.brandSub,
                onDark: true,
              }),
              /*#__PURE__*/ React.createElement(
                "nav",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 24,
                    fontSize: 14,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  "a",
                  {
                    href: "#features",
                    style: {
                      color: "var(--gold-soft)",
                      textDecoration: "none",
                    },
                  },
                  t.navServices,
                ),
                /*#__PURE__*/ React.createElement(
                  "a",
                  {
                    href: "#contact",
                    style: {
                      color: "var(--gold-soft)",
                      textDecoration: "none",
                    },
                  },
                  t.navContact,
                ),
                /*#__PURE__*/ React.createElement(
                  "button",
                  {
                    onClick: () => setLocale(locale === "ar" ? "en" : "ar"),
                    style: {
                      borderRadius: 9999,
                      border: "1px solid var(--ink-muted)",
                      background: "none",
                      color: "var(--ink-foreground)",
                      padding: "6px 14px",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    },
                  },
                  t.lang,
                ),
                /*#__PURE__*/ React.createElement(
                  "a",
                  {
                    href: "../auth/index.html",
                    style: {
                      borderRadius: 9999,
                      background: "var(--accent)",
                      padding: "8px 18px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--accent-foreground)",
                      textDecoration: "none",
                    },
                  },
                  t.adminLogin,
                ),
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "section",
            {
              style: {
                margin: "0 auto",
                maxWidth: 1280,
                padding: "84px 16px 40px",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: "1.05fr 1fr",
                  gap: 44,
                  alignItems: "center",
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                null,
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      fontSize: 12,
                      letterSpacing: "0.14em",
                      color: "var(--gold-deep)",
                      fontWeight: 600,
                    },
                  },
                  t.tagline,
                ),
                /*#__PURE__*/ React.createElement(
                  "h1",
                  {
                    style: {
                      fontSize: 56,
                      fontWeight: 700,
                      lineHeight: 1.28,
                      margin: "18px 0 0",
                    },
                  },
                  t.headline,
                ),
                /*#__PURE__*/ React.createElement(
                  "p",
                  {
                    style: {
                      maxWidth: 540,
                      fontSize: 17,
                      color: "var(--muted-foreground)",
                      lineHeight: 1.9,
                      margin: "20px 0 0",
                    },
                  },
                  t.sub,
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      marginTop: 34,
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 14,
                    },
                  },
                  /*#__PURE__*/ React.createElement(
                    Button,
                    {
                      size: "lg",
                      onClick: () =>
                        window.scrollTo({
                          top: document.getElementById("contact").offsetTop,
                          behavior: "smooth",
                        }),
                    },
                    t.ctaContact,
                  ),
                  /*#__PURE__*/ React.createElement(
                    Button,
                    {
                      size: "lg",
                      variant: "outline",
                    },
                    t.ctaTenant,
                  ),
                ),
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    position: "relative",
                  },
                },
                /*#__PURE__*/ React.createElement("img", {
                  src: "../../assets/landing/hero.png",
                  alt: "",
                  style: {
                    width: "100%",
                    aspectRatio: "4/3.4",
                    objectFit: "cover",
                    borderRadius: 18,
                    display: "block",
                  },
                }),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      position: "absolute",
                      bottom: -20,
                      insetInlineStart: -20,
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: 14,
                      padding: "16px 22px",
                      boxShadow: "0 10px 30px rgb(23 21 18 / 0.12)",
                    },
                  },
                  /*#__PURE__*/ React.createElement(
                    "div",
                    {
                      style: {
                        fontSize: 11,
                        color: "var(--gold-deep)",
                        fontWeight: 600,
                      },
                    },
                    t.occupancy,
                  ),
                  /*#__PURE__*/ React.createElement(
                    "div",
                    {
                      style: {
                        fontSize: 28,
                        fontWeight: 700,
                      },
                    },
                    "86% ",
                    /*#__PURE__*/ React.createElement(
                      "span",
                      {
                        style: {
                          fontSize: 12,
                          color: "var(--muted-foreground)",
                          fontWeight: 400,
                        },
                      },
                      "\xB7 ",
                      t.units,
                    ),
                  ),
                ),
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "section",
            {
              style: {
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
                background: "color-mix(in oklab,var(--card) 50%,transparent)",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  margin: "0 auto",
                  maxWidth: 1280,
                  padding: "64px 16px",
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    margin: "0 auto",
                    aspectRatio: "16/9",
                    maxWidth: 896,
                    overflow: "hidden",
                    borderRadius: "var(--radius-xl)",
                    border: "1px solid var(--border)",
                    background: "var(--muted)",
                    display: "grid",
                    placeItems: "center",
                    color: "var(--muted-foreground)",
                  },
                },
                /*#__PURE__*/ React.createElement(
                  "span",
                  {
                    style: {
                      fontSize: 14,
                    },
                  },
                  t.video,
                ),
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "section",
            {
              id: "features",
              style: {
                margin: "0 auto",
                maxWidth: 1280,
                padding: "96px 16px",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 48,
                  alignItems: "center",
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    overflow: "hidden",
                    borderRadius: "var(--radius-2xl)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-sm)",
                  },
                },
                /*#__PURE__*/ React.createElement("img", {
                  src: "../../assets/landing/feature.png",
                  alt: "",
                  style: {
                    aspectRatio: "4/3",
                    width: "100%",
                    objectFit: "cover",
                    display: "block",
                  },
                }),
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    maxWidth: 640,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  "h2",
                  {
                    style: {
                      fontSize: 34,
                      fontWeight: 700,
                      margin: 0,
                    },
                  },
                  t.featTitle,
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      marginTop: 32,
                      display: "grid",
                      gap: 24,
                    },
                  },
                  [
                    ["building-2", t.f1t, t.f1b],
                    ["credit-card", t.f2t, t.f2b],
                    ["line-chart", t.f3t, t.f3b],
                  ].map(([ic, title, body]) =>
                    /*#__PURE__*/ React.createElement(
                      Card,
                      {
                        key: ic,
                        style: {
                          padding: 24,
                          borderRadius: "var(--radius-xl)",
                        },
                      },
                      /*#__PURE__*/ React.createElement(
                        "div",
                        {
                          style: {
                            display: "grid",
                            placeItems: "center",
                            height: 40,
                            width: 40,
                            borderRadius: "var(--radius-md)",
                            background: "color-mix(in oklab,var(--primary) 10%,transparent)",
                            color: "var(--primary)",
                          },
                        },
                        /*#__PURE__*/ React.createElement(Icon, {
                          name: ic,
                          size: 24,
                        }),
                      ),
                      /*#__PURE__*/ React.createElement(
                        "h3",
                        {
                          style: {
                            margin: "16px 0 0",
                            fontSize: 18,
                            fontWeight: 600,
                          },
                        },
                        title,
                      ),
                      /*#__PURE__*/ React.createElement(
                        "p",
                        {
                          style: {
                            margin: "8px 0 0",
                            fontSize: 14,
                            color: "var(--muted-foreground)",
                          },
                        },
                        body,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "section",
            {
              id: "contact",
              style: {
                background: "color-mix(in oklab,var(--card) 50%,transparent)",
                borderTop: "1px solid var(--border)",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  margin: "0 auto",
                  display: "grid",
                  maxWidth: 1280,
                  gap: 48,
                  padding: "96px 16px",
                  gridTemplateColumns: "1fr 1fr",
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                null,
                /*#__PURE__*/ React.createElement(
                  "h2",
                  {
                    style: {
                      fontSize: 34,
                      fontWeight: 700,
                      margin: 0,
                    },
                  },
                  t.contactTitle,
                ),
                /*#__PURE__*/ React.createElement(
                  "p",
                  {
                    style: {
                      marginTop: 16,
                      color: "var(--muted-foreground)",
                    },
                  },
                  t.contactSub,
                ),
                status === "success" &&
                  /*#__PURE__*/ React.createElement(
                    "div",
                    {
                      style: {
                        marginTop: 24,
                      },
                    },
                    /*#__PURE__*/ React.createElement(
                      Alert,
                      {
                        variant: "success",
                      },
                      /*#__PURE__*/ React.createElement(AlertDescription, null, t.success),
                    ),
                  ),
              ),
              /*#__PURE__*/ React.createElement(
                "form",
                {
                  style: {
                    display: "grid",
                    gap: 16,
                  },
                  onSubmit: submit,
                },
                /*#__PURE__*/ React.createElement(Input, {
                  placeholder: t.name,
                  required: true,
                  style: inputStyle,
                }),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      display: "grid",
                      gap: 16,
                      gridTemplateColumns: "1fr 1fr",
                    },
                  },
                  /*#__PURE__*/ React.createElement(Input, {
                    type: "tel",
                    placeholder: t.phone,
                    style: inputStyle,
                  }),
                  /*#__PURE__*/ React.createElement(Input, {
                    type: "email",
                    placeholder: t.email,
                    required: true,
                    style: inputStyle,
                  }),
                ),
                /*#__PURE__*/ React.createElement(Input, {
                  placeholder: t.subject,
                  style: inputStyle,
                }),
                /*#__PURE__*/ React.createElement(Textarea, {
                  placeholder: t.message,
                  required: true,
                  style: {
                    minHeight: 128,
                    background: "var(--background)",
                  },
                }),
                /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    type: "submit",
                    disabled: status === "loading",
                  },
                  status === "loading" ? t.sending : t.send,
                ),
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "footer",
            {
              style: {
                background: "var(--ink)",
                color: "var(--ink-foreground)",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  margin: "0 auto",
                  display: "grid",
                  maxWidth: 1280,
                  gap: 32,
                  padding: "48px 16px",
                  gridTemplateColumns: "1fr 1fr 1fr",
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                null,
                /*#__PURE__*/ React.createElement(Logo, {
                  src: "../../assets/logo.png",
                  name: t.brand,
                  subName: null,
                  onDark: true,
                }),
                /*#__PURE__*/ React.createElement(
                  "p",
                  {
                    style: {
                      marginTop: 12,
                      fontSize: 12,
                      color: "var(--ink-muted)",
                    },
                  },
                  "\xA9 2026 \u2014 ",
                  t.rights,
                ),
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                null,
                /*#__PURE__*/ React.createElement(
                  "h3",
                  {
                    style: {
                      fontSize: 14,
                      fontWeight: 600,
                      margin: 0,
                    },
                  },
                  t.footContact,
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      marginTop: 12,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 14,
                      color: "var(--ink-muted)",
                    },
                  },
                  /*#__PURE__*/ React.createElement(Icon, {
                    name: "mail",
                    size: 16,
                  }),
                  /*#__PURE__*/ React.createElement(
                    "a",
                    {
                      href: "mailto:info@example.com",
                      style: {
                        color: "inherit",
                        textDecoration: "none",
                      },
                    },
                    "info@example.com",
                  ),
                ),
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                null,
                /*#__PURE__*/ React.createElement(
                  "h3",
                  {
                    style: {
                      fontSize: 14,
                      fontWeight: 600,
                      margin: 0,
                    },
                  },
                  t.follow,
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      marginTop: 12,
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      color: "var(--gold-soft)",
                    },
                  },
                  /*#__PURE__*/ React.createElement(Icon, {
                    name: "facebook",
                    size: 20,
                  }),
                  /*#__PURE__*/ React.createElement(Icon, {
                    name: "instagram",
                    size: 20,
                  }),
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      marginTop: 24,
                    },
                  },
                  /*#__PURE__*/ React.createElement(
                    "a",
                    {
                      href: "../auth/index.html",
                      style: {
                        fontSize: 12,
                        color: "var(--gold-soft)",
                      },
                    },
                    t.adminLogin,
                  ),
                ),
              ),
            ),
          ),
        );
      }
      window.Landing = Landing;
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/landing/Landing.jsx",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/landing/dict.js
  try {
    (() => {
      window.landingDict = {
        ar: {
          dir: "rtl",
          brand: "دانة المستقبل العقارية",
          brandSub: "Danat Al Mustaqbal",
          tagline: "منصة متكاملة لإدارة العقارات، العقود، والمدفوعات",
          headline: "إدارة عقارية احترافية، بكل بساطة",
          sub: "نظام موحّد للعقارات، المستأجرين، الفواتير، والمدفوعات — بتحصيل آمن وتقارير دقيقة.",
          ctaContact: "تواصل معنا",
          ctaTenant: "بوابة المستأجر",
          navServices: "خدماتنا",
          navContact: "تواصل معنا",
          lang: "English",
          adminLogin: "دخول الإدارة",
          video: "مساحة الفيديو التعريفي — يُضاف لاحقًا",
          featTitle: "ما الذي يقدمه النظام",
          f1t: "فواتير شهرية آلية",
          f1b: "إصدار تلقائي لفواتير الإيجار مع متابعة الاستحقاق والتحصيل.",
          f2t: "دفع إلكتروني آمن",
          f2b: "تحصيل عبر ماي فاتورة مع إيصالات فورية للمستأجرين.",
          f3t: "تقارير وتنبيهات",
          f3b: "تقارير دقيقة وتنبيهات لانتهاء العقود والمتأخرات.",
          contactTitle: "تواصل معنا",
          contactSub: "املأ النموذج وسنعاود التواصل معك في أقرب وقت.",
          name: "الاسم",
          phone: "رقم الهاتف",
          email: "البريد الإلكتروني",
          subject: "الموضوع",
          message: "الرسالة",
          send: "إرسال",
          sending: "جاري الإرسال...",
          success: "تم إرسال رسالتك بنجاح! سنتواصل معك قريباً.",
          rights: "جميع الحقوق محفوظة",
          footContact: "معلومات التواصل",
          follow: "تابعنا",
          occupancy: "نسبة الإشغال",
          units: "214 وحدة",
        },
        en: {
          dir: "ltr",
          brand: "Danat Al Mustaqbal Real Estate",
          brandSub: "دانة المستقبل",
          tagline: "Property, lease, and payment management — unified.",
          headline: "Professional real-estate operations, made simple",
          sub: "One system for properties, tenants, invoices, and payments — with secure collection and accurate reports.",
          ctaContact: "Contact us",
          ctaTenant: "Tenant portal",
          navServices: "Services",
          navContact: "Contact",
          lang: "العربية",
          adminLogin: "Admin Login",
          video: "Company intro video — to be added",
          featTitle: "What the platform delivers",
          f1t: "Automated monthly invoices",
          f1b: "Rent invoices issued automatically with due-date and collection tracking.",
          f2t: "Secure online payments",
          f2b: "Collection via MyFatoorah with instant tenant receipts.",
          f3t: "Reports & alerts",
          f3b: "Accurate reports and alerts for contract expiry and arrears.",
          contactTitle: "Contact us",
          contactSub: "Fill in the form and we'll get back to you shortly.",
          name: "Name",
          phone: "Phone",
          email: "Email",
          subject: "Subject",
          message: "Message",
          send: "Send",
          sending: "Sending...",
          success: "Your message has been sent successfully! We will contact you soon.",
          rights: "All rights reserved",
          footContact: "Contact",
          follow: "Follow us",
          occupancy: "Occupancy",
          units: "214 units",
        },
      };
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/landing/dict.js",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/portal/Portal.jsx
  try {
    (() => {
      const {
        Card,
        Badge,
        Button,
        PortalNav,
        Table,
        TableHeader,
        TableBody,
        TableRow,
        TableHead,
        TableCell,
        Logo,
        Icon,
        Progress,
      } = window.DanatAlMustaqbalDesignSystem_110f06;
      const invoices = [
        {
          id: "INV-2026-0344",
          month: "يوليو 2026",
          amount: "210.000",
          status: "pending",
        },
        {
          id: "INV-2026-0298",
          month: "يونيو 2026",
          amount: "210.000",
          status: "paid",
        },
        {
          id: "INV-2026-0251",
          month: "مايو 2026",
          amount: "210.000",
          status: "paid",
        },
      ];
      function PStatus({ s }) {
        return s === "paid"
          ? /*#__PURE__*/ React.createElement(
              Badge,
              {
                variant: "success",
              },
              "\u0645\u062F\u0641\u0648\u0639\u0629",
            )
          : /*#__PURE__*/ React.createElement(
              Badge,
              {
                variant: "secondary",
              },
              "\u0642\u064A\u062F \u0627\u0644\u0633\u062F\u0627\u062F",
            );
      }
      function PortalDashboard() {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            style: {
              display: "grid",
              gap: 16,
            },
          },
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "grid",
                gridTemplateColumns: "repeat(3,1fr)",
                gap: 16,
              },
            },
            /*#__PURE__*/ React.createElement(
              Card,
              {
                style: {
                  padding: 20,
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                  },
                },
                /*#__PURE__*/ React.createElement(Icon, {
                  name: "file-text",
                  size: 14,
                }),
                " \u0641\u0627\u062A\u0648\u0631\u0629 \u064A\u0648\u0644\u064A\u0648",
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    marginTop: 8,
                    fontSize: 28,
                    fontWeight: 700,
                  },
                  dir: "ltr",
                },
                "210.000 ",
                /*#__PURE__*/ React.createElement(
                  "span",
                  {
                    style: {
                      fontSize: 13,
                      fontWeight: 400,
                    },
                  },
                  "\u062F.\u0643",
                ),
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    marginTop: 12,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    size: "sm",
                  },
                  "\u0627\u062F\u0641\u0639 \u0627\u0644\u0622\u0646",
                ),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              Card,
              {
                style: {
                  padding: 20,
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                  },
                },
                /*#__PURE__*/ React.createElement(Icon, {
                  name: "building-2",
                  size: 14,
                }),
                " \u0648\u062D\u062F\u062A\u064A",
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    marginTop: 8,
                    fontSize: 16,
                    fontWeight: 600,
                  },
                },
                "\u0639\u0645\u0627\u0631\u0629 \u0627\u0644\u062C\u0627\u0628\u0631\u064A\u0629 \u2014 C-02",
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    marginTop: 4,
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                  },
                },
                "\u0639\u0642\u062F \u0633\u0646\u0648\u064A \u062D\u062A\u0649 2027-03-31",
              ),
            ),
            /*#__PURE__*/ React.createElement(
              Card,
              {
                style: {
                  padding: 20,
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                  },
                },
                /*#__PURE__*/ React.createElement(Icon, {
                  name: "scroll-text",
                  size: 14,
                }),
                " \u0645\u062F\u0629 \u0627\u0644\u0639\u0642\u062F \u0627\u0644\u0645\u062A\u0628\u0642\u064A\u0629",
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    marginTop: 12,
                  },
                },
                /*#__PURE__*/ React.createElement(Progress, {
                  value: 71,
                }),
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    marginTop: 8,
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                  },
                },
                "8 \u0623\u0634\u0647\u0631 \u0645\u062A\u0628\u0642\u064A\u0629 \u0645\u0646 12",
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            Card,
            {
              style: {
                padding: "8px 20px 16px",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  fontWeight: 600,
                  padding: "12px 0 4px",
                },
              },
              "\u0623\u062D\u062F\u062B \u0627\u0644\u0641\u0648\u0627\u062A\u064A\u0631",
            ),
            /*#__PURE__*/ React.createElement(InvoiceList, {
              rows: invoices,
            }),
          ),
        );
      }
      function InvoiceList({ rows }) {
        return /*#__PURE__*/ React.createElement(
          Table,
          null,
          /*#__PURE__*/ React.createElement(
            TableHeader,
            null,
            /*#__PURE__*/ React.createElement(
              TableRow,
              null,
              /*#__PURE__*/ React.createElement(
                TableHead,
                null,
                "\u0631\u0642\u0645 \u0627\u0644\u0641\u0627\u062A\u0648\u0631\u0629",
              ),
              /*#__PURE__*/ React.createElement(TableHead, null, "\u0627\u0644\u0634\u0647\u0631"),
              /*#__PURE__*/ React.createElement(
                TableHead,
                null,
                "\u0627\u0644\u0645\u0628\u0644\u063A (\u062F.\u0643)",
              ),
              /*#__PURE__*/ React.createElement(
                TableHead,
                null,
                "\u0627\u0644\u062D\u0627\u0644\u0629",
              ),
              /*#__PURE__*/ React.createElement(TableHead, null),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            TableBody,
            null,
            rows.map((r) =>
              /*#__PURE__*/ React.createElement(
                TableRow,
                {
                  key: r.id,
                },
                /*#__PURE__*/ React.createElement(
                  TableCell,
                  {
                    dir: "ltr",
                    style: {
                      fontWeight: 500,
                    },
                  },
                  r.id,
                ),
                /*#__PURE__*/ React.createElement(TableCell, null, r.month),
                /*#__PURE__*/ React.createElement(
                  TableCell,
                  {
                    dir: "ltr",
                  },
                  r.amount,
                ),
                /*#__PURE__*/ React.createElement(
                  TableCell,
                  null,
                  /*#__PURE__*/ React.createElement(PStatus, {
                    s: r.status,
                  }),
                ),
                /*#__PURE__*/ React.createElement(
                  TableCell,
                  null,
                  r.status !== "paid" &&
                    /*#__PURE__*/ React.createElement(
                      Button,
                      {
                        size: "sm",
                        variant: "outline",
                      },
                      "\u0627\u062F\u0641\u0639",
                    ),
                ),
              ),
            ),
          ),
        );
      }
      function Portal() {
        const [screen, setScreen] = React.useState("dashboard");
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            dir: "rtl",
            style: {
              minHeight: "100vh",
              background: "color-mix(in oklab,var(--muted) 30%,transparent)",
            },
          },
          /*#__PURE__*/ React.createElement(
            "header",
            {
              style: {
                position: "sticky",
                top: 0,
                zIndex: 40,
                borderBottom: "1px solid var(--border)",
                background: "color-mix(in oklab,var(--background) 95%,transparent)",
                backdropFilter: "blur(8px)",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  margin: "0 auto",
                  display: "flex",
                  maxWidth: 1280,
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "12px 16px",
                },
              },
              /*#__PURE__*/ React.createElement(Logo, {
                src: "../../assets/logo.png",
                size: 40,
                name: "\u062F\u0627\u0646\u0629 \u0627\u0644\u0645\u0633\u062A\u0642\u0628\u0644 \u0627\u0644\u0639\u0642\u0627\u0631\u064A\u0629",
                subName: "\u064A\u0648\u0633\u0641 \u0627\u0644\u0645\u0637\u064A\u0631\u064A",
              }),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    gap: 8,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    variant: "outline",
                    size: "sm",
                  },
                  "English",
                ),
                /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    variant: "ghost",
                    size: "sm",
                  },
                  "\u062A\u0633\u062C\u064A\u0644 \u0627\u0644\u062E\u0631\u0648\u062C",
                ),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  margin: "0 auto",
                  maxWidth: 1280,
                  padding: "0 16px 12px",
                },
              },
              /*#__PURE__*/ React.createElement(PortalNav, {
                activeKey: screen,
                onNavigate: (k) => setScreen(k === "invoices" ? "invoices" : "dashboard"),
              }),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "main",
            {
              style: {
                margin: "0 auto",
                maxWidth: 1280,
                padding: 24,
              },
            },
            screen === "invoices"
              ? /*#__PURE__*/ React.createElement(
                  Card,
                  {
                    style: {
                      padding: "8px 20px 16px",
                    },
                  },
                  /*#__PURE__*/ React.createElement(
                    "div",
                    {
                      style: {
                        fontWeight: 600,
                        padding: "12px 0 4px",
                      },
                    },
                    "\u0641\u0648\u0627\u062A\u064A\u0631\u064A",
                  ),
                  /*#__PURE__*/ React.createElement(InvoiceList, {
                    rows: invoices,
                  }),
                )
              : /*#__PURE__*/ React.createElement(PortalDashboard, null),
          ),
        );
      }
      window.Portal = Portal;
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/portal/Portal.jsx",
      error: String((e && e.message) || e),
    });
  }

  __ds_ns.Alert = __ds_scope.Alert;

  __ds_ns.AlertTitle = __ds_scope.AlertTitle;

  __ds_ns.AlertDescription = __ds_scope.AlertDescription;

  __ds_ns.Avatar = __ds_scope.Avatar;

  __ds_ns.Badge = __ds_scope.Badge;

  __ds_ns.Card = __ds_scope.Card;

  __ds_ns.CardHeader = __ds_scope.CardHeader;

  __ds_ns.CardTitle = __ds_scope.CardTitle;

  __ds_ns.CardDescription = __ds_scope.CardDescription;

  __ds_ns.CardContent = __ds_scope.CardContent;

  __ds_ns.CardFooter = __ds_scope.CardFooter;

  __ds_ns.Icon = __ds_scope.Icon;

  __ds_ns.Logo = __ds_scope.Logo;

  __ds_ns.Progress = __ds_scope.Progress;

  __ds_ns.Separator = __ds_scope.Separator;

  __ds_ns.Skeleton = __ds_scope.Skeleton;

  __ds_ns.Table = __ds_scope.Table;

  __ds_ns.TableHeader = __ds_scope.TableHeader;

  __ds_ns.TableBody = __ds_scope.TableBody;

  __ds_ns.TableRow = __ds_scope.TableRow;

  __ds_ns.TableHead = __ds_scope.TableHead;

  __ds_ns.TableCell = __ds_scope.TableCell;

  __ds_ns.Button = __ds_scope.Button;

  __ds_ns.Checkbox = __ds_scope.Checkbox;

  __ds_ns.Input = __ds_scope.Input;

  __ds_ns.Label = __ds_scope.Label;

  __ds_ns.RadioGroup = __ds_scope.RadioGroup;

  __ds_ns.RadioGroupItem = __ds_scope.RadioGroupItem;

  __ds_ns.Select = __ds_scope.Select;

  __ds_ns.Switch = __ds_scope.Switch;

  __ds_ns.Textarea = __ds_scope.Textarea;

  __ds_ns.Breadcrumb = __ds_scope.Breadcrumb;

  __ds_ns.PortalNav = __ds_scope.PortalNav;

  __ds_ns.SidebarNav = __ds_scope.SidebarNav;

  __ds_ns.Tabs = __ds_scope.Tabs;

  __ds_ns.TabsList = __ds_scope.TabsList;

  __ds_ns.TabsTrigger = __ds_scope.TabsTrigger;

  __ds_ns.TabsContent = __ds_scope.TabsContent;

  __ds_ns.Dialog = __ds_scope.Dialog;

  __ds_ns.DialogHeader = __ds_scope.DialogHeader;

  __ds_ns.DialogTitle = __ds_scope.DialogTitle;

  __ds_ns.DialogDescription = __ds_scope.DialogDescription;

  __ds_ns.DialogFooter = __ds_scope.DialogFooter;

  __ds_ns.Tooltip = __ds_scope.Tooltip;
})();
