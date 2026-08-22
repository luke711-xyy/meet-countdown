var E = Object.defineProperty;
var v = (c, e, s) => e in c ? E(c, e, { enumerable: !0, configurable: !0, writable: !0, value: s }) : c[e] = s;
var o = (c, e, s) => v(c, typeof e != "symbol" ? e + "" : e, s);
import * as m from "three";
import { Matrix4 as d, Vector3 as y, Texture as x, Mesh as R } from "three";
/**
 * @license
 * three-html-render v0.1.2
 * Copyright 2025-2026 repalash <palash@shaders.app>
 * MIT License
 * See ./dependencies.txt for bundled third-party dependencies and licenses.
 */
const T = new d(), u = new d(), f = new d(), _ = new y();
class b {
  constructor() {
    o(this, "objects", []);
    o(this, "canvas", null);
    o(this, "camera", null);
    o(this, "_cachedCssW", -1);
    o(this, "_cachedCssH", -1);
  }
  connect(e, s) {
    this.canvas = e, this.camera = s;
  }
  add(e, s) {
    const n = { element: e, mesh: s };
    return this.objects.indexOf(n) === -1 && this.objects.push(n), n;
  }
  remove(e) {
    const s = this.objects.indexOf(e);
    s !== -1 && this.objects.splice(s, 1);
  }
  update() {
    const e = this.canvas, s = this.camera;
    if (!e || !s) return;
    const n = e.clientWidth, a = e.clientHeight;
    (n !== this._cachedCssW || a !== this._cachedCssH) && (f.set(
      n / 2,
      0,
      0,
      n / 2,
      0,
      -a / 2,
      0,
      a / 2,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1
    ), this._cachedCssW = n, this._cachedCssH = a);
    for (const i of this.objects) {
      const { element: t, mesh: r } = i;
      t.style.position = "absolute", t.style.left = "0", t.style.top = "0", t.style.transformOrigin = "0 0";
      const h = t.offsetWidth, p = t.offsetHeight;
      if (h <= 0 || p <= 0) continue;
      const l = r.geometry;
      l && (l.boundingBox || l.computeBoundingBox(), l.boundingBox.getSize(_), T.set(
        _.x / h,
        0,
        0,
        -_.x / 2,
        0,
        -_.y / p,
        0,
        _.y / 2,
        0,
        0,
        1,
        l.boundingBox.max.z,
        0,
        0,
        0,
        1
      ), u.multiplyMatrices(s.projectionMatrix, s.matrixWorldInverse), u.multiply(r.matrixWorld), u.multiply(T), u.premultiply(f), t.style.transform = "matrix3d(" + u.elements.join(",") + ")");
    }
  }
  disconnect() {
    this.canvas = null, this.camera = null, this._cachedCssW = -1, this._cachedCssH = -1;
  }
}
const g = "HTMLTexture" in m ? m.HTMLTexture : null;
class H {
  constructor() {
    o(this, "overlayRenderer");
    o(this, "selectionOpacity", 0);
    o(this, "_textures", /* @__PURE__ */ new WeakMap());
    o(this, "_renderer", null);
    o(this, "_canvas", null);
    this.overlayRenderer = new b(), window.__HTML_IN_CANVAS_POLYFILL__ && document.addEventListener("selectionchange", () => {
      const e = window.getSelection(), s = !!e && !e.isCollapsed;
      for (const { element: n } of this.overlayRenderer.objects)
        s && e.containsNode(n, !0) ? n.style.opacity = this.selectionOpacity.toString() : n.style.opacity = "0";
    });
  }
  connect(e, s, n) {
    this.overlayRenderer.connect(e, s), this._renderer = n, this._canvas = e, e.onpaint = () => {
      this._uploadTextures();
    };
  }
  addObject(e, s) {
    e.style.pointerEvents = "auto";
    for (const n of ["pointerdown", "pointerup", "pointermove", "click", "wheel"])
      e.addEventListener(n, (a) => a.stopPropagation());
    return e.addEventListener("scroll", () => {
      this._canvas && this._canvas.requestPaint();
    }), this.overlayRenderer.add(e, s);
  }
  update() {
    this._canvas && this._canvas.requestPaint(), this.overlayRenderer.update();
  }
  _uploadTextures() {
    const e = this._renderer, s = this._canvas;
    if (!(!e || !s))
      for (const { element: n, mesh: a } of this.overlayRenderer.objects) {
        let i = this._textures.get(n);
        if (g) {
          i || (i = new g(n), this._textures.set(n, i), this._assignTexture(a, i));
          continue;
        }
        const t = e.getContext();
        if ("texElementImage2D" in t) {
          i || (i = new x(), i.minFilter = 1006, i.generateMipmaps = !1, this._textures.set(n, i), this._assignTexture(a, i));
          const r = e.properties.get(i);
          r.__webglTexture || (r.__webglTexture = t.createTexture()), t.bindTexture(t.TEXTURE_2D, r.__webglTexture), t.texElementImage2D(t.TEXTURE_2D, 0, t.RGBA, t.RGBA, t.UNSIGNED_BYTE, n), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MIN_FILTER, t.LINEAR), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_S, t.CLAMP_TO_EDGE), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_T, t.CLAMP_TO_EDGE), r.__version = i.version;
        } else {
          let r;
          try {
            r = s.captureElementImage(n);
          } catch {
            continue;
          }
          if (!r) continue;
          i ? i.image = r : (i = new x(r), i.minFilter = 1006, i.generateMipmaps = !1, this._textures.set(n, i), this._assignTexture(a, i)), i.needsUpdate = !0;
        }
      }
  }
  _assignTexture(e, s) {
    e instanceof R && e.material && (e.material.map = s, e.material.needsUpdate = !0);
  }
  getTexture(e) {
    return this._textures.get(e) ?? null;
  }
}
export {
  H as ThreeHTMLRenderer
};
//# sourceMappingURL=renderer.js.map
