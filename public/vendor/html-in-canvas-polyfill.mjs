var ne = Object.defineProperty;
var oe = (e, t, o) => t in e ? ne(e, t, { enumerable: !0, configurable: !0, writable: !0, value: o }) : e[t] = o;
var R = (e, t, o) => oe(e, typeof t != "symbol" ? t + "" : t, o);
/**
 * @license
 * three-html-render v0.1.2
 * Copyright 2025-2026 repalash <palash@shaders.app>
 * MIT License
 * See ./dependencies.txt for bundled third-party dependencies and licenses.
 */
/**
 * @license
 * ts-browser-helpers v0.12.0
 * Copyright 2022-2024 repalash <palash@shaders.app>
 * MIT License
 */
async function se(e) {
  return new Promise((t, o) => {
    const n = new Image();
    n.onload = () => t(n), n.onerror = o, n.crossOrigin = "anonymous", n.decoding = "sync", n.src = e;
  });
}
const ie = (e, ...t) => String.raw({ raw: e }, ...t);
async function re(e) {
  return new Promise((t, o) => {
    const n = new FileReader();
    n.onload = (s) => t(n.result), n.onerror = (s) => o(n.error), n.onabort = (s) => o(new Error("Read aborted")), n.readAsDataURL(e);
  });
}
const ae = async (e) => re(await (await fetch(e)).blob());
async function le(e, t = ae) {
  const o = e.match(/(((ftp|https?):\/\/)[\-\w@:%_\+.~#?,&\/\/=]+)/g);
  if (o)
    for (const n of o) {
      const s = await t(n);
      e = e.replace(n, s);
    }
  return e;
}
function ce(e, t) {
  const o = e.querySelectorAll("input, textarea, select, option"), n = t.querySelectorAll("input, textarea, select, option");
  if (o.length === n.length)
    for (let s = 0; s < o.length; s++) {
      const i = o[s], r = n[s];
      switch (i.tagName) {
        case "INPUT": {
          const a = i, l = r;
          a.type === "checkbox" || a.type === "radio" ? a.checked ? l.setAttribute("checked", "") : l.removeAttribute("checked") : l.setAttribute("value", a.value);
          break;
        }
        case "TEXTAREA":
          r.textContent = i.value;
          break;
        case "SELECT": {
          const a = i, l = r;
          l.selectedIndex = a.selectedIndex;
          break;
        }
        case "OPTION":
          i.selected ? r.setAttribute("selected", "") : r.removeAttribute("selected");
          break;
      }
    }
}
const B = typeof location < "u" && new URLSearchParams(location.search).has("debugPolyfillHIC");
class ue {
  constructor() {
    R(this, "pixelRatio", typeof window < "u" && window.devicePixelRatio || 1);
    R(this, "pageStyles", "");
    R(this, "entries", /* @__PURE__ */ new Map());
    R(this, "pageStylesCssPromise", null);
    R(this, "svgOnlyStyles", ie`
[style*="--scroll-left"], [style*="--scroll-top"] {
    overflow: hidden !important;
}
[style*="--animation-delay"] {
    animation-delay: var(--animation-delay, 0s) !important;
}
[style*="--scroll-left"] > *, [style*="--scroll-top"] > * {
    transform: translate(var(--scroll-left, 0), var(--scroll-top, 0));
}
`);
  }
  async update(t) {
    const o = t.clientWidth || t.offsetWidth, n = t.clientHeight || t.offsetHeight;
    if (o === 0 || n === 0) {
      const c = this.entries.get(t);
      return c ? c.canvas : this.ensureEntry(t, 1, 1).canvas;
    }
    const s = this.ensureEntry(t, o, n), i = Math.max(1, this.pixelRatio), r = s.canvas.width, a = s.canvas.height, l = await this.buildSvg(t, o, n, i);
    if (l === s.lastSvg)
      return B && console.log("[html-in-canvas debug] rasterization skipped (unchanged)"), s.canvas;
    if (B && s.lastSvg) {
      const c = s.lastSvg.split("<"), h = l.split("<"), u = [], g = Math.max(c.length, h.length);
      for (let d = 0; d < g; d++)
        if (c[d] !== h[d] && (u.push(`  - ${(c[d] || "").slice(0, 120)}`), u.push(`  + ${(h[d] || "").slice(0, 120)}`)), u.length > 20) {
          u.push("  ...");
          break;
        }
      console.log(`[html-in-canvas debug] SVG changed:
` + u.join(`
`));
    }
    s.lastSvg = l;
    const p = await pe(l, r, a);
    return s.context.clearRect(0, 0, r, a), s.context.drawImage(p, 0, 0, r, a), s.canvas;
  }
  getCanvas(t) {
    var o;
    return ((o = this.entries.get(t)) == null ? void 0 : o.canvas) ?? null;
  }
  getCssSize(t) {
    const o = this.entries.get(t);
    return o ? { width: o.cssW, height: o.cssH } : null;
  }
  setPageStyles(t) {
    this.pageStyles = t;
  }
  async getPageStylesCss() {
    if (!this.pageStylesCssPromise) {
      const t = fe();
      this.pageStylesCssPromise = t, t.catch(() => {
        this.pageStylesCssPromise === t && (this.pageStylesCssPromise = null);
      });
    }
    return this.pageStylesCssPromise;
  }
  invalidatePageStylesCss() {
    this.pageStylesCssPromise = null;
  }
  cleanup() {
    this.entries.clear(), this.pageStylesCssPromise = null, $.clear(), v && (v.remove(), v = null);
  }
  captureDynamicStateOnClone(t, o) {
    const n = [t, ...t.querySelectorAll("*")], s = [o, ...o.querySelectorAll("*")];
    if (n.length === s.length) {
      for (let i = 0; i < n.length; i++)
        be(n[i], s[i]);
      Ee(t, o), Ce(t, o);
    }
  }
  ensureEntry(t, o, n) {
    const s = Math.max(1, this.pixelRatio), i = Math.max(1, Math.ceil(o * s)), r = Math.max(1, Math.ceil(n * s));
    let a = this.entries.get(t);
    if (a)
      (a.canvas.width !== i || a.canvas.height !== r) && (a.canvas.width = i, a.canvas.height = r), a.cssW = o, a.cssH = n;
    else {
      const l = document.createElement("canvas");
      l.width = i, l.height = r;
      const p = l.getContext("2d");
      a = { canvas: l, context: p, cssW: o, cssH: n }, this.entries.set(t, a);
    }
    return a;
  }
  async buildSvg(t, o, n, s = 1) {
    const i = await de(t);
    this.captureDynamicStateOnClone(t, i);
    const r = he(t, new XMLSerializer().serializeToString(i)), a = await this.getPageStylesCss(), l = ge + `
` + a + `
` + this.pageStyles + `
` + this.svgOnlyStyles, p = `<svg xmlns="http://www.w3.org/2000/svg" width="${o}" height="${n}" viewBox="0 0 ${o} ${n}"><style><![CDATA[${l.replace(/]]>/g, "]]]]><![CDATA[>")}]]></style><foreignObject x="0" y="0" width="100%" height="100%">${r}</foreignObject></svg>`;
    if (B) {
      let c = document.getElementById("__hic-svg-debug__");
      c || (c = document.createElement("div"), c.id = "__hic-svg-debug__", c.style.cssText = "position:absolute;z-index:99999;pointer-events:none;opacity:0.3;box-sizing:border-box;margin:0;padding:0;border:none;overflow:hidden;", document.body.appendChild(c));
      const h = document.querySelector("canvas");
      if (h) {
        const u = h.getBoundingClientRect();
        c.style.left = u.left + window.scrollX + "px", c.style.top = u.top + window.scrollY + "px", c.style.width = u.width + "px", c.style.height = u.height + "px";
      }
      if (!c.innerHTML) {
        c.innerHTML = p;
        const u = c.querySelector("svg");
        u && (u.style.width = "100%", u.style.height = "100%");
      }
    }
    return p;
  }
}
async function de(e) {
  const t = e.cloneNode(!0);
  return ce(e, t), Le(e, t), t.style.removeProperty("transform"), t.style.opacity = "1", t.style.visibility = "visible", await Se(t), t.setAttribute("xmlns", "http://www.w3.org/1999/xhtml"), t;
}
function he(e, t) {
  const o = e.parentElement, n = (o == null ? void 0 : o.getAttribute("class")) || "", s = (o == null ? void 0 : o.clientWidth) || e.clientWidth || e.offsetWidth, i = (o == null ? void 0 : o.clientHeight) || e.clientHeight || e.offsetHeight;
  return '<html xmlns="http://www.w3.org/1999/xhtml" style="margin:0;padding:0;background:transparent !important;"><body style="margin:0;padding:0;background:transparent !important;">' + `<div xmlns="http://www.w3.org/1999/xhtml"${n ? ` class="${we(n)}"` : ""} style="position:relative;width:${s}px;height:${i}px;margin:0;padding:0;">` + t + "</div>" + "</body></html>";
}
async function pe(e, t, o) {
  const n = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(e);
  try {
    return await se(n);
  } catch (s) {
    const i = s && typeof s == "object" && "type" in s ? s.type : typeof s, r = new Error(
      `HtmlRenderer: SVG image failed to load (${i}). cssW=${t}, cssH=${o}, svg.length=${e.length}. svg head: ${e.slice(0, 300).replace(/\s+/g, " ")}…`
    );
    throw r.cause = s, r.svg = e, r;
  }
}
async function fe() {
  const e = [];
  for (const n of Array.from(document.styleSheets))
    try {
      const s = Array.from(n.cssRules || []);
      e.push(s.map((i) => i.cssText).join(`
`));
    } catch {
      if (!n.href) continue;
      try {
        const s = await fetch(n.href);
        s.ok && e.push(await s.text());
      } catch (s) {
        console.warn("[HtmlRenderer] failed to fetch stylesheet", n.href, s);
      }
    }
  if (e.length === 0) return "";
  let t;
  try {
    t = await le(e.join(`
`), async (n) => {
      if (n.startsWith("http://www.w3.org/")) return n;
      try {
        return await K(n);
      } catch {
        return n;
      }
    });
  } catch (n) {
    console.warn("[HtmlRenderer] URL embedding failed", n), t = e.join(`
`);
  }
  const o = ve(t);
  return o ? t + `
` + o : t;
}
const ge = `
a { color: -webkit-link; text-decoration: underline; cursor: pointer; }
*.pseudo-focus-visible { outline: auto 1px -webkit-focus-ring-color; }
input.pseudo-focus-visible, textarea.pseudo-focus-visible, select.pseudo-focus-visible { outline-offset: 0; }
input[type="checkbox"].pseudo-focus-visible, input[type="radio"].pseudo-focus-visible { outline-offset: 2px; }
a.pseudo-focus-visible { outline-offset: 1px; }
@media (prefers-color-scheme: dark) {
    button.pseudo-hover, select.pseudo-hover,
    input.pseudo-hover, textarea.pseudo-hover {
        filter: brightness(1.1);
    }
    button.pseudo-active, select.pseudo-active,
    input.pseudo-active, textarea.pseudo-active {
        filter: brightness(0.9);
    }
}
@media (prefers-color-scheme: light) {
    button.pseudo-hover, select.pseudo-hover,
    input.pseudo-hover, textarea.pseudo-hover {
        filter: brightness(0.9);
    }
    button.pseudo-active, select.pseudo-active,
    input.pseudo-active, textarea.pseudo-active {
        filter: brightness(1.1);
    }
}
`, me = /:(?:hover|focus-visible|focus-within|focus(?!-)|active)\b/g, ye = /:(?:hover|focus-visible|focus-within|focus(?!-)|active)\b/;
function ve(e) {
  let t;
  try {
    t = new CSSStyleSheet(), t.replaceSync(e);
  } catch {
    return "";
  }
  const o = [];
  return J(t.cssRules, o), o.join(`
`);
}
function J(e, t) {
  var o, n;
  for (let s = 0; s < e.length; s++) {
    const i = e[s];
    if (i instanceof CSSStyleRule) {
      if (ye.test(i.selectorText)) {
        const r = i.selectorText.replace(
          me,
          (a) => ".pseudo-" + a.slice(1)
        );
        t.push(`${r} { ${i.style.cssText} }`);
      }
    } else if ("cssRules" in i) {
      const r = i, a = [];
      if (J(r.cssRules, a), a.length) {
        let l = "";
        i instanceof CSSMediaRule ? l = `@media ${i.conditionText}` : i instanceof CSSSupportsRule ? l = `@supports ${i.conditionText}` : l = ((n = (o = i.cssText) == null ? void 0 : o.split("{")[0]) == null ? void 0 : n.trim()) ?? "", l && t.push(`${l} {
${a.join(`
`)}
}`);
      }
    }
  }
}
function we(e) {
  return e.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function be(e, t) {
  (e.scrollLeft !== 0 || e.scrollTop !== 0) && (t.style.setProperty("--scroll-left", -e.scrollLeft + "px"), t.style.setProperty("--scroll-top", -e.scrollTop + "px"));
  const o = e.getAnimations();
  if (o.length !== 1) return;
  const n = o[0], s = typeof n.currentTime == "number" ? n.currentTime : 0, i = getComputedStyle(e).animationDelay, a = ((i.endsWith("ms") ? parseFloat(i) / 1e3 : parseFloat(i)) || 0) - s / 1e3;
  t.style.setProperty("--animation-delay", a + "s");
}
const xe = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "whiteSpace",
  "wordWrap",
  "overflowWrap",
  "wordBreak",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "boxSizing",
  "width",
  "direction",
  "textAlign"
];
let v = null;
function U(e, t) {
  v || (v = document.createElement("div"), v.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;overflow:hidden;", document.body.appendChild(v));
  const o = getComputedStyle(e), n = e instanceof HTMLInputElement;
  for (const h of xe) v.style[h] = o[h];
  v.style.whiteSpace = n ? "pre" : o.whiteSpace, v.style.height = "auto", v.style.overflowY = "hidden";
  const s = e.value, i = s.substring(0, t);
  v.textContent = "";
  const r = document.createTextNode(i), a = document.createElement("span");
  a.textContent = "|", v.appendChild(r), v.appendChild(a), v.appendChild(document.createTextNode(s.substring(t) || "."));
  const l = parseFloat(o.fontSize), p = parseFloat(o.lineHeight), c = isNaN(p) ? l * 1.2 : o.lineHeight.endsWith("px") ? p : p * l;
  return {
    x: a.offsetLeft,
    y: a.offsetTop,
    height: c
  };
}
function Ee(e, t) {
  const o = document.activeElement;
  if (!o) return;
  let n;
  if (o instanceof HTMLInputElement) {
    const f = o.type;
    if (f !== "text" && f !== "search" && f !== "url" && f !== "tel" && f !== "password" && f !== "") return;
    n = o;
  } else if (o instanceof HTMLTextAreaElement)
    n = o;
  else
    return;
  if (!e.contains(n)) return;
  const s = n.selectionStart, i = n.selectionEnd;
  if (s === null || i === null) return;
  const r = getComputedStyle(n), a = parseFloat(r.borderLeftWidth) || 0, l = parseFloat(r.borderTopWidth) || 0;
  let p = 0, c = 0, h = n;
  for (; h && h !== e; )
    p += h.offsetLeft, c += h.offsetTop, h = h.offsetParent;
  const u = p + a, g = c + l, d = u, w = d + n.clientWidth, x = g, L = x + n.clientHeight;
  if (s === i) {
    const f = U(n, s), S = u + f.x - n.scrollLeft, E = g + f.y - n.scrollTop;
    if (Math.floor(Date.now() / 500) % 2 === 0 && S >= d && S <= w && E >= x && E + f.height <= L) {
      const T = document.createElement("div");
      T.setAttribute("xmlns", "http://www.w3.org/1999/xhtml"), T.style.cssText = `position:absolute;pointer-events:none;left:${S}px;top:${E}px;width:2px;height:${f.height}px;background:currentColor;`, t.appendChild(T);
    }
  } else {
    const f = U(n, s), S = U(n, i), E = f.height, O = n.scrollLeft, T = n.scrollTop;
    if (f.y === S.y) {
      const A = Math.max(u + f.x - O, d), b = Math.min(u + S.x - O, w), I = g + f.y - T;
      if (b > A && I >= x && I + E <= L) {
        const P = document.createElement("div");
        P.setAttribute("xmlns", "http://www.w3.org/1999/xhtml"), P.style.cssText = `position:absolute;pointer-events:none;left:${A}px;top:${I}px;width:${b - A}px;height:${E}px;background:Highlight;opacity:0.5;`, t.appendChild(P);
      }
    } else {
      const A = [];
      A.push({ left: u + f.x - O, right: w, top: g + f.y - T });
      for (let b = f.y + E; b < S.y; b += E)
        A.push({ left: d, right: w, top: g + b - T });
      A.push({ left: d, right: u + S.x - O, top: g + S.y - T });
      for (const b of A) {
        const I = Math.max(b.left, d), P = Math.min(b.right, w);
        if (P <= I || b.top + E < x || b.top > L) continue;
        const W = document.createElement("div");
        W.setAttribute("xmlns", "http://www.w3.org/1999/xhtml"), W.style.cssText = `position:absolute;pointer-events:none;left:${I}px;top:${b.top}px;width:${P - I}px;height:${E}px;background:Highlight;opacity:0.5;`, t.appendChild(W);
      }
    }
  }
}
function Ce(e, t) {
  const o = window.getSelection();
  if (!o || o.isCollapsed || o.rangeCount === 0) return;
  const n = o.getRangeAt(0);
  if (!e.contains(n.startContainer) && !e.contains(n.endContainer)) return;
  const s = e.style.transform, i = e.style.transformOrigin;
  e.style.transform = "none", e.style.transformOrigin = "";
  const r = e.getBoundingClientRect(), a = e.offsetWidth / r.width, l = e.offsetHeight / r.height, p = e.offsetWidth, c = e.offsetHeight, h = n.getClientRects(), u = [];
  for (let g = 0; g < h.length; g++) {
    const d = h[g];
    u.push({
      left: (d.left - r.left) * a + e.scrollLeft,
      top: (d.top - r.top) * l + e.scrollTop,
      width: d.width * a,
      height: d.height * l
    });
  }
  e.style.transform = s, e.style.transformOrigin = i;
  for (let g = 0; g < u.length; g++) {
    let { left: d, top: w, width: x, height: L } = u[g];
    if (d < 0 && (x += d, d = 0), w < 0 && (L += w, w = 0), d + x > p && (x = p - d), w + L > c && (L = c - w), x <= 0 || L <= 0) continue;
    const f = document.createElement("div");
    f.setAttribute("xmlns", "http://www.w3.org/1999/xhtml"), f.style.cssText = `position:absolute;pointer-events:none;left:${d}px;top:${w}px;width:${x}px;height:${L}px;background:Highlight;opacity:0.5;`, t.appendChild(f);
  }
}
function Le(e, t) {
  const o = [e, ...e.querySelectorAll("*")], n = [t, ...t.querySelectorAll("*")];
  if (o.length === n.length)
    for (let s = 0; s < o.length; s++) {
      const i = getComputedStyle(o[s]);
      for (const r of ["fontSize", "lineHeight", "height", "minHeight", "maxHeight", "marginTop", "marginBottom", "paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]) {
        const a = parseFloat(i[r]);
        isNaN(a) || (n[s].style[r] = a % 1 !== 0 ? Math.floor(a) + "px" : i[r]);
      }
    }
}
const $ = /* @__PURE__ */ new Map();
function K(e) {
  const t = $.get(e);
  if (t) return t;
  const o = fetch(e).then((n) => {
    if (!n.ok) throw new Error(`fetch ${e} → ${n.status}`);
    return n.blob();
  }).then((n) => new Promise((s, i) => {
    const r = new FileReader();
    r.onload = () => s(r.result), r.onerror = () => i(r.error), r.readAsDataURL(n);
  }));
  return $.set(e, o), o.catch(() => {
    $.get(e) === o && $.delete(e);
  }), o;
}
async function Se(e) {
  const t = Array.from(e.querySelectorAll("img"));
  await Promise.all(t.map(async (o) => {
    const n = o.getAttribute("src");
    if (!(!n || n.startsWith("data:")))
      try {
        const s = new URL(n, document.baseURI).href;
        o.setAttribute("src", await K(s));
      } catch (s) {
        console.warn("[HtmlRenderer] failed to inline img", n, s), o.removeAttribute("src");
      }
  }));
}
const m = /* @__PURE__ */ new Map(), C = new ue();
let D = !1;
function Ve() {
  return C;
}
const F = [], q = [], Y = /* @__PURE__ */ new WeakMap();
let _ = null;
function Qe(e = {}) {
  if (D) return;
  if (window.__HTML_IN_CANVAS_POLYFILL__) {
    const n = window.__HIC_UNINSTALL__;
    if (typeof n == "function") n();
    else return;
  }
  const t = "drawElementImage" in CanvasRenderingContext2D.prototype && "requestPaint" in HTMLCanvasElement.prototype && "onpaint" in HTMLCanvasElement.prototype, o = e.force ?? new URLSearchParams(location.search).has("polyfillHIC");
  if (t && !o) {
    console.info("[html-in-canvas] Native API detected, polyfill skipped. Add ?polyfillHIC to URL to force.");
    return;
  }
  D = !0, window.__HTML_IN_CANVAS_POLYFILL__ = !0, window.__HIC_UNINSTALL__ = Te, console.info("[html-in-canvas] Polyfill installed" + (o ? " (forced)" : "")), e.pageStyles && C.setPageStyles(e.pageStyles), Ae(), Ie(), Me(), Oe(), Ne(), We();
}
function Te() {
  if (D) {
    for (const e of Array.from(m.values()))
      te(e);
    m.clear();
    for (const [e, t, o] of F)
      o ? Object.defineProperty(e, t, o) : delete e[t];
    F.length = 0;
    for (const [e, t, o, n] of q)
      e.removeEventListener(t, o, n);
    q.length = 0, _ == null || _.disconnect(), _ = null, H = null, C.cleanup(), D = !1, window.__HTML_IN_CANVAS_POLYFILL__ = !1, delete window.__HIC_UNINSTALL__;
  }
}
function X(e, t) {
  const o = m.get(e) || M(e);
  if (!o)
    throw new DOMException("canvas is not [layoutsubtree]", "InvalidStateError");
  if (!o.children.has(t))
    throw new DOMException("element is not a direct child of the canvas", "InvalidStateError");
  return o;
}
function Z(e, t, o, n, s, i) {
  const r = new DOMMatrix().scale(o, n), a = new DOMMatrix().scale(1 / o, 1 / n), p = getComputedStyle(e).transformOrigin.split(" "), c = parseFloat(p[0]) || s / 2, h = parseFloat(p[1]) || i / 2, u = new DOMMatrix().translate(c, h);
  return new DOMMatrix().translate(-c, -h).multiply(a).multiply(t).multiply(r).multiply(u);
}
function Ae() {
  y(CanvasRenderingContext2D.prototype, "drawElementImage", {
    configurable: !0,
    writable: !0,
    value: He
  });
}
function He(e, t, o, n, s) {
  const i = this.canvas;
  X(i, e);
  const r = C.getCanvas(e), a = C.getCssSize(e);
  if (!r || !a)
    return new DOMMatrix();
  const l = a.width, p = a.height, c = i.width / Math.max(1, i.clientWidth), h = i.height / Math.max(1, i.clientHeight), u = n ?? l * c, g = s ?? p * h;
  this.drawImage(r, t, o, u, g);
  const d = this.getTransform().translate(t, o).scale(u / (l * c), g / (p * h));
  return Z(e, d, c, h, l, p);
}
function Ie() {
  typeof WebGLRenderingContext < "u" && y(WebGLRenderingContext.prototype, "texElementImage2D", {
    configurable: !0,
    writable: !0,
    value: V
  }), typeof WebGL2RenderingContext < "u" && y(WebGL2RenderingContext.prototype, "texElementImage2D", {
    configurable: !0,
    writable: !0,
    value: V
  });
}
function V(e, t, o, ...n) {
  let s, i, r;
  if (n.length === 3)
    [s, i, r] = n;
  else if (n.length === 5)
    console.warn("[html-in-canvas polyfill] texElementImage2D(width,height,...) overload: dest resize not implemented, uploading at bitmap size"), [, , s, i, r] = n;
  else if (n.length === 7)
    console.warn("[html-in-canvas polyfill] texElementImage2D(sx,sy,swidth,sheight,...) overload: source crop not implemented, uploading full bitmap"), [, , , , s, i, r] = n;
  else if (n.length === 9)
    console.warn("[html-in-canvas polyfill] texElementImage2D(sx,sy,swidth,sheight,width,height,...) overload: source crop + dest resize not implemented, uploading full bitmap"), [, , , , , , s, i, r] = n;
  else
    throw new TypeError(`texElementImage2D: unexpected argument count ${3 + n.length}`);
  if (!(r instanceof HTMLElement))
    throw new TypeError("texElementImage2D: element must be an HTMLElement");
  const a = C.getCanvas(r);
  if (!a)
    throw new DOMException(
      "texElementImage2D: no snapshot recorded yet for this element. Call from inside the canvas `onpaint` handler or after at least one `requestPaint()` + rAF cycle.",
      "InvalidStateError"
    );
  this.texImage2D(e, t, o, s, i, a);
}
function Me() {
  const e = globalThis.GPUQueue;
  !e || !e.prototype || y(e.prototype, "copyElementImageToTexture", {
    configurable: !0,
    writable: !0,
    value: Pe
  });
}
function Pe(...e) {
  let t, o, n, s;
  if (e.length === 2)
    [t, o] = e, n = 0, s = 0;
  else if (e.length === 4)
    [t, n, s, o] = e;
  else
    throw new TypeError(
      `copyElementImageToTexture: expected 2 or 4 args, got ${e.length}`
    );
  if (!(t instanceof HTMLElement))
    throw new TypeError("copyElementImageToTexture: source must be an HTMLElement");
  const i = C.getCanvas(t);
  if (!i)
    throw new DOMException(
      "copyElementImageToTexture: no snapshot recorded yet for this element. Call from inside the canvas `onpaint` handler or after at least one `requestPaint()` + rAF cycle.",
      "InvalidStateError"
    );
  n === 0 && (n = i.width), s === 0 && (s = i.height);
  let r = i;
  if (i.width !== n || i.height !== s) {
    r = Re(n, s);
    const a = r.getContext("2d");
    a.clearRect(0, 0, n, s), a.imageSmoothingEnabled = !0, a.imageSmoothingQuality = "high", a.drawImage(i, 0, 0, n, s);
  }
  this.copyExternalImageToTexture(
    { source: r },
    o,
    [n, s]
  );
}
let H = null;
function Re(e, t) {
  return H || (H = document.createElement("canvas")), H.width !== e && (H.width = e), H.height !== t && (H.height = t), H;
}
function _e(e, t) {
  const o = this;
  X(o, e);
  const n = C.getCssSize(e);
  if (!n)
    throw new DOMException("no snapshot recorded yet", "InvalidStateError");
  const s = o.width / Math.max(1, o.clientWidth), i = o.height / Math.max(1, o.clientHeight);
  return Z(e, t, s, i, n.width, n.height);
}
function Oe() {
  y(HTMLCanvasElement.prototype, "layoutSubtree", {
    configurable: !0,
    get() {
      return this.hasAttribute("layoutsubtree");
    },
    set(e) {
      e ? this.setAttribute("layoutsubtree", "") : this.removeAttribute("layoutsubtree");
    }
  }), y(HTMLCanvasElement.prototype, "onpaint", {
    configurable: !0,
    get() {
      var e;
      return ((e = m.get(this)) == null ? void 0 : e.onpaint) ?? null;
    },
    set(e) {
      const t = M(this);
      t ? t.onpaint = e : e && console.warn(
        "[html-in-canvas polyfill] setting onpaint on a canvas without `layoutsubtree` — the handler will never fire. Add the `layoutsubtree` attribute first."
      );
    }
  }), y(HTMLCanvasElement.prototype, "requestPaint", {
    configurable: !0,
    writable: !0,
    value: function() {
      const e = M(this);
      if (e) {
        for (const t of e.children) e.dirty.add(t);
        k(e, "requestPaint");
      }
    }
  }), y(HTMLCanvasElement.prototype, "getElementTransform", {
    configurable: !0,
    writable: !0,
    value: _e
  }), y(HTMLCanvasElement.prototype, "captureElementImage", {
    configurable: !0,
    writable: !0,
    value: function(e) {
      X(this, e);
      const t = C.getCanvas(e);
      if (!t)
        throw new DOMException("no snapshot recorded yet", "InvalidStateError");
      return t;
    }
  }), N("children", (e) => e.children), N("firstElementChild", (e) => e.firstElementChild), N("lastElementChild", (e) => e.lastElementChild), N("childElementCount", (e) => e.childElementCount), $e(), De(), ke();
}
function N(e, t) {
  const o = Object.getOwnPropertyDescriptor(Element.prototype, e);
  y(HTMLCanvasElement.prototype, e, {
    configurable: !0,
    get() {
      const n = m.get(this);
      return n && this.hasAttribute("layoutsubtree") ? t(n.host) : o.get.call(this);
    }
  });
}
function j(e, t, o) {
  e.children.has(t) || (o ? e.host.insertBefore(t, o) : e.host.appendChild(t), t.style.position = "absolute", t.style.left = "0", t.style.top = "0", t.style.opacity = "0", t.style.pointerEvents = "auto", e.children.add(t), e.dirty.add(t), Y.set(t, e.canvas), k(e, "addChildToState"));
}
function ee(e, t) {
  return e.children.has(t) ? (e.host.removeChild(t), e.children.delete(t), e.dirty.delete(t), Y.delete(t), t.style.removeProperty("position"), t.style.removeProperty("left"), t.style.removeProperty("top"), t.style.removeProperty("opacity"), t.style.removeProperty("pointer-events"), t.style.removeProperty("transform-origin"), !0) : !1;
}
function $e() {
  const e = Node.prototype.appendChild;
  y(HTMLCanvasElement.prototype, "appendChild", {
    configurable: !0,
    writable: !0,
    value: function(n) {
      const s = m.get(this);
      return s && this.hasAttribute("layoutsubtree") && n instanceof HTMLElement ? (j(s, n), n) : e.call(this, n);
    }
  });
  const t = Node.prototype.removeChild;
  y(HTMLCanvasElement.prototype, "removeChild", {
    configurable: !0,
    writable: !0,
    value: function(n) {
      const s = m.get(this);
      return s && n instanceof HTMLElement && ee(s, n) ? n : t.call(this, n);
    }
  });
  const o = Node.prototype.insertBefore;
  y(HTMLCanvasElement.prototype, "insertBefore", {
    configurable: !0,
    writable: !0,
    value: function(n, s) {
      const i = m.get(this);
      return i && this.hasAttribute("layoutsubtree") && n instanceof HTMLElement ? (j(i, n, s), n) : o.call(this, n, s);
    }
  }), y(HTMLCanvasElement.prototype, "contains", {
    configurable: !0,
    writable: !0,
    value: function(n) {
      const s = m.get(this);
      return s && n && s.host.contains(n) ? !0 : Node.prototype.contains.call(this, n);
    }
  });
}
function De() {
  for (const e of ["parentNode", "parentElement"]) {
    const t = Object.getOwnPropertyDescriptor(Node.prototype, e);
    y(Node.prototype, e, {
      configurable: !0,
      get() {
        return Y.get(this) ?? t.get.call(this);
      }
    });
  }
}
const Q = /* @__PURE__ */ new Set([
  "mousemove",
  "mousedown",
  "mouseup",
  "mouseenter",
  "mouseleave",
  "mouseover",
  "mouseout",
  "click",
  "dblclick",
  "contextmenu",
  "wheel",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointerenter",
  "pointerleave",
  "pointerover",
  "pointerout"
]);
function ke() {
  const e = EventTarget.prototype.addEventListener, t = EventTarget.prototype.removeEventListener, o = /* @__PURE__ */ new WeakMap();
  y(HTMLCanvasElement.prototype, "addEventListener", {
    configurable: !0,
    writable: !0,
    value: function(n, s, i) {
      e.call(this, n, s, i);
      const r = m.get(this);
      if (r && Q.has(n) && s) {
        const a = typeof s == "function" ? s.bind(this) : s;
        o.set(s, a), e.call(r.host, n, a, i);
      }
    }
  }), y(HTMLCanvasElement.prototype, "removeEventListener", {
    configurable: !0,
    writable: !0,
    value: function(n, s, i) {
      t.call(this, n, s, i);
      const r = m.get(this);
      if (r && Q.has(n) && s) {
        const a = o.get(s);
        a && (t.call(r.host, n, a, i), o.delete(s));
      }
    }
  });
}
function y(e, t, o) {
  F.push([e, t, Object.getOwnPropertyDescriptor(e, t)]), Object.defineProperty(e, t, o);
}
function Ne() {
  const e = () => {
    for (const t of m.values()) t.positionHost();
  };
  G(window, "scroll", e, { passive: !0 }), G(window, "resize", e);
}
function G(e, t, o, n) {
  e.addEventListener(t, o, n), q.push([e, t, o, n]);
}
function We() {
  const e = () => {
    D && document.querySelectorAll("canvas[layoutsubtree]").forEach(M);
  };
  document.readyState === "loading" ? G(document, "DOMContentLoaded", e, { once: !0 }) : e(), _ = new MutationObserver((t) => {
    for (const o of t)
      if (o.type === "attributes" && o.attributeName === "layoutsubtree") {
        const n = o.target;
        if (!(n instanceof HTMLCanvasElement)) continue;
        if (n.hasAttribute("layoutsubtree"))
          M(n);
        else {
          const s = m.get(n);
          s && (te(s), m.delete(n));
        }
      } else if (o.type === "childList")
        for (const n of Array.from(o.addedNodes))
          n instanceof HTMLCanvasElement && n.hasAttribute("layoutsubtree") ? M(n) : n instanceof Element && n.querySelectorAll("canvas[layoutsubtree]").forEach(M);
  }), _.observe(document.documentElement, {
    attributes: !0,
    subtree: !0,
    attributeFilter: ["layoutsubtree"],
    childList: !0
  });
}
function M(e) {
  const t = m.get(e);
  if (t) return t;
  if (!e.hasAttribute("layoutsubtree")) return null;
  const o = Be(e), n = /* @__PURE__ */ new Set(), s = /* @__PURE__ */ new Set(), i = [], r = () => {
    const l = e.getBoundingClientRect();
    o.style.left = l.left + window.scrollX + e.clientLeft + "px", o.style.top = l.top + window.scrollY + e.clientTop + "px", o.style.width = e.clientWidth + "px", o.style.height = e.clientHeight + "px";
  }, a = {
    canvas: e,
    host: o,
    children: n,
    dirty: s,
    onpaint: null,
    rafHandle: 0,
    caretBlinkInterval: null,
    positionHost: r,
    observers: i,
    cleanups: []
  };
  return Ue(o, a), m.set(e, a), Fe(a), r(), qe(a), a;
}
function Be(e) {
  const t = document.createElement("div");
  return t.setAttribute("data-html-in-canvas-host", ""), e.className && (t.className = e.className), e.id && t.setAttribute("data-host-of", e.id), t.style.cssText = "position:absolute;left:0;top:0;margin:0;padding:0;pointer-events:auto;transform-style:preserve-3d;", document.body.appendChild(t), t;
}
function Ue(e, t) {
  const o = (i = "hostListener") => {
    for (const r of t.children) t.dirty.add(r);
    k(t, i);
  };
  e.addEventListener("load", (i) => {
    i.target instanceof HTMLImageElement && o("image-load");
  }, !0), e.addEventListener("input", () => o("input"), !0), e.addEventListener("change", () => o("change"), !0);
  const n = () => {
    const i = window.getSelection(), r = i && !i.isCollapsed && i.rangeCount > 0 && e.contains(i.getRangeAt(0).startContainer);
    (e.contains(document.activeElement) || r) && o("selectionchange");
  };
  document.addEventListener("selectionchange", n), t.cleanups.push(() => document.removeEventListener("selectionchange", n)), e.addEventListener("mouseover", (i) => {
    const r = i.target;
    if (r.classList) {
      r.classList.add("pseudo-hover");
      for (const a of z(r, e)) a.classList.add("pseudo-hover");
    }
  }, !0), e.addEventListener("mouseout", (i) => {
    const r = i.target;
    if (r.classList) {
      r.classList.remove("pseudo-hover");
      for (const a of r.querySelectorAll(".pseudo-hover"))
        a.classList.remove("pseudo-hover");
    }
  }, !0), e.addEventListener("focusin", (i) => {
    const r = i.target;
    if (r.classList) {
      r.classList.add("pseudo-focus");
      for (const a of z(r, e)) a.classList.add("pseudo-focus-within");
      try {
        r.matches(":focus-visible") && r.classList.add("pseudo-focus-visible");
      } catch {
      }
      (r instanceof HTMLInputElement || r instanceof HTMLTextAreaElement) && (t.caretBlinkInterval && clearInterval(t.caretBlinkInterval), t.caretBlinkInterval = setInterval(() => o("caret-blink"), 500));
    }
  }, !0), e.addEventListener("focusout", (i) => {
    const r = i.target;
    r.classList && r.classList.remove("pseudo-focus", "pseudo-focus-visible");
    for (const a of e.querySelectorAll(".pseudo-focus-within"))
      a.classList.remove("pseudo-focus-within");
    t.caretBlinkInterval && (clearInterval(t.caretBlinkInterval), t.caretBlinkInterval = null, o("caret-remove"));
  }, !0), e.addEventListener("pointerdown", (i) => {
    const r = i.target;
    if (r.classList) {
      r.classList.add("pseudo-active");
      for (const a of z(r, e)) a.classList.add("pseudo-active");
    }
  }, !0);
  const s = () => {
    for (const i of e.querySelectorAll(".pseudo-active"))
      i.classList.remove("pseudo-active");
  };
  e.addEventListener("pointerup", s, !0), e.addEventListener("pointercancel", s, !0);
}
function z(e, t) {
  const o = [];
  let n = e.parentElement;
  for (; n && n !== t; )
    o.push(n), n = n.parentElement;
  return o;
}
const ze = Object.getOwnPropertyDescriptor(Element.prototype, "children").get;
function Fe(e) {
  for (const t of Array.from(ze.call(e.canvas)))
    j(e, t);
}
function qe(e) {
  const t = new ResizeObserver(() => {
    e.positionHost();
    for (const n of e.children) e.dirty.add(n);
    k(e, "ResizeObserver");
  });
  t.observe(e.canvas), e.observers.push(t);
  const o = new MutationObserver((n) => {
    let s = !1;
    for (const i of n) {
      let r = i.target;
      for (; r && !(r instanceof HTMLElement && e.children.has(r)); ) r = r.parentNode;
      r && (e.dirty.add(r), s = !0);
    }
    s && k(e, "MutationObserver");
  });
  o.observe(e.host, { childList: !0, subtree: !0, attributes: !0, characterData: !0 }), e.observers.push(o);
}
function te(e) {
  e.rafHandle && (cancelAnimationFrame(e.rafHandle), e.rafHandle = 0), e.caretBlinkInterval && (clearInterval(e.caretBlinkInterval), e.caretBlinkInterval = null);
  for (const o of e.cleanups) o();
  e.cleanups.length = 0;
  for (const o of e.observers) o.disconnect();
  e.observers.length = 0, e.dirty.clear(), e.onpaint = null;
  const t = ["pseudo-hover", "pseudo-focus", "pseudo-focus-visible", "pseudo-focus-within", "pseudo-active"];
  for (const o of Array.from(e.children)) {
    o.classList.remove(...t);
    for (const n of o.querySelectorAll(".pseudo-hover, .pseudo-focus, .pseudo-focus-visible, .pseudo-focus-within, .pseudo-active"))
      n.classList.remove(...t);
    ee(e, o), Node.prototype.appendChild.call(e.canvas, o);
  }
  e.host.remove();
}
const je = typeof location < "u" && new URLSearchParams(location.search).has("debugPolyfillHIC");
function k(e, t) {
  je && t && console.trace("[html-in-canvas debug] schedulePaint from:", t), !e.rafHandle && (e.rafHandle = requestAnimationFrame(async () => {
    var s;
    if (e.rafHandle = 0, !m.has(e.canvas)) return;
    e.positionHost();
    const o = Array.from(e.dirty);
    if (e.dirty.clear(), o.length && await Promise.all(o.map(Ge)), !m.has(e.canvas)) return;
    const n = new Event("paint");
    n.changedElements = o;
    try {
      (s = e.onpaint) == null || s.call(e.canvas, n);
    } catch (i) {
      console.error("[html-in-canvas polyfill] onpaint threw", i);
    }
    e.canvas.dispatchEvent(n);
  }));
}
async function Ge(e) {
  try {
    await C.update(e);
  } catch (t) {
    console.error(
      `[html-in-canvas polyfill] rasterize failed for ${Ye(e)}:`,
      t instanceof Error ? t.message + `
` + t.stack : t
    );
  }
}
function Ye(e) {
  const t = e.tagName.toLowerCase(), o = e.id ? `#${e.id}` : "", n = e.getAttribute("class") || "", s = n ? `.${n.trim().replace(/\s+/g, ".")}` : "";
  return `<${t}${o}${s}>`;
}
export {
  Ve as getHtmlRenderer,
  Qe as installHtmlInCanvasPolyfill,
  Te as uninstallHtmlInCanvasPolyfill
};
//# sourceMappingURL=polyfill.mjs.map
