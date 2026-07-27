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

  /**
   * The inference surface, added for `tts-worker.ts`.
   *
   * Whisper never needed this: transformers.js owns its own session and only
   * receives the runtime as an opaque object. The piper voice calls ORT
   * directly, so the two classes it touches are declared here — deliberately
   * narrow, in the spirit of the note above. `run()` is typed loosely on
   * purpose: the real signature is a map of names to tensors whose keys depend
   * on the model, and pretending otherwise would be fiction.
   */
  export class Tensor {
    constructor(type: 'int64', data: BigInt64Array, dims: readonly number[]);
    constructor(type: 'float32', data: Float32Array, dims: readonly number[]);
    readonly data: Float32Array | BigInt64Array;
    readonly dims: readonly number[];
  }

  export class InferenceSession {
    static create(
      model: string | Uint8Array,
      options?: {
        executionProviders?: string[];
        graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
      },
    ): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
  }
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
