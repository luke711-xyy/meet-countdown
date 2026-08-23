const STYLES = new Set(['neon']);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const BRUSH_PROFILES = {
  neon: { glowWidth: 18, middleWidth: 8, coreWidth: 2.2 },
};
const MAX_CLIENT_POINTS = 480;

function validPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

function validStroke(stroke) {
  return stroke && typeof stroke.id === 'string' && STYLES.has(stroke.style) && COLOR_PATTERN.test(stroke.color) && Array.isArray(stroke.points) && stroke.points.length >= 2 && stroke.points.every(validPoint);
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function normalizeStroke(stroke) {
  if (!stroke || typeof stroke !== 'object') return stroke;
  return stroke.style === 'fireworks' ? { ...stroke, style: 'neon' } : stroke;
}

export class DoodleCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.staticCanvas = document.createElement('canvas');
    this.staticContext = this.staticCanvas.getContext('2d');
    this.strokes = new Map();
    this.previews = new Map();
    this.activeStroke = null;
    this.authorId = '';
    this.color = '#8be9fd';
    this.style = 'neon';
    this.staticDirty = true;
    this.renderScheduled = false;
    this.renderFrame = 0;
    this.revision = 0;
    this.resize = this.resize.bind(this);
    this.render = this.render.bind(this);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    window.addEventListener('resize', this.resize, { passive: true });
    this.resize();
    this.requestRender();
  }

  configure({ color, style, authorId } = {}) {
    if (COLOR_PATTERN.test(color || '')) this.color = color;
    if (STYLES.has(style)) this.style = style;
    if (typeof authorId === 'string') this.authorId = authorId;
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || document.documentElement.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.round(rect.height || document.documentElement.clientHeight || window.innerHeight));
    const backingWidth = Math.round(width * ratio);
    const backingHeight = Math.round(height * ratio);
    const changed = this.width !== width || this.height !== height || this.canvas.width !== backingWidth || this.canvas.height !== backingHeight;
    if (!changed) return false;
    this.canvas.width = backingWidth;
    this.canvas.height = backingHeight;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.staticCanvas.width = this.canvas.width;
    this.staticCanvas.height = this.canvas.height;
    this.staticContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.width = width;
    this.height = height;
    this.staticDirty = true;
    this.requestRender();
    return true;
  }

  syncViewport() {
    this.resize();
    return { width: this.width, height: this.height };
  }

  hydrate(strokes = [], authorId = this.authorId) {
    this.authorId = authorId || this.authorId;
    this.strokes.clear();
    this.previews.clear();
    strokes.map(normalizeStroke).filter(validStroke).forEach((stroke) => this.strokes.set(stroke.id, { ...stroke, preview: false }));
    this.staticDirty = true;
    this.requestRender();
  }

  add(stroke) {
    stroke = normalizeStroke(stroke);
    if (!validStroke(stroke)) return false;
    this.previews.delete(stroke.id);
    this.strokes.set(stroke.id, { ...stroke, preview: false });
    this.staticDirty = true;
    this.requestRender();
    return true;
  }

  applyPreview({ id, phase = 'point', x, y, style, color, actorId, createdAt }) {
    if (!id || actorId === this.authorId || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const existing = this.previews.get(id);
    const points = phase === 'start' || !existing ? [{ x, y }] : [...existing.points, { x, y }];
    this.previews.set(id, { id, authorId: actorId, style: 'neon', color, points, createdAt: createdAt || new Date().toISOString(), preview: true });
    this.requestRender();
  }

  remove(id) {
    this.strokes.delete(id);
    this.previews.delete(id);
    this.staticDirty = true;
    this.requestRender();
  }

  clear() {
    this.strokes.clear();
    this.previews.clear();
    this.activeStroke = null;
    this.staticDirty = true;
    this.requestRender();
  }

  beginDraw(point) {
    if (!validPoint(point)) return null;
    const stroke = { id: `doodle_${crypto.randomUUID()}`, authorId: this.authorId, style: this.style, color: this.color, points: [point], createdAt: new Date().toISOString(), preview: true };
    this.activeStroke = stroke;
    this.previews.set(stroke.id, stroke);
    this.requestRender();
    return stroke;
  }

  appendDraw(point) {
    if (!this.activeStroke || !validPoint(point)) return null;
    const points = this.activeStroke.points;
    const last = points[points.length - 1];
    const distance = Math.hypot((point.x - last.x) * this.width, (point.y - last.y) * this.height);
    if (distance < 4) return null;
    if (points.length < MAX_CLIENT_POINTS) {
      points.push(point);
    } else {
      const compacted = points.filter((_current, index) => index % 2 === 0);
      compacted.push(point);
      this.activeStroke.points = compacted;
    }
    this.previews.set(this.activeStroke.id, this.activeStroke);
    this.requestRender();
    return point;
  }

  finishDraw() {
    const stroke = this.activeStroke;
    this.activeStroke = null;
    if (!stroke || stroke.points.length < 2) {
      if (stroke) this.previews.delete(stroke.id);
      return null;
    }
    this.previews.delete(stroke.id);
    const points = stroke.points.length > MAX_CLIENT_POINTS
      ? stroke.points.filter((_current, index) => index % Math.ceil(stroke.points.length / MAX_CLIENT_POINTS) === 0)
      : stroke.points;
    const completed = { ...stroke, points, preview: false };
    this.strokes.set(stroke.id, completed);
    this.staticDirty = true;
    this.requestRender();
    return completed;
  }

  cancelDraw() {
    if (this.activeStroke) this.previews.delete(this.activeStroke.id);
    this.activeStroke = null;
    this.requestRender();
  }

  beginErase() {
    this.activeStroke = null;
  }

  eraseAt(point, authorId, onErase) {
    if (!validPoint(point)) return;
    for (const [id, stroke] of this.strokes) {
      if (stroke.authorId !== authorId || !Array.isArray(stroke.points)) continue;
      const hit = stroke.points.some((current, index) => index === 0
        ? Math.hypot((point.x - current.x) * this.width, (point.y - current.y) * this.height) < 18
        : distanceToSegment({ x: point.x * this.width, y: point.y * this.height }, { x: stroke.points[index - 1].x * this.width, y: stroke.points[index - 1].y * this.height }, { x: current.x * this.width, y: current.y * this.height }) < 18);
      if (hit) {
        this.strokes.delete(id);
        if (typeof onErase === 'function') onErase(id, { ...stroke, points: stroke.points.map((point) => ({ ...point })), preview: false });
      }
    }
  }

  requestRender() {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    this.renderFrame = requestAnimationFrame(this.render);
  }

  flush() {
    if (this.renderScheduled) cancelAnimationFrame(this.renderFrame);
    this.renderScheduled = false;
    this.render();
  }

  rebuildStaticLayer() {
    const ctx = this.staticContext;
    ctx.clearRect(0, 0, this.width, this.height);
    for (const stroke of this.strokes.values()) this.drawTrail(ctx, stroke, 1);
    this.staticDirty = false;
  }

  render() {
    this.renderScheduled = false;
    const ctx = this.context;
    if (this.staticDirty) this.rebuildStaticLayer();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this.staticCanvas, 0, 0, this.canvas.width, this.canvas.height, 0, 0, this.width, this.height);
    for (const stroke of this.previews.values()) {
      if (stroke.points.length < 2) continue;
      this.drawStroke(ctx, stroke, 0.82);
    }
    this.revision += 1;
    this.canvas.dispatchEvent(new Event('doodle-render'));
    if (this.previews.size) this.requestRender();
  }

  pixelPoints(stroke) {
    return stroke.points.map((point) => ({ x: point.x * this.width, y: point.y * this.height }));
  }

  drawTrail(ctx, stroke, opacity) {
    const points = this.pixelPoints(stroke);
    if (points.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.color;
    const profile = BRUSH_PROFILES[stroke.style] || BRUSH_PROFILES.neon;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index].x, points[index].y);
      ctx.stroke();
    };
    ctx.globalAlpha = opacity * 0.2; ctx.lineWidth = profile.glowWidth; ctx.shadowBlur = 28; ctx.shadowColor = stroke.color; path();
    ctx.globalAlpha = opacity * 0.55; ctx.lineWidth = profile.middleWidth; ctx.shadowBlur = 14; ctx.shadowColor = stroke.color; path();
    ctx.globalAlpha = opacity; ctx.lineWidth = profile.coreWidth; ctx.shadowBlur = 5; ctx.shadowColor = stroke.color; path();
    ctx.restore();
  }

  drawStroke(ctx, stroke, opacity) {
    const points = this.pixelPoints(stroke);
    this.drawTrail(ctx, stroke, opacity);
  }
}
