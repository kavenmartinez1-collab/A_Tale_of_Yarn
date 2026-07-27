/**
 * Configure ONNX Runtime BEFORE transformers.js is evaluated.
 *
 * This module exists purely to own an ordering constraint that is otherwise
 * invisible and catastrophic. transformers.js reads `ort.env.wasm.wasmPaths`
 * exactly once, at module-evaluation time, and IF IT IS STILL UNSET it assigns
 * itself `https://cdn.jsdelivr.net/npm/@huggingface/transformers@<v>/dist/`
 * (node_modules/@huggingface/transformers/src/backends/onnx.js:205-212).
 *
 * That is the whole risk. A packaged, "fully offline" build would reach for the
 * public internet the first time a player spoke, and it would do it from a
 * worker, where a lot of monitoring never looks.
 *
 * So the assignment happens at TOP LEVEL here, and stt-worker.ts imports this
 * module on the line above its transformers import. ES module evaluation is
 * depth-first in source order, so it is guaranteed to have happened. Expressing
 * it as an import edge rather than as `await import()` also keeps the worker
 * free of code-splitting, which matters because Vite's default `worker.format`
 * is `iife` and switching it globally would change how the three existing
 * workers (moe, wasm, ram-smoke) are emitted.
 *
 * The `env` object mutated here is THE SAME OBJECT transformers.js will use,
 * because vite.config.ts aliases the bare `onnxruntime-web` specifier — which
 * is what transformers.js imports — to the same `./wasm` subpath imported
 * below. One module instance, one `env`.
 *
 * ── WHY NOT `Symbol.for('onnxruntime')` ─────────────────────────────────────
 *
 * transformers.js offers a hook for supplying your own runtime, and injecting
 * the wasm-only build through it looks like the obvious way to guarantee a CPU
 * backend. It does not work, and it fails at the far end of the build in a way
 * no typecheck catches: that branch (onnx.js:59-61) returns early without
 * populating the module's `supportedDevices` list, while models.js:177 still
 * resolves a browser device to `'wasm'` unconditionally. Every model load then
 * dies on `Unsupported device: "wasm". Should be one of: .` — the empty list
 * being the tell.
 *
 * The alias is the better mechanism anyway. It fixes which ORT is compiled in
 * for the WHOLE bundle rather than which one is handed to one library, so the
 * "speech never touches the GPU queue" property does not depend on this file
 * running at all.
 *
 * DO NOT merge this back into stt-worker.ts, and do not reorder those imports.
 * `scripts/steam-pack-check.mjs` asserts zero external requests with the
 * microphone exercised, which is the test that catches it if someone does.
 */
import * as ort from 'onnxruntime-web/wasm';
// Reached by relative path, not as `onnxruntime-web/dist/...`, because the
// package's `exports` map publishes no `./dist/*` subpath and Vite refuses the
// deep import. Going through `?url` (rather than dropping a copy in `public/`)
// is the point: the file stays a node in Vite's asset graph, so it is emitted
// with a content hash and scripts/pack-steam.mjs can see it. A hand-copied
// public/ asset would be invisible to the module walk — the exact failure this
// feature had to design around.
import ortWasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
// The emscripten glue that instantiates the binary. ORT dynamically imports it
// at the path derived from `wasmPaths`, so naming the `.wasm` alone is not
// enough — the packaged app 404s on `/assets/ort-wasm-simd-threaded.mjs` and
// reports the useless `no available backend found`. Both artifacts, explicitly.
import ortMjsUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';

/**
 * `onnxruntime-web/wasm` is the build with NO JSEP/WebGPU execution provider
 * compiled in. That is the load-bearing choice: WebGPU v1 exposes one queue,
 * the renderer and the NPC LLM already contend for it, and this keeps speech
 * structurally unable to join them. Not a setting — the code is not in the
 * binary. It is also 11.1 MB against the jsep build's 21.6 MB.
 */
ort.env.wasm.wasmPaths = {
  wasm: new URL(ortWasmUrl, self.location.href).href,
  mjs: new URL(ortMjsUrl, self.location.href).href,
};

/**
 * ORT threads need SharedArrayBuffer, which needs cross-origin isolation. The
 * dev server sends COOP/COEP (vite.config.ts:49); whether the packaged loopback
 * server does is a deployment detail, so ask the platform rather than assume.
 * Half the cores, capped at 4 — this is a background thread, and leaving
 * headroom for the renderer matters more than the last few hundred ms.
 */
const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(4, cores >> 1)) : 1;

/** `proxy` spawns ORT's own worker. We ARE the worker; nesting buys nothing. */
ort.env.wasm.proxy = false;

/** What the runtime actually negotiated — reported to the UI and the harness. */
export const ortInfo = {
  threads: ort.env.wasm.numThreads ?? 1,
  crossOriginIsolated: isolated,
  wasmUrl: ort.env.wasm.wasmPaths.wasm ?? '',
};

export { ort };
