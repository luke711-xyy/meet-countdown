const STYLES = new Set(['neon']);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const BRUSH_PROFILES = {
  neon: { glowWidth: 18, middleWidth: 8, coreWidth: 2.2 },
};
const MAX_CLIENT_POINTS = 480;
const STATIC_TILE_SIZE = 256;
const STROKE_BOUNDS_PADDING = 38;

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
    this.tiles = new Map();
    this.strokeCache = new Map();
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
    this.tiles.clear();
    this.strokeCache.clear();
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
    this.tiles.clear();
    this.strokeCache.clear();
    strokes.map(normalizeStroke).filter(validStroke).forEach((stroke) => this.strokes.set(stroke.id, { ...stroke, preview: false }));
    this.staticDirty = true;
    this.requestRender();
  }

  add(stroke) {
    stroke = normalizeStroke(stroke);
    if (!validStroke(stroke)) return false;
    const previous = this.strokes.get(stroke.id);
    const affectedTiles = new Set();
    if (previous && !this.staticDirty) this.removeStrokeFromTiles(previous, affectedTiles);
    this.previews.delete(stroke.id);
    this.strokes.set(stroke.id, { ...stroke, preview: false });
    if (!this.staticDirty) {
      this.paintStrokeIntoTiles(this.strokes.get(stroke.id), affectedTiles);
      this.redrawTiles(affectedTiles);
    }
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
    const stroke = this.strokes.get(id);
    this.strokes.delete(id);
    this.previews.delete(id);
    if (stroke && !this.staticDirty) {
      const affectedTiles = new Set();
      this.removeStrokeFromTiles(stroke, affectedTiles);
      this.redrawTiles(affectedTiles);
    }
    this.requestRender();
  }

  clear() {
    this.strokes.clear();
    this.previews.clear();
    this.activeStroke = null;
    this.tiles.clear();
    this.strokeCache.clear();
    this.staticContext.clearRect(0, 0, this.width, this.height);
    this.staticDirty = false;
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
    if (!this.staticDirty) {
      const affectedTiles = new Set();
      this.paintStrokeIntoTiles(completed, affectedTiles);
      this.redrawTiles(affectedTiles);
    }
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
    const removed = [];
    for (const [id, stroke] of this.strokes) {
      if (stroke.authorId !== authorId || !Array.isArray(stroke.points)) continue;
      const cache = this.getStrokeCache(stroke);
      const hit = cache.bounds && point.x * this.width >= cache.bounds.left - 18 && point.x * this.width <= cache.bounds.right + 18
        && point.y * this.height >= cache.bounds.top - 18 && point.y * this.height <= cache.bounds.bottom + 18
        && cache.pixelPoints.some((current, index) => index === 0
          ? Math.hypot(point.x * this.width - current.x, point.y * this.height - current.y) < 18
          : distanceToSegment({ x: point.x * this.width, y: point.y * this.height }, cache.pixelPoints[index - 1], current) < 18);
      if (hit) {
        this.strokes.delete(id);
        removed.push(stroke);
      }
    }
    if (!this.staticDirty) {
      const affectedTiles = new Set();
      removed.forEach((stroke) => this.removeStrokeFromTiles(stroke, affectedTiles));
      this.redrawTiles(affectedTiles);
    }
    if (typeof onErase === 'function') {
      removed.forEach((stroke) => onErase(stroke.id, { ...stroke, points: stroke.points.map((point) => ({ ...point })), preview: false }));
    }
    if (removed.length) this.requestRender();
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
    this.staticContext.clearRect(0, 0, this.width, this.height);
    this.tiles.clear();
    for (const stroke of this.strokes.values()) this.registerStrokeInTiles(stroke);
    this.redrawTiles(this.tiles.keys());
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

  getStrokeCache(stroke) {
    const cached = this.strokeCache.get(stroke.id);
    if (cached && cached.width === this.width && cached.height === this.height && cached.pointCount === stroke.points.length && cached.pointsRef === stroke.points) return cached;

    const pixelPoints = stroke.points.map((point) => ({ x: point.x * this.width, y: point.y * this.height }));
    const profile = BRUSH_PROFILES[stroke.style] || BRUSH_PROFILES.neon;
    const padding = Math.max(STROKE_BOUNDS_PADDING, profile.glowWidth / 2 + 32);
    const bounds = pixelPoints.reduce((result, point) => ({
      left: Math.min(result.left, point.x),
      right: Math.max(result.right, point.x),
      top: Math.min(result.top, point.y),
      bottom: Math.max(result.bottom, point.y),
    }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
    bounds.left = Math.max(0, bounds.left - padding);
    bounds.right = Math.min(this.width, bounds.right + padding);
    bounds.top = Math.max(0, bounds.top - padding);
    bounds.bottom = Math.min(this.height, bounds.bottom + padding);

    let path = null;
    if (typeof Path2D === 'function' && pixelPoints.length >= 2) {
      path = new Path2D();
      path.moveTo(pixelPoints[0].x, pixelPoints[0].y);
      for (let index = 1; index < pixelPoints.length; index += 1) path.lineTo(pixelPoints[index].x, pixelPoints[index].y);
    }
    const cacheEntry = {
      width: this.width,
      height: this.height,
      pointCount: stroke.points.length,
      pointsRef: stroke.points,
      pixelPoints,
      bounds,
      path,
      tileKeys: this.tileKeysForBounds(bounds),
    };
    this.strokeCache.set(stroke.id, cacheEntry);
    return cacheEntry;
  }

  tileKeysForBounds(bounds) {
    if (!bounds || !Number.isFinite(bounds.left)) return [];
    const firstColumn = Math.floor(bounds.left / STATIC_TILE_SIZE);
    const lastColumn = Math.floor(Math.max(bounds.left, bounds.right - 0.001) / STATIC_TILE_SIZE);
    const firstRow = Math.floor(bounds.top / STATIC_TILE_SIZE);
    const lastRow = Math.floor(Math.max(bounds.top, bounds.bottom - 0.001) / STATIC_TILE_SIZE);
    const keys = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) keys.push(`${column}:${row}`);
    }
    return keys;
  }

  getTile(key) {
    const [column, row] = key.split(':').map(Number);
    const x = column * STATIC_TILE_SIZE;
    const y = row * STATIC_TILE_SIZE;
    const width = Math.min(STATIC_TILE_SIZE, this.width - x);
    const height = Math.min(STATIC_TILE_SIZE, this.height - y);
    if (width <= 0 || height <= 0) return null;
    let tile = this.tiles.get(key);
    if (tile) return tile;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    tile = { key, x, y, width, height, canvas, context, strokeIds: new Set() };
    this.tiles.set(key, tile);
    return tile;
  }

  registerStrokeInTiles(stroke) {
    const cache = this.getStrokeCache(stroke);
    cache.tileKeys.forEach((key) => this.getTile(key)?.strokeIds.add(stroke.id));
  }

  removeStrokeFromTiles(stroke, affectedTiles = new Set()) {
    const cache = this.getStrokeCache(stroke);
    cache.tileKeys.forEach((key) => {
      const tile = this.tiles.get(key);
      if (tile?.strokeIds.delete(stroke.id)) affectedTiles.add(key);
    });
    this.strokeCache.delete(stroke.id);
    return affectedTiles;
  }

  paintStrokeIntoTiles(stroke, affectedTiles = new Set()) {
    const cache = this.getStrokeCache(stroke);
    cache.tileKeys.forEach((key) => {
      this.getTile(key)?.strokeIds.add(stroke.id);
      affectedTiles.add(key);
    });
    return affectedTiles;
  }

  redrawTiles(keys) {
    for (const key of keys) {
      const tile = this.tiles.get(key);
      if (!tile) continue;
      tile.context.clearRect(0, 0, tile.width, tile.height);
      for (const id of tile.strokeIds) {
        const stroke = this.strokes.get(id);
        if (stroke) this.drawTrail(tile.context, stroke, 1, tile.x, tile.y);
      }
      this.staticContext.clearRect(tile.x, tile.y, tile.width, tile.height);
      this.staticContext.drawImage(tile.canvas, 0, 0, tile.canvas.width, tile.canvas.height, tile.x, tile.y, tile.width, tile.height);
    }
  }

  drawTrail(ctx, stroke, opacity, offsetX = 0, offsetY = 0) {
    const cache = this.getStrokeCache(stroke);
    const points = cache.pixelPoints;
    if (points.length < 2) return;
    ctx.save();
    ctx.translate(-offsetX, -offsetY);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.color;
    const profile = BRUSH_PROFILES[stroke.style] || BRUSH_PROFILES.neon;
    const drawPath = () => {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index].x, points[index].y);
      ctx.stroke();
    };
    const path = cache.path;
    const strokePath = () => path ? ctx.stroke(path) : drawPath();
    ctx.globalAlpha = opacity * 0.2; ctx.lineWidth = profile.glowWidth; ctx.shadowBlur = 28; ctx.shadowColor = stroke.color; strokePath();
    ctx.globalAlpha = opacity * 0.55; ctx.lineWidth = profile.middleWidth; ctx.shadowBlur = 14; ctx.shadowColor = stroke.color; strokePath();
    ctx.globalAlpha = opacity; ctx.lineWidth = profile.coreWidth; ctx.shadowBlur = 5; ctx.shadowColor = stroke.color; strokePath();
    ctx.restore();
  }

  drawStroke(ctx, stroke, opacity) {
    this.drawTrail(ctx, stroke, opacity);
  }
}
