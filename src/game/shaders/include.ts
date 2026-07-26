/**
 * A one-line WGSL preprocessor.
 *
 * WGSL has no include mechanism, so every scene shader used to carry its own
 * hand-copied duplicate of the Frame struct and the lighting helpers — which
 * meant a uniform-layout change had to be mirrored by hand in seven files and
 * a missed one produced silently wrong shading. Shaders now write
 * `#include "common.wgsl"` and this resolves it at module load.
 *
 * Includes are resolved recursively and each file is emitted at most once, so
 * a diamond include graph will not produce duplicate symbol definitions.
 */

import commonWgsl from './common.wgsl?raw';
import frameWgsl from './frame.wgsl?raw';
import fullscreenWgsl from './fullscreen.wgsl?raw';

const LIBRARY: Record<string, string> = {
  'common.wgsl': commonWgsl,
  'frame.wgsl': frameWgsl,
  'fullscreen.wgsl': fullscreenWgsl,
};

const INCLUDE_RE = /^[ \t]*#include\s+"([^"]+)"[ \t]*$/gm;

function expand(source: string, seen: Set<string>): string {
  return source.replace(INCLUDE_RE, (_match, name: string) => {
    if (seen.has(name)) return `// (${name} already included)`;
    const lib = LIBRARY[name];
    if (lib === undefined) {
      throw new Error(`WGSL #include: unknown module "${name}"`);
    }
    seen.add(name);
    return expand(lib, seen);
  });
}

/** Resolve every `#include` in `source`. */
export function wgsl(source: string): string {
  return expand(source, new Set());
}
