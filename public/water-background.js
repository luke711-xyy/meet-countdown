import * as THREE from '/vendor/three.module.js';

const SIM_SIZE = 256;
const MAX_IMPULSES = 32;

const passthroughVertex = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const simulationFragment = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uState;
  uniform vec2 uTexel;
  uniform vec3 uImpulses[${MAX_IMPULSES}];
  uniform int uImpulseCount;

  void main() {
    vec4 previous = texture2D(uState, vUv);
    float left = texture2D(uState, vUv - vec2(uTexel.x, 0.0)).r;
    float right = texture2D(uState, vUv + vec2(uTexel.x, 0.0)).r;
    float down = texture2D(uState, vUv - vec2(0.0, uTexel.y)).r;
    float up = texture2D(uState, vUv + vec2(0.0, uTexel.y)).r;
    float laplacian = left + right + down + up - previous.r * 4.0;
    float velocity = (previous.g + laplacian * 0.18) * 0.992;
    float height = (previous.r + velocity) * 0.994;

    for (int i = 0; i < ${MAX_IMPULSES}; i++) {
      if (i >= uImpulseCount) break;
      vec3 impulse = uImpulses[i];
      float distanceToPointer = distance(vUv, impulse.xy);
      float ring = exp(-distanceToPointer * distanceToPointer / 0.0018);
      height += ring * impulse.z;
      velocity += ring * impulse.z * 0.08;
    }

    gl_FragColor = vec4(height, velocity, 0.0, 1.0);
  }
`;

const backgroundFragment = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform sampler2D uDoodle;
  uniform sampler2D uRipple;
  uniform vec2 uRippleTexel;
  uniform vec2 uImageAspect;
  uniform float uViewportAspect;
  uniform float uDisplacement;
  uniform float uContrast;
  uniform float uBrightness;
  uniform float uDoodleOpacity;

  vec2 coverUv(vec2 uv) {
    float viewportRatio = uViewportAspect;
    float imageRatio = uImageAspect.x / uImageAspect.y;
    vec2 result = uv;
    if (viewportRatio > imageRatio) {
      float crop = imageRatio / viewportRatio;
      result.y = (uv.y - 0.5) * crop + 0.5;
    } else {
      float crop = viewportRatio / imageRatio;
      result.x = (uv.x - 0.5) * crop + 0.5;
    }
    return result;
  }

  void main() {
    vec2 rippleUv = vUv;
    float center = texture2D(uRipple, rippleUv).r;
    float horizontal = texture2D(uRipple, rippleUv + vec2(uRippleTexel.x, 0.0)).r - texture2D(uRipple, rippleUv - vec2(uRippleTexel.x, 0.0)).r;
    float vertical = texture2D(uRipple, rippleUv + vec2(0.0, uRippleTexel.y)).r - texture2D(uRipple, rippleUv - vec2(0.0, uRippleTexel.y)).r;
    vec2 photoUv = coverUv(vUv) + vec2(horizontal, vertical) * uDisplacement;
    photoUv += center * vec2(0.0007, -0.0007);
    vec3 photo = texture2D(uMap, clamp(photoUv, 0.001, 0.999)).rgb;
    photo = clamp(vec3(0.5) + (photo - vec3(0.5)) * uContrast, 0.0, 1.0);
    photo = clamp(photo * uBrightness, 0.0, 1.0);
    vec2 doodleUv = clamp(vUv + vec2(horizontal, vertical) * uDisplacement, 0.001, 0.999);
    vec4 doodle = texture2D(uDoodle, doodleUv);
    float doodleAlpha = clamp(doodle.a * uDoodleOpacity, 0.0, 1.0);
    vec3 composited = mix(photo, doodle.rgb, doodleAlpha);
    gl_FragColor = vec4(composited, 1.0);
  }
`;

export class WaterBackground {
  constructor(canvas, doodleCanvas) {
    this.canvas = canvas;
    this.doodleCanvas = doodleCanvas;
    this.renderer = null;
    this.map = null;
    this.doodleTexture = null;
    this.doodleRevision = -1;
    this.mapAspect = 1;
    this.ready = false;
    this.impulses = [];
    this.frame = 0;
    this.lastTime = 0;
    this.simulation = null;
    this.background = null;
    this.contrast = 1;
    this.brightness = 1;
    this.imageRequest = 0;
    this.resizeObserver = new ResizeObserver(() => this.resize());
  }

  async init() {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: false, powerPreference: 'high-performance' });
      if (!this.renderer.capabilities.isWebGL2) throw new Error('WebGL2 is required for the ripple field.');
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.doodleTexture = new THREE.CanvasTexture(this.doodleCanvas);
      this.doodleTexture.colorSpace = THREE.SRGBColorSpace;
      this.doodleTexture.minFilter = THREE.LinearFilter;
      this.doodleTexture.magFilter = THREE.LinearFilter;
      this.doodleTexture.wrapS = THREE.ClampToEdgeWrapping;
      this.doodleTexture.wrapT = THREE.ClampToEdgeWrapping;
      this.doodleTexture.needsUpdate = true;
      const quad = new THREE.PlaneGeometry(2, 2);
      this.simulation = this.createSimulation(quad);
      this.background = this.createBackground(quad);
      this.resizeObserver.observe(document.documentElement);
      window.addEventListener('resize', () => this.resize(), { passive: true });
      this.resize();
      this.render(0);
      return true;
    } catch (error) {
      this.canvas.classList.add('water-unavailable');
      console.warn('Water background unavailable; CSS background remains active.', error);
      return false;
    }
  }

  createSimulation(quad) {
    const targets = [0, 1].map(() => new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    }));
    const impulses = Array.from({ length: MAX_IMPULSES }, () => new THREE.Vector3());
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uState: { value: targets[0].texture },
        uTexel: { value: new THREE.Vector2(1 / SIM_SIZE, 1 / SIM_SIZE) },
        uImpulses: { value: impulses },
        uImpulseCount: { value: 0 },
      },
      vertexShader: passthroughVertex,
      fragmentShader: simulationFragment,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(quad, material));
    const camera = new THREE.Camera();
    return { targets, material, scene, camera, current: 0 };
  }

  createBackground(quad) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null },
        uDoodle: { value: this.doodleTexture },
        uRipple: { value: this.simulation.targets[0].texture },
        uRippleTexel: { value: new THREE.Vector2(1 / SIM_SIZE, 1 / SIM_SIZE) },
        uImageAspect: { value: new THREE.Vector2(1, 1) },
        uViewportAspect: { value: 1 },
        uDisplacement: { value: 0.12 },
        uContrast: { value: this.contrast },
        uBrightness: { value: this.brightness },
        uDoodleOpacity: { value: 0.94 },
      },
      vertexShader: passthroughVertex,
      fragmentShader: backgroundFragment,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(quad, material));
    return { material, scene, camera: new THREE.Camera() };
  }

  async setImage(source) {
    const requestId = ++this.imageRequest;
    this.ready = false;
    this.canvas.classList.remove('water-ready');
    if (!source || !this.renderer || !this.background) {
      return;
    }
    const image = new Image();
    if (!source.startsWith('data:') && new URL(source, location.href).origin !== location.origin) image.crossOrigin = 'anonymous';
    try {
      await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('background image timed out')), 5000);
        image.onload = () => { window.clearTimeout(timer); resolve(image); };
        image.onerror = () => { window.clearTimeout(timer); reject(new Error('background image failed to load')); };
        image.src = source;
      });
    } catch (error) {
      if (requestId !== this.imageRequest) return;
      this.error = String(error);
      this.canvas.classList.remove('water-ready');
      return;
    }
    if (requestId !== this.imageRequest) return;
    this.map?.dispose();
    this.map = new THREE.Texture(image);
    this.map.colorSpace = THREE.SRGBColorSpace;
    this.map.minFilter = THREE.LinearFilter;
    this.map.magFilter = THREE.LinearFilter;
    this.map.needsUpdate = true;
    this.mapAspect = image.width / image.height || 1;
    this.background.material.uniforms.uMap.value = this.map;
    this.background.material.uniforms.uImageAspect.value.set(this.mapAspect, 1);
    this.ready = true;
    this.canvas.classList.add('water-ready');
  }

  setBlur(value) {
    this.canvas.style.setProperty('--water-blur', `${Number(value) || 0}px`);
  }

  setTone(contrast = 1, brightness = 1) {
    this.contrast = Number.isFinite(Number(contrast)) ? Number(contrast) : 1;
    this.brightness = Number.isFinite(Number(brightness)) ? Number(brightness) : 1;
    if (this.background) {
      this.background.material.uniforms.uContrast.value = this.contrast;
      this.background.material.uniforms.uBrightness.value = this.brightness;
    }
  }

  addRipple(x, y, strength = 0.05) {
    if (!this.ready) return;
    this.impulses.push(new THREE.Vector3(Math.min(1, Math.max(0, x)), 1 - Math.min(1, Math.max(0, y)), Math.min(0.16, Math.max(0.01, strength))));
    if (this.impulses.length > MAX_IMPULSES) this.impulses.shift();
  }

  resize() {
    if (!this.renderer) return;
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (this.background) this.background.material.uniforms.uViewportAspect.value = window.innerWidth / Math.max(1, window.innerHeight);
  }

  render(time) {
    requestAnimationFrame((nextTime) => this.render(nextTime));
    if (!this.renderer || !this.simulation || !this.background) return;
    const delta = Math.min(0.05, (time - this.lastTime) / 1000 || 0.016);
    this.lastTime = time;
    if (this.ready) {
      if (this.doodleTexture && this.doodleCanvas && this.doodleRevision !== this.doodleCanvas.revision) {
        this.doodleTexture.needsUpdate = true;
        this.doodleRevision = this.doodleCanvas.revision;
      }
      const sim = this.simulation;
      const next = 1 - sim.current;
      sim.material.uniforms.uState.value = sim.targets[sim.current].texture;
      sim.material.uniforms.uImpulseCount.value = Math.min(this.impulses.length, MAX_IMPULSES);
      for (let i = 0; i < MAX_IMPULSES; i++) sim.material.uniforms.uImpulses.value[i].copy(this.impulses[i] || new THREE.Vector3());
      this.impulses = [];
      this.renderer.setRenderTarget(sim.targets[next]);
      this.renderer.render(sim.scene, sim.camera);
      this.renderer.setRenderTarget(null);
      sim.current = next;
      this.background.material.uniforms.uRipple.value = sim.targets[sim.current].texture;
      this.renderer.render(this.background.scene, this.background.camera);
    } else {
      this.renderer.clear();
    }
    this.frame += delta;
  }
}
