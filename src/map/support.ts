/**
 * Can this browser run the maps? Answered once for the page, before any map
 * code is downloaded.
 *
 * It mirrors mapbox-gl 3's own test (its `supported()`), which would otherwise
 * mean downloading mapbox just to ask:
 * - WebGL 2. mapbox-gl 3 has no WebGL 1 path, and plenty of older phones have
 *   only WebGL 1. Testing for "any WebGL" let those through to a map that then
 *   failed to start.
 * - A shader that actually compiles: some blocklisted GPUs hand out a context
 *   that cannot draw.
 * - `Object.hasOwn`, mapbox's marker for a JavaScript engine new enough for it.
 * - A 2D canvas that can be read back (the map's line badges are drawn on one).
 *
 * The test context is released straight away. Phones allow only a few live
 * WebGL contexts per page and the two maps need two of them; an abandoned one
 * lingers until garbage collection.
 */

let answer: string | null | undefined;

/** Why the maps cannot run here, or null when they can. */
export function mapUnsupportedReason(): string | null {
  if (answer === undefined) answer = test();
  return answer;
}

export const mapSupported = (): boolean => mapUnsupportedReason() === null;

function test(): string | null {
  try {
    if (typeof Object.hasOwn !== 'function') return 'browser too old for the map (no Object.hasOwn)';

    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    const ctx = probe.getContext('2d');
    if (!ctx || ctx.getImageData(0, 0, 1, 1).width !== 1) return 'canvas read-back is blocked';

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, stencil: true, depth: true });
    if (!gl) return 'WebGL 2 is not available';
    try {
      const shader = gl.isContextLost() ? null : gl.createShader(gl.VERTEX_SHADER);
      if (!shader) return 'WebGL 2 context is unusable';
      gl.shaderSource(shader, 'void main() {}');
      gl.compileShader(shader);
      const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true;
      gl.deleteShader(shader);
      return compiled ? null : 'WebGL 2 cannot compile shaders';
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch (error) {
    return `map support test failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
