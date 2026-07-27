/**
 * Loopback static server for the packaged Steam build.
 *
 * Serves two things from one origin:
 *   /                     → the built game (dist/)
 *   /api/hf-cache/...     → model weights (models/), with honest Range/206
 *
 * WHY a loopback server rather than a custom `app://` protocol:
 *
 * 1. `src/model/tokenizer.ts:88` fetches `/api/hf-cache/<repo>/raw/main/
 *    tokenizer.json` with a *bare, hardcoded* fetch — it does not go through
 *    hf-hub and has no configurable base. Any offline mechanism has to answer
 *    that exact path relative to the page origin, so we may as well be a real
 *    origin and answer it directly.
 * 2. `useLocalCache()` (hf-hub.ts:60) is already called unconditionally on the
 *    game path (npc-chat-panel.ts:825, director.ts:325) with its default base
 *    `/api/hf-cache`. Serving that path means the packaged game needs ZERO
 *    source changes to load weights from the depot.
 * 3. docs/PORTING.md §1.5 documents the silent-failure hazard: `fetchRange`
 *    accepts a 200 as well as a 206, so a handler that ignores `Range` and
 *    returns the whole file "works" while materialising 1.11 GB per call.
 *    Node's http server lets us emit a real 206 + Content-Range with ordinary,
 *    auditable semantics — the same code shape as server/dev-server.ts:602-617,
 *    which is the implementation the game is already verified against.
 *
 * Security posture: bound to 127.0.0.1 on an ephemeral port, and every request
 * must carry a Host header matching that exact address:port (blocks DNS
 * rebinding, which is the only way a remote page could reach a loopback bind).
 * Path traversal is contained by resolve-and-prefix-check on both roots.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Reject anything that escapes `root` after resolution. */
function containedPath(root, rel) {
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/**
 * Resolve an HF-style repo id to a directory under models/.
 *
 * Layouts accepted, in order:
 *   local/<name>          → models/<name>            (matches the dev server's
 *                                                     alias, README in models/)
 *   <org>/<repo>          → models/<org>--<repo>     (what fetch-weights writes)
 *   <org>/<repo>          → models/<repo>            (convenience)
 *   <org>/<repo>          → models/models--<org>--<repo>/snapshots/<hash>
 *                                                    (a copied HF cache dir)
 */
function resolveRepoDir(modelsDir, repo) {
  if (repo.startsWith('local/')) {
    const dir = containedPath(modelsDir, repo.slice(6));
    return dir && fs.existsSync(dir) ? dir : null;
  }
  const flat = repo.replace(/\//g, '--');
  const candidates = [flat, repo.split('/').pop()];
  for (const c of candidates) {
    const dir = containedPath(modelsDir, c);
    if (dir && fs.existsSync(dir)) return dir;
  }
  // HF cache shape: models--org--repo/snapshots/<commit>/
  const cacheDir = containedPath(modelsDir, `models--${flat}`);
  if (cacheDir && fs.existsSync(cacheDir)) {
    const snaps = path.join(cacheDir, 'snapshots');
    try {
      const [hash] = fs.readdirSync(snaps);
      if (hash) return path.join(snaps, hash);
    } catch { /* not a cache dir */ }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.distDir   built game (contains game.html)
 * @param {string} opts.modelsDir weight root
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{origin: string, port: number, close: () => Promise<void>, stats: object}>}
 */
function createLocalServer({ distDir, modelsDir, log = () => {} }) {
  const stats = { requests: 0, ranges: 0, bytesServed: 0, notFound: 0 };
  // A weight load issues thousands of Range calls; logging each one would cost
  // more than serving them. Log the first few (enough to prove 206 in a run
  // transcript) then every 250th.
  let rangeLogged = 0;

  /** Set once the socket is bound; every request is checked against it. */
  let expected = '';

  const server = http.createServer((req, res) => {
    stats.requests++;
    const host = req.headers.host || '';
    if (host !== expected) {
      res.writeHead(421, { 'Content-Type': 'text/plain' });
      return res.end('Misdirected Request');
    }

    // Cross-origin isolation, on every response.
    //
    // This is what makes `crossOriginIsolated` true, which is what makes
    // SharedArrayBuffer available, which is what lets ONNX Runtime run the
    // speech-recognition worker on more than one thread. Without it Whisper is
    // pinned to a single core no matter how many the machine has. Measured in
    // the packaged app on a 16-core desktop, same fixture utterance, warm:
    //
    //     crossOriginIsolated=false   1 thread    3.27 s
    //     crossOriginIsolated=true    4 threads   1.63 s
    //
    // On a Steam Deck that difference is the feature feeling usable or not.
    // Beat 4b of scripts/steam-pack-check.mjs re-measures it every run.
    //
    // The dev server has sent exactly these two headers since the MoE expert
    // workers needed them (vite.config.ts:49-53), so the game is already known
    // to run under them — this closes the gap between dev and the depot rather
    // than opening a new risk. `credentialless` rather than `require-corp` for
    // the same reason it was chosen there: it does not demand CORP headers on
    // subresources. Everything here is same-origin loopback in any case.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, `http://${expected}`).pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (pathname.startsWith('/api/hf-cache/')) {
      return serveModel(pathname.slice('/api/hf-cache/'.length), req, res);
    }
    // The game POSTs runtime metrics and errors to the dev server's /metrics.
    // A shipped build has nowhere to send them and — per the AI disclosure the
    // game shows the player — nothing should leave the machine anyway. Accept
    // and drop, so the 404 counter keeps meaning "a depot file is missing".
    if (pathname === '/metrics') {
      req.resume();
      res.writeHead(204).end();
      return;
    }
    return serveStatic(pathname, req, res);
  });

  function notFound(res, why) {
    stats.notFound++;
    // Loud by default. In the packaged offline build there is no CDN behind a
    // 404, so every one of these is either a missing depot file or a path the
    // game expects and we do not serve — both worth seeing in a bug report.
    log(`404 ${why}`);
    // Honest 404 — never an SPA fallback. hf-hub treats a local 404 as "miss,
    // try the CDN"; in the packaged offline build there is no CDN, so a 404
    // must stay a 404 and fail loudly rather than returning index.html bytes
    // that would only be caught much later by the GGUF magic check.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: why }));
  }

  function serveStatic(pathname, req, res) {
    const rel = pathname === '/' ? 'game.html' : pathname.replace(/^\/+/, '');
    const file = containedPath(distDir, rel);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return notFound(res, `Not found: ${pathname}`);
    }
    const size = fs.statSync(file).size;
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': size,
      // Depot content is immutable for the lifetime of the process.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') return res.end();
    stats.bytesServed += size;
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  function serveModel(rest, req, res) {
    // `models` listing — the playground page uses it; harmless to answer.
    if (rest === 'models') {
      const out = [];
      try {
        for (const name of fs.readdirSync(modelsDir)) {
          const dir = path.join(modelsDir, name);
          if (!fs.statSync(dir).isDirectory()) continue;
          const files = fs.readdirSync(dir);
          out.push({
            repo: name.includes('--') ? name.replace('--', '/') : `local/${name}`,
            files,
            totalSize: files.reduce((s, f) => {
              try { return s + fs.statSync(path.join(dir, f)).size; } catch { return s; }
            }, 0),
          });
        }
      } catch { /* no models dir */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }

    // <repo...>/(tree|resolve|raw)/main/<file>
    const m = rest.match(/^(.+?)\/(tree|resolve|raw)\/main(?:\/(.*))?$/);
    if (!m) return notFound(res, `Bad hf-cache path: ${rest}`);
    const [, repo, action, filename] = m;

    const dir = resolveRepoDir(modelsDir, repo);
    if (!dir) return notFound(res, `Model not found: ${repo}`);

    if (action === 'tree') {
      const files = fs.readdirSync(dir).map((f) => {
        try { return { path: f, size: fs.statSync(path.join(dir, f)).size, type: 'file' }; }
        catch { return null; }
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(files));
    }

    const file = containedPath(dir, filename || '');
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return notFound(res, `File not found: ${filename}`);
    }
    const size = fs.statSync(file).size;

    // JSON (config.json, tokenizer.json, tokenizer_config.json) is small and
    // always fetched whole — matches server/dev-server.ts:544-549.
    if (file.endsWith('.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': size });
      if (req.method === 'HEAD') return res.end();
      stats.bytesServed += size;
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }

    res.setHeader('Accept-Ranges', 'bytes');
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
      if (req.method === 'HEAD') return res.end();
      stats.bytesServed += size;
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }

    // `bytes=start-end`, `bytes=start-`, `bytes=-suffix`. Inclusive both ends.
    const rm = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!rm || (rm[1] === '' && rm[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    let start; let end;
    if (rm[1] === '') { start = Math.max(0, size - Number(rm[2])); end = size - 1; }
    else { start = Number(rm[1]); end = rm[2] === '' ? size - 1 : Number(rm[2]); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    const len = end - start + 1;

    stats.ranges++;
    if (rangeLogged < 5 || stats.ranges % 250 === 0) {
      rangeLogged++;
      log(`206 bytes ${start}-${end}/${size} (${(len / 1048576).toFixed(2)} MB) ${path.basename(file)}`);
    }

    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': len,
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') return res.end();
    stats.bytesServed += len;
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // Port 0 = ephemeral. Never a fixed port: two copies of the game (or any
    // other app) must not fight over one.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      expected = `127.0.0.1:${port}`;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        port,
        stats,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { createLocalServer, resolveRepoDir };
