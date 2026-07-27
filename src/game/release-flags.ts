/**
 * Build-mode flags. One switch, set at build time, read everywhere.
 *
 *   npm run build                          → default build, everything on
 *   VITE_STEAM_RELEASE=1 npm run build     → Steam release build, debug off
 *
 * WHY the default build keeps everything: the entire verification stack — 13
 * in-game harnesses, 22 Playwright specs, the demo gate — drives the game
 * through `window.__gameDebug` against a `vite preview` of the DEFAULT build.
 * Stripping unconditionally would blind all of it. Only the release mode
 * strips, and nothing in CI builds release mode.
 *
 * `import.meta.env.VITE_STEAM_RELEASE` is substituted by Vite at build time. The
 * try/catch around it is not decoration: `scripts/test-building-manager.mts`
 * and friends import game modules straight into Node under tsx, where
 * `import.meta.env` does not exist and a bare member access is a TypeError at
 * module load — i.e. it would take out the node test suites, not the browser.
 */

/**
 * True only in a build made with `VITE_STEAM_RELEASE=1`.
 *
 * What it turns off:
 *  - `window.__gameDebug` — 157 methods, roughly a third of them outright
 *    cheats (`giveItem`, `teleport`, `setVitals`, `killEntity`,
 *    `castleDamageBoss`, …). Never assigned in a release build.
 *  - Every debug URL parameter (see `debugParams`).
 *
 * What it deliberately leaves alone:
 *  - `window.__gameReady` — the pause logic branches on it (main.ts:6997,
 *    :7007), so it is game state, not instrumentation.
 *  - `window.__gameStats` — read-only telemetry with no cheat power, and the
 *    only way a support ticket can tell a stalled frame loop from a stalled
 *    machine.
 */
export const STEAM_RELEASE: boolean = (() => {
  try {
    return import.meta.env.VITE_STEAM_RELEASE === '1';
  } catch {
    return false; // Node (tsx test runners) — never a release build
  }
})();

/** Shared empty set — release reads always see "no parameters present". */
const NO_PARAMS = new URLSearchParams('');

/**
 * The query string, or nothing at all in a release build.
 *
 * Every debug/cheat parameter the game reads goes through here rather than
 * `new URLSearchParams(location.search)` directly, so the release behaviour is
 * one decision in one place instead of seven independent `if`s.
 *
 * The parameters this closes in a release build: `?wipe` (deletes every save
 * slot), `?spawn=`/`?count=` (spawn creatures), `?tod=`, `?weather=`,
 * `?dungeon=preview`, `?interior=`, and — the one that matters commercially —
 * `?npcllm=`, which can point the NPC model at `bartowski/mlabonne_Qwen3-4B-
 * abliterated-GGUF`. That model declares no upstream licence and has had its
 * refusal direction removed from the weights; docs/PORTING.md §2.8 explains why
 * a build a Steam reviewer could steer into it is a different product from the
 * one described in the AI Content Survey. The release build cannot select it at
 * all, and scripts/fetch-weights.mts never vendors it, so the bytes are not in
 * the depot either.
 *
 * Note `?director=off` goes with them. It was documented in the README as a
 * player-facing performance escape hatch; in a packaged build the player has no
 * URL bar, so if that escape hatch is still wanted it needs to become a real
 * settings toggle rather than a query parameter.
 */
export function debugParams(): URLSearchParams {
  return STEAM_RELEASE ? NO_PARAMS : new URLSearchParams(location.search);
}
