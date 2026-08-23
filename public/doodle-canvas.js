const STYLES = new Set(['neon', 'fireworks']);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const BRUSH_PROFILES = {
  neon: { glowWidth: 18, middleWidth: 8, coreWidth: 2.2 },
  fireworks: { glowWidth: 18, middleWidth: 4, coreWidth: 2.2 },
};

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

function seedFrom(value) {
  let seed = 2166136261;
  for (let index = 0; index < value.length; index += 1) seed = Math.imul(seed ^ value.charCodeAt(index), 16777619);
  return () => {
    seed += seed << 13; seed ^= seed >>> 7; seed += seed << 3; seed ^= seed >>> 17; seed += seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };
}

export class DoodleCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.strokes = new Map();
    this.previews = new Map();
    this.activeStroke = null;
    this.authorId = '';
    this.color = '#8be9fd';
    this.style = 'neon';
    this.resize = this.resize.bind(this);
    this.render = this.render.bind(this);
    window.addEventListener('resize', this.resize, { passive: true });
    this.resize();
    requestAnimationFrame(this.render);
  }

  configure({ color, style, authorId } = {}) {
    if (COLOR_PATTERN.test(color || '')) this.color = color;
    if (STYLES.has(style)) this.style = style;
    if (typeof authorId === 'string') this.authorId = authorId;
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.width = width;
    this.height = height;
  }

  hydrate(strokes = [], authorId = this.authorId) {
    this.authorId = authorId || this.authorId;
    this.strokes.clear();
    this.previews.clear();
    strokes.filter(validStroke).forEach((stroke) => this.strokes.set(stroke.id, { ...stroke, preview: false }));
  }

  add(stroke) {
    if (!validStroke(stroke)) return false;
    this.previews.delete(stroke.id);
    this.strokes.set(stroke.id, { ...stroke, preview: false });
    return true;
  }

  applyPreview({ id, phase = 'point', x, y, style, color, actorId, createdAt }) {
    if (!id || actorId === this.authorId || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const existing = this.previews.get(id);
    const points = phase === 'start' || !existing ? [{ x, y }] : [...existing.points, { x, y }];
    this.previews.set(id, { id, authorId: actorId, style, color, points, createdAt: createdAt || new Date().toISOString(), preview: true });
  }

  remove(id) {
    this.strokes.delete(id);
    this.previews.delete(id);
  }

  clear() {
    this.strokes.clear();
    this.previews.clear();
    this.activeStroke = null;
  }

  beginDraw(point) {
    if (!validPoint(point)) return null;
    const stroke = { id: `doodle_${crypto.randomUUID()}`, authorId: this.authorId, style: this.style, color: this.color, points: [point], createdAt: new Date().toISOString(), preview: true };
    this.activeStroke = stroke;
    this.previews.set(stroke.id, stroke);
    return stroke;
  }

  appendDraw(point) {
    if (!this.activeStroke || !validPoint(point)) return null;
    const points = this.activeStroke.points;
    const last = points[points.length - 1];
    const distance = Math.hypot((point.x - last.x) * this.width, (point.y - last.y) * this.height);
    if (distance < 4) return null;
    points.push(point);
    this.previews.set(this.activeStroke.id, this.activeStroke);
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
    this.strokes.set(stroke.id, { ...stroke, preview: false });
    return { ...stroke, preview: false };
  }

  cancelDraw() {
    if (this.activeStroke) this.previews.delete(this.activeStroke.id);
    this.activeStroke = null;
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
        if (typeof onErase === 'function') onErase(id);
      }
    }
  }

  render() {
    const now = Date.now();
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);
    const all = [...this.strokes.values(), ...this.previews.values()];
    for (const stroke of all) {
      if (stroke.points.length < 2) continue;
      const opacity = stroke.preview ? 0.82 : 1;
      this.drawStroke(ctx, stroke, opacity, now);
    }
    requestAnimationFrame(this.render);
  }

  drawStroke(ctx, stroke, opacity, now) {
    const points = stroke.points.map((point) => ({ x: point.x * this.width, y: point.y * this.height }));
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
    if (stroke.style === 'fireworks') {
      ctx.globalAlpha = opacity * 0.34; ctx.lineWidth = profile.glowWidth; ctx.shadowBlur = 24; ctx.shadowColor = stroke.color; path();
      ctx.globalAlpha = opacity * 0.88; ctx.lineWidth = profile.middleWidth; ctx.shadowBlur = 10; path();
      ctx.globalAlpha = opacity; ctx.lineWidth = profile.coreWidth; ctx.shadowBlur = 4; path();
      this.drawSparks(ctx, stroke, points, opacity, now);
    } else {
      ctx.globalAlpha = opacity * 0.2; ctx.lineWidth = profile.glowWidth; ctx.shadowBlur = 28; ctx.shadowColor = stroke.color; path();
      ctx.globalAlpha = opacity * 0.55; ctx.lineWidth = profile.middleWidth; ctx.shadowBlur = 14; ctx.shadowColor = stroke.color; path();
      ctx.globalAlpha = opacity; ctx.lineWidth = profile.coreWidth; ctx.shadowBlur = 5; ctx.shadowColor = stroke.color; path();
    }
    ctx.restore();
  }

  drawSparks(ctx, stroke, points, opacity, now) {
    const random = seedFrom(stroke.id);
    const elapsed = Math.max(0, now - new Date(stroke.createdAt).getTime());
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    const sampleStep = Math.max(1, Math.ceil(points.length / 120));
    for (let index = 1; index < points.length; index += sampleStep) {
      const point = points[index];
      const count = 8 + Math.floor(random() * 6);
      for (let spark = 0; spark < count; spark += 1) {
        const angle = random() * Math.PI * 2;
        const phase = (elapsed / 1050 + random() * 0.65) % 1;
        const length = (7 + random() * 17) * (1 - phase * 0.82);
        ctx.globalAlpha = opacity * (0.34 + (1 - phase) * 0.56);
        ctx.lineWidth = 1.1 + random() * 1.4;
        ctx.shadowBlur = 9;
        ctx.shadowColor = stroke.color;
        ctx.beginPath();
        ctx.moveTo(point.x + Math.cos(angle) * length * 0.18, point.y + Math.sin(angle) * length * 0.18);
        ctx.lineTo(point.x + Math.cos(angle) * length, point.y + Math.sin(angle) * length);
        ctx.stroke();
      }
      ctx.globalAlpha = opacity * 0.72;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1.5 + random() * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
