import { defineConfig, type Plugin } from 'vite';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Vite plugin: Debug API for automated testing.
 *
 * POST /api/debug  — browser posts debug data (JSON body), written to debug-output.json
 * GET  /api/debug  — read last debug output
 * POST /api/test   — queue a test prompt (JSON body: {prompt: string})
 * GET  /api/test   — browser polls for pending test prompt
 */
function debugApiPlugin(): Plugin {
  const debugFile = path.resolve(__dirname, 'debug-output.json');
  const liveDir = path.resolve(__dirname, 'scripts/shots/live');
  const LIVE_KEEP = 40; // ring buffer: last N snapshots (png+json pairs)
  let pendingTest: { prompt: string; temperature?: number } | null = null;

  return {
    name: 'debug-api',
    configureServer(server) {
      server.middlewares.use('/api/debug', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            fs.writeFileSync(debugFile, body, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          });
        } else {
          try {
            const data = fs.readFileSync(debugFile, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
          } catch {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{"error":"no debug data yet"}');
          }
        }
      });

      // COOP/COEP on ALL documents so the main app is crossOriginIsolated —
      // SharedArrayBuffer is required for the Phase C MoE expert workers.
      // COEP `credentialless` (not require-corp) keeps the HF CDN fallback
      // fetches working: anonymous cross-origin requests are allowed without
      // CORP headers, and HF serves Access-Control-Allow-Origin: * for the
      // CORS-mode authorized fetches.
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
        next();
      });

      // Live gameplay snapshots (debug-capture.ts): POST {tag,time,png,state}
      // → scripts/shots/live/<stamp>-<tag>.png + .json, oldest pruned.
      // GET lists the snapshots newest-first so an agent can find the latest.
      server.middlewares.use('/api/capture', (req, res) => {
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          req.on('end', () => {
            try {
              const { tag, time, png, state } =
                JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              const b64 = String(png).split('base64,')[1] ?? '';
              const stamp = new Date(Number(time)).toISOString()
                .replace(/[:.]/g, '-');
              const safeTag = String(tag).replace(/[^a-z0-9_-]/gi, '');
              const base = `${stamp}-${safeTag}`;
              fs.mkdirSync(liveDir, { recursive: true });
              fs.writeFileSync(
                path.join(liveDir, `${base}.png`), Buffer.from(b64, 'base64'));
              fs.writeFileSync(
                path.join(liveDir, `${base}.json`),
                JSON.stringify(state, null, 2), 'utf-8');
              // Prune beyond the ring size (names sort chronologically).
              const pngs = fs.readdirSync(liveDir)
                .filter((f) => f.endsWith('.png')).sort();
              for (const f of pngs.slice(0, Math.max(0, pngs.length - LIVE_KEEP))) {
                fs.rmSync(path.join(liveDir, f), { force: true });
                fs.rmSync(path.join(liveDir, f.replace(/\.png$/, '.json')),
                  { force: true });
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(`{"ok":true,"file":${JSON.stringify(base)}}`);
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        } else {
          let files: string[] = [];
          try {
            files = fs.readdirSync(liveDir)
              .filter((f) => f.endsWith('.png')).sort().reverse();
          } catch { /* no captures yet */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(files));
        }
      });

      server.middlewares.use('/api/test', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            pendingTest = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true,"prompt":' + JSON.stringify(pendingTest?.prompt) + '}');
          });
        } else {
          // GET — browser polls for pending test
          if (pendingTest) {
            const t = pendingTest;
            pendingTest = null; // consume
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(t));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('null');
          }
        }
      });
    },
  };
}

export default defineConfig({
  root: '.',
  // Relative base so the production bundle works from any mount point —
  // a domain root, a GitHub Pages /<repo>/ subpath, or file-served dirs.
  base: './',
  publicDir: 'public',
  resolve: {
    // ONNX Runtime, everywhere in this project, is the WASM-only build.
    //
    // `@huggingface/transformers` statically imports `onnxruntime-web`, whose
    // root entry is the full build — WebGPU/JSEP execution providers, and a
    // 21.6 MB `ort-wasm-simd-threaded.jsep-*.wasm` emitted beside them. Nothing
    // here wants that. Inference in this game is either the hand-written WebGPU
    // engine (src/engine) or speech recognition, and speech deliberately stays
    // on the CPU: WebGPU v1 exposes one queue, the renderer and the NPC LLM
    // already contend for it, and that contention is the Steam Deck's measured
    // problem. A repo-wide grep confirms no ORT `InferenceSession` is ever
    // created outside src/game/voice.
    //
    // So point the package at its own `./wasm` subpath export. The jsep binary
    // then never enters the module graph at all, which is worth more than the
    // 21.6 MB it saves: "speech cannot reach the GPU" becomes a property of
    // what was compiled rather than of a runtime flag someone can flip later.
    // See src/game/voice/ort-bootstrap.ts.
    //
    // Array form with an anchored regex, not the object form: an object alias
    // is a PREFIX replacement, so plain `onnxruntime-web` would also rewrite
    // `onnxruntime-web/wasm` into `onnxruntime-web/wasm/wasm`.
    alias: [
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: {
        main: 'index.html',
        worker: 'worker.html',
        bench: 'bench.html',
        game: 'game.html',
      },
    },
  },
  plugins: [debugApiPlugin()],
  server: {
    host: '127.0.0.1',  // localhost only — no network exposure
    port: 5173,
    strictPort: true,
    open: true,
    proxy: {
      // Proxy metrics to the dev server
      '/metrics': 'http://127.0.0.1:3001',
      // GPU info (VRAM auto-budget) lives on the dev server
      '/api/gpu-info': 'http://127.0.0.1:3001',
      // Keyless web search proxy (web_search tool) lives on the dev server
      '/api/search': 'http://127.0.0.1:3001',
      // Proxy local HF cache to the dev server (streams large weight shards)
      '/api/hf-cache': {
        target: 'http://127.0.0.1:3001',
        timeout: 600000,
        proxyTimeout: 600000,
        selfHandleResponse: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setSocketKeepAlive(true);
          });
        },
      },
      // WebSocket proxy to orchestration hub
      '/ws': {
        target: 'http://127.0.0.1:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
