/* @ds-bundle: {"namespace":"FluencyCompanion","components":[{"name":"ChartAxes","sourcePath":"components/general/ChartAxes/ChartAxes.jsx"},{"name":"ColumnsMenu","sourcePath":"components/general/ColumnsMenu/ColumnsMenu.jsx"},{"name":"DataSourceManageLink","sourcePath":"components/general/DataSourceManageLink/DataSourceManageLink.jsx"},{"name":"ErrorBox","sourcePath":"components/general/ErrorBox/ErrorBox.jsx"},{"name":"FacetGroup","sourcePath":"components/general/FacetGroup/FacetGroup.jsx"},{"name":"Header","sourcePath":"components/general/Header/Header.jsx"},{"name":"JsonLine","sourcePath":"components/general/JsonLine/JsonLine.jsx"},{"name":"Loading","sourcePath":"components/general/Loading/Loading.jsx"},{"name":"Pager","sourcePath":"components/general/Pager/Pager.jsx"},{"name":"SlideOver","sourcePath":"components/general/SlideOver/SlideOver.jsx"}],"sourceHashes":{"components/general/ChartAxes/ChartAxes.jsx":"0a2485a2c532","components/general/ChartAxes/ChartAxes.d.ts":"049561e7e1f9","components/general/ChartAxes/ChartAxes.prompt.md":"06e5acbe69a6","components/general/ColumnsMenu/ColumnsMenu.jsx":"417341f813a8","components/general/ColumnsMenu/ColumnsMenu.d.ts":"c5586eb224da","components/general/ColumnsMenu/ColumnsMenu.prompt.md":"a07d43369e35","components/general/DataSourceManageLink/DataSourceManageLink.jsx":"9a5fa0046051","components/general/DataSourceManageLink/DataSourceManageLink.d.ts":"2634cdf0efb3","components/general/DataSourceManageLink/DataSourceManageLink.prompt.md":"346fa4e61d06","components/general/ErrorBox/ErrorBox.jsx":"6a3598f50266","components/general/ErrorBox/ErrorBox.d.ts":"2e9ea0e663fc","components/general/ErrorBox/ErrorBox.prompt.md":"545f1b831ec8","components/general/FacetGroup/FacetGroup.jsx":"bf93eac5927d","components/general/FacetGroup/FacetGroup.d.ts":"41f5f78c9c31","components/general/FacetGroup/FacetGroup.prompt.md":"475c40b9549e","components/general/Header/Header.jsx":"c0fa321851d4","components/general/Header/Header.d.ts":"8e5e68aa721f","components/general/Header/Header.prompt.md":"4aa070f14680","components/general/JsonLine/JsonLine.jsx":"926652e161c4","components/general/JsonLine/JsonLine.d.ts":"a3b53ddb09f4","components/general/JsonLine/JsonLine.prompt.md":"eafc5fe3be32","components/general/Loading/Loading.jsx":"e8067691c2dd","components/general/Loading/Loading.d.ts":"ab4bebb34de2","components/general/Loading/Loading.prompt.md":"496719ea9d4d","components/general/Pager/Pager.jsx":"770506b96e8d","components/general/Pager/Pager.d.ts":"5b479eb1da14","components/general/Pager/Pager.prompt.md":"31d477870fa5","components/general/SlideOver/SlideOver.jsx":"86fdd33f28d9","components/general/SlideOver/SlideOver.d.ts":"55bb393a8a12","components/general/SlideOver/SlideOver.prompt.md":"42de6be27c2c"},"inlinedExternals":[],"builtBy":"cc-design-sync"} */
var FluencyCompanion = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // <define:import.meta.env>
  var init_define_import_meta_env = __esm({
    "<define:import.meta.env>"() {
    }
  });

  // shim:react-shim
  var require_react_shim = __commonJS({
    "shim:react-shim"(exports, module) {
      init_define_import_meta_env();
      var R = window.React;
      function np(p, k) {
        var o = {};
        for (var x in p) if (x !== "children") o[x] = p[x];
        if (k !== void 0) o.key = k;
        return o;
      }
      function jsx(t, p, k) {
        var c = p && p.children;
        return c === void 0 ? R.createElement(t, np(p, k)) : R.createElement(t, np(p, k), c);
      }
      function jsxs(t, p, k) {
        return R.createElement.apply(R, [t, np(p, k)].concat(p.children));
      }
      module.exports = R;
      module.exports.jsx = jsx;
      module.exports.jsxs = jsxs;
      module.exports.jsxDEV = function(t, p, k, s) {
        return (s ? jsxs : jsx)(t, p, k);
      };
      module.exports.Fragment = R.Fragment;
    }
  });

  // companion-ui/.ds-entry.jsx
  var ds_entry_exports = {};
  __export(ds_entry_exports, {
    ChartAxes: () => ChartAxes,
    ColumnsMenu: () => ColumnsMenu,
    DataSourceManageLink: () => DataSourceManageLink,
    ErrorBox: () => ErrorBox,
    FacetGroup: () => FacetGroup,
    Header: () => Header,
    JsonLine: () => JsonLine,
    Loading: () => Loading,
    Pager: () => Pager,
    SlideOver: () => SlideOver
  });
  init_define_import_meta_env();

  // companion-ui/src/shared.jsx
  init_define_import_meta_env();
  function Header({ eyebrow, title, children }) {
    return /* @__PURE__ */ React.createElement("header", { className: "page-head" }, /* @__PURE__ */ React.createElement("p", null, eyebrow), /* @__PURE__ */ React.createElement("h1", null, title), children ? /* @__PURE__ */ React.createElement("div", { className: "lede" }, children) : null);
  }
  function Loading() {
    return /* @__PURE__ */ React.createElement("div", { className: "empty" }, "Loading...");
  }
  function ErrorBox({ error }) {
    return /* @__PURE__ */ React.createElement("div", { className: "error" }, String(error.message || error));
  }

  // companion-ui/src/searchShared.jsx
  init_define_import_meta_env();
  var import_react = __toESM(require_react_shim());

  // companion-ui/src/chartTime.mjs
  init_define_import_meta_env();
  function asDate(value) {
    const n = Number(value);
    return Number.isFinite(n) ? new Date(n) : new Date(value);
  }
  function isSameLocalDay(from, to) {
    const start = asDate(from);
    const end = asDate(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
    return start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth() && start.getDate() === end.getDate();
  }
  function fmtAxisTime(value, { sameDay = true } = {}) {
    const date = asDate(value);
    if (Number.isNaN(date.getTime())) return "";
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (sameDay) return time;
    return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  }

  // companion-ui/src/searchShared.jsx
  var MS_DAY = 24 * 60 * 60 * 1e3;
  function ChartAxes({ yMax, yUnit, xFrom, xTo, children }) {
    const mid = Number.isFinite(xFrom) && Number.isFinite(xTo) ? xFrom + (xTo - xFrom) / 2 : null;
    const sameDay = isSameLocalDay(xFrom, xTo);
    const tick = (value) => Number.isFinite(value) ? fmtAxisTime(value, { sameDay }) : "";
    return /* @__PURE__ */ import_react.default.createElement("div", { className: "chart-frame" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "chart-y" }, /* @__PURE__ */ import_react.default.createElement("span", null, formatCount(yMax)), /* @__PURE__ */ import_react.default.createElement("span", { className: "chart-y-unit" }, yUnit), /* @__PURE__ */ import_react.default.createElement("span", null, "0")), /* @__PURE__ */ import_react.default.createElement("div", { className: "chart-plot" }, children, /* @__PURE__ */ import_react.default.createElement("div", { className: "chart-x" }, /* @__PURE__ */ import_react.default.createElement("span", null, tick(xFrom)), /* @__PURE__ */ import_react.default.createElement("span", null, mid === null ? "" : tick(mid)), /* @__PURE__ */ import_react.default.createElement("span", null, tick(xTo)))));
  }
  function formatCount(value) {
    const n = Number(value) || 0;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return String(n);
  }
  function JsonLine({ record, onClick }) {
    const s = JSON.stringify(record);
    const segs = [];
    const re = /"(?:[^"\\]|\\.)*"\s*:/g;
    let last = 0;
    let m;
    while (m = re.exec(s)) {
      if (m.index > last) segs.push({ text: s.slice(last, m.index), key: false });
      segs.push({ text: m[0], key: true });
      last = m.index + m[0].length;
    }
    if (last < s.length) segs.push({ text: s.slice(last), key: false });
    return /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-json-line", onClick }, segs.map((sg, i) => /* @__PURE__ */ import_react.default.createElement("span", { key: i, className: sg.key ? "bs-json-key" : "bs-json-val" }, sg.text)));
  }
  function FacetGroup({ label, buckets, selected, onToggle, removable, onRemove, note }) {
    const [expanded, setExpanded] = (0, import_react.useState)(false);
    const visible = expanded ? buckets : buckets.slice(0, 6);
    return /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-facet-group" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-facet-head" }, /* @__PURE__ */ import_react.default.createElement("span", null, label, " ", /* @__PURE__ */ import_react.default.createElement("em", null, "(", buckets.length, ")", note ? /* @__PURE__ */ import_react.default.createElement("small", null, " \xB7 ", note) : null)), removable ? /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "bs-icon-btn", onClick: onRemove, "aria-label": `Remove ${label} field` }, "\xD7") : null), visible.map((b) => /* @__PURE__ */ import_react.default.createElement("label", { key: String(b.key), className: "bs-facet-row" }, /* @__PURE__ */ import_react.default.createElement("input", { type: "checkbox", checked: selected.includes(String(b.key)), onChange: () => onToggle(String(b.key)) }), /* @__PURE__ */ import_react.default.createElement("span", { className: "bs-facet-label" }, String(b.key)), /* @__PURE__ */ import_react.default.createElement("span", { className: "bs-facet-count" }, b.doc_count))), buckets.length > 6 ? /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "bs-link-btn", onClick: () => setExpanded((v) => !v) }, expanded ? "Show less" : `+ ${buckets.length - 6} more`) : null, !buckets.length ? /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-facet-empty" }, "No values in this window.") : null);
  }
  function ColumnsMenu({ allColumns, columns, columnLabel, onToggle }) {
    const [open, setOpen] = (0, import_react.useState)(false);
    return /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-col-picker" }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "bs-toggle", onClick: () => setOpen((v) => !v) }, "\u2699 Columns"), open ? /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-colpicker-popover" }, allColumns.map((key) => {
      const on = columns.includes(key);
      return /* @__PURE__ */ import_react.default.createElement("div", { key, className: "bs-colpicker-row", onClick: () => onToggle(key) }, /* @__PURE__ */ import_react.default.createElement("span", { className: on ? "bs-colpicker-box on" : "bs-colpicker-box" }, on ? "\u2713" : ""), /* @__PURE__ */ import_react.default.createElement("span", null, columnLabel(key)));
    })) : null);
  }
  function Pager({ curPage, pageCount, rangeStart, rangeEnd, totalShown, onPrev, onNext }) {
    return /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-pager" }, /* @__PURE__ */ import_react.default.createElement("span", null, rangeStart, "\u2013", rangeEnd, " of ", totalShown), /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-pager-controls" }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", disabled: curPage <= 0, onClick: onPrev }, "\u2039 Prev"), /* @__PURE__ */ import_react.default.createElement("span", null, "Page ", curPage + 1, " of ", pageCount), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", disabled: curPage >= pageCount - 1, onClick: onNext }, "Next \u203A")));
  }
  function SlideOver({ onClose, children }) {
    return /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-overlay" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "bs-scrim", onClick: onClose }), children);
  }

  // companion-ui/src/DataSourceManageLink.mjs
  init_define_import_meta_env();
  var import_react2 = __toESM(require_react_shim(), 1);
  function DataSourceManageLink({ allowed, className, href, children }) {
    if (!allowed) return null;
    return import_react2.default.createElement("a", { className, href }, children);
  }
  return __toCommonJS(ds_entry_exports);
})();
window.FluencyCompanion=FluencyCompanion.__dsMainNs?Object.assign({},FluencyCompanion,FluencyCompanion.__dsMainNs,{__dsMainNs:undefined}):FluencyCompanion;
