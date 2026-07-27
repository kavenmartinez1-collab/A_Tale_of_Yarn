/**
 * Type shims for two things the project's tsconfig cannot see on its own.
 *
 * `tsconfig.json` sets `"types": ["@webgpu/types"]`, which deliberately keeps
 * ambient type packages to exactly one — so Vite's own client types
 * (`vite/client`), which is where `?url` imports are declared, are not loaded.
 * Adding `vite/client` globally would pull in a large ambient surface for the
 * sake of one import, so the one import is declared here instead.
 *
 * The ORT shim exists because `onnxruntime-web` declares `types` only for its
 * root entry, not for the `./wasm` subpath export. The subpath ships the same
 * API — it is the same library built without the WebGPU execution provider —
 * so it takes the same types.
 */

/**
 * onnxruntime-web ships a `types.d.ts` that declares this subpath as
 * `export * from 'onnxruntime-common'` — but `onnxruntime-common` has neither a
 * `types` field nor a `types` condition in its `exports` map, so under
 * `moduleResolution: "bundler"` that re-export resolves to nothing and every
 * member comes back missing.
 *
 * Rather than reach past the exports map at a versioned internal path that
 * would break on upgrade, declare exactly the surface stt-worker.ts touches.
 * The rest of the runtime is handed to transformers.js as an opaque object via
 * `Symbol.for('onnxruntime')` and is never typed here. If this list needs to
 * grow, that is a real change in coupling and worth seeing in a diff.
 */
declare module 'onnxruntime-web/wasm' {
  export const env: {
    wasm: {
      /** Prefix string, or explicit per-artifact URLs. We set `wasm`. */
      wasmPaths?: string | { wasm?: string; mjs?: string };
      numThreads?: number;
      proxy?: boolean;
      simd?: boolean;
    };
  };
}

/** Vite asset import: resolves to the emitted URL of the file. */
declare module '*.wasm?url' {
  const src: string;
  export default src;
}

/** Same, for ONNX Runtime's emscripten glue module. */
declare module '*.mjs?url' {
  const src: string;
  export default src;
}
