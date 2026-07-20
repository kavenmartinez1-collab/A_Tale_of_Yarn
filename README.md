# ArtifexWebGame

An open-world survival RPG demo rendered on **pure WebGPU** — no engine, no Three.js, just handwritten WGSL shaders, TypeScript, and Vite. An in-browser LLM "Director" (running on the same GPU as the renderer) dreams up dungeons and ecology as you explore, and settlement NPCs are live LLM chatbots with personas, memory, and moods. Everything — terrain, creatures, dialogue, inference — runs locally in your browser tab.

## Requirements

- **Node.js 18+** (20+ recommended)
- A **WebGPU-capable browser**: recent Chrome or Edge on Windows/macOS work out of the box. On Linux you may need to enable `chrome://flags/#enable-unsafe-webgpu`.
- A **GPU**. Any WebGPU-capable card renders the world; the LLM features (Director, NPC chat) like a few GB of free VRAM. On weak hardware, run with `?director=off`.

## Install & run

```bash
npm install
npm run dev
```

`npm run dev` starts Vite on `http://localhost:5173` plus a small local dev server. The game lives at:

```
http://localhost:5173/game.html
```

Useful URL flags (append to `game.html`):

| Flag | Effect |
|---|---|
| `?director=off` | Disable the LLM Director; dungeons/ecology fall back to deterministic fixtures |
| `?npcllm=fast\|abliterated\|default` | NPC dialogue model. `fast` (default): abliterated Qwen3-1.7B — uncensored, snappy replies. `abliterated`: Qwen3-4B — smarter, slower. `default`: reuses the Director model (no extra download, stock safety training) |
| `?wipe=1` | Blank slate: delete ALL saved data (saves, slots, NPC memories, caches) before boot |
| `?tod=0.5` | Freeze the day/night cycle at a fixed time |
| `?weather=clear\|overcast\|rain` | Pin the weather |

The NPC chat model (~1.1 GB) downloads from Hugging Face the first time you approach a settlement and is cached after that. Until it's ready, NPCs answer with scripted fallback lines — give it a few minutes on first run.

## Controls

Click the canvas to lock the pointer.

| Input | Action |
|---|---|
| WASD | Move (camera-relative) |
| Mouse | Orbit camera; wheel zooms |
| Shift | Sprint (drains stamina) |
| Space | Jump / paddle up while swimming / ascend on a flying mount |
| Q | Descend on a flying mount |
| Left click | Gather, attack, place, ignite, shoot bow, throw, feed, fill container — context-sensitive |
| E | Interact: talk, loot, mount/dismount, drink from fresh water, enter dungeons, upgrade campfire to forge, eat/drink held item, attempt jail escape |
| F (hold) | Mount attack — dragon fire breath, hoof/claw stomp on other mounts |
| 1–9 | Select hotbar slot |
| I / Tab | Inventory (armor equip lives here) |
| B | Crafting |
| C | Character customization |
| Esc | Close panel, or open the game menu (Save / Load / New Game) |
| R | Toggle debug fly camera |
| F8 / F9 | Debug snapshot / auto-capture |

## Staying alive

Your vitals are **health, thirst, stamina, and temperature** (a BOTW-style warmth model — the strongest warm source wins).

- **Drink**: stand at a river or inland pond and press E, or craft a container and left-click to fill it. Ocean and beach water is salt — undrinkable.
- **Gather**: punch (or better, axe) trees for logs, mine rocks with a pickaxe, pick bushes. Three swings per node with the right tool.
- **Campfire**: craft a campfire kit, left-click to place, ignite with a fire starter or torch, feed it fuel. Warmth, light, and a cooking station.
- **Forge**: press E on a lit campfire while carrying 8 stone to upgrade it. Iron tools, swords, and armor are forged here.
- **Cook**: recipes at a fire (some need a cooking pot in your pack) turn raw food into meals with timed effects.
- **Craft**: press B — roughly 56 recipes across tools, weapons, armor, food, and camp gear, gated by station (hand / fire / forge).
- **Shelter**: place fiber, wool, or hide tents for warmth and rain cover; higher tiers fight harsher cold.
- **Weather**: storms bring lightning that can strike you and set trees ablaze — and fire spreads. Wearing iron armor in a storm makes you a bigger target.

## What's out there

- **Settlements** — ranches, villages, towns, and castles, populated by LLM-driven NPCs. Every conversation is live and open-ended — talk about anything: personas, persistent memory of what you've said, disposition that warms or sours.
- **Trade** — buy and sell with NPC stock and gold; prices can be haggled down (to a floor — they're not fools).
- **Crime** — witnessed misdeeds put a bounty on your head. Pay it, serve jail time, or try to break out.
- **Romance** — flirt, court, and marry an NPC. Spouses remember, and keep small gifts for you.
- **Wildlife** — rabbits, deer, and horses share the world with wolves and bears that attack on sight, plus rare territorial creatures best approached with a plan (or not at all).
- **Taming & mounts** — feed animals their favorite food, ride horses, and win over — or hatch from a stolen egg — a dragon you can fly, raining fire with F.
- **Dungeons** — crypts, caves, and ruins authored by the in-browser LLM Director, persisted per world seed so re-entry is deterministic.
- **Loot & gear** — you spawn with a full iron kit, gold, and trade stock; progression runs up to forged iron and dragonscale armor.
- **Save/load** — multiple save slots via the Esc menu; the world persists across reloads.

## Development

```bash
npx tsc --noEmit        # typecheck (or: npm run typecheck)
```

Game logic is deliberately split into pure, DOM/GPU-free modules with fast Node test suites under `scripts/`:

```bash
npx tsx scripts/test-vitals.mts
npx tsx scripts/test-crafting.mts
npx tsx scripts/test-crime.mts
npx tsx scripts/test-taming.mts
# ... see scripts/test-*.mts for the full set
```

End-to-end tests use Playwright driving real Chrome (headless Chromium lacks working WebGPU on Windows):

```bash
npm run test:e2e        # playwright test, specs in tests/e2e
```

The game exposes `window.__gameReady`, `window.__gameStats`, and `window.__gameDebug` for machine-readable assertions in e2e specs.

## License

MIT — see [LICENSE](LICENSE).
