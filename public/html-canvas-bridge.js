const probe = document.querySelector('#html-canvas-probe');

export async function initHtmlCanvasBridge() {
  if (!probe) return { mode: 'off' };
  const nativeCanvas = HTMLCanvasElement.prototype;
  const nativeAvailable = ['drawElementImage', 'texElementImage2D', 'copyElementImageToTexture']
    .some((name) => name in nativeCanvas
      || (typeof CanvasRenderingContext2D !== 'undefined' && name in CanvasRenderingContext2D.prototype)
      || (typeof WebGLRenderingContext !== 'undefined' && name in WebGLRenderingContext.prototype));

  if (nativeAvailable) {
    document.documentElement.dataset.htmlCanvasMode = 'native';
    probe.dataset.mode = 'native';
    return { mode: 'native' };
  }

  try {
    const module = await import('/vendor/html-in-canvas-polyfill.mjs');
    module.installHtmlInCanvasPolyfill({ force: true });
    document.documentElement.dataset.htmlCanvasMode = 'polyfill';
    probe.dataset.mode = 'polyfill';
    probe.requestPaint?.();
    return { mode: 'polyfill' };
  } catch (error) {
    document.documentElement.dataset.htmlCanvasMode = 'overlay';
    probe.dataset.mode = 'overlay';
    console.warn('HTML-in-Canvas polyfill unavailable; using DOM overlay.', error);
    return { mode: 'overlay' };
  }
}
