# @typetorch/framework

The roblox-ts framework of [TypeTorch](https://github.com/typetorch): hot-swappable modules (dependency injection,
lifecycle, troves), guarded networking over the kernel's stable remotes, UI helpers and the in-game dev menu.

It ships **inside every artifact**, so each generation runs its own fresh copy and framework fixes hot-swap like game
code. It needs the TypeTorch kernel in the place (`@typetorch/kernel`), which calls your `Server/boot` and
`Client/boot` modules.

## Install

```sh
bun add @typetorch/framework @flamework/core
bun add -d rbxts-transformer-flamework
```

`tsconfig.json` needs `node_modules/@typetorch` and `node_modules/@flamework` in `typeRoots`, and the transformers in
this order: `rbxts-transform-debug`, then `rbxts-transformer-flamework` (it generates the network guards and the
constructor dependency ids). The starter game (`typetorch init`, or the `template` repo) has it all set up.

## Usage

```ts
// src/server/boot.ts
import { startServer, type ServerKernel } from "@typetorch/framework";
import { BUILD } from "../shared/build";
export function boot(kernel: ServerKernel) {
	return startServer(kernel, { modules: [script.Parent!.FindFirstChild("services")!], build: BUILD });
}

// src/shared/net.ts
import { createNetwork, type ProperReturns } from "@typetorch/framework";
interface ClientToServer { coins: { collect(coinId: string): void; balance(): ProperReturns<number> } }
interface ServerToClient { coins: { changed(total: number): void } }
export const network = createNetwork<ClientToServer, ServerToClient>();

// src/server/services/coin.service.ts
@Service()
export class CoinService extends Module implements OnStart {
	constructor(private readonly score: ScoreService) { // injected
		super();
	}
	onStart() {
		this.trove.add(network.server.coins.collect.on((player, coinId) => this.score.add(player, 1)));
	}
}
```

- **Modules:** `@Service()` (server) and `@Controller()` (client) classes extending `Module`. Constructor parameters
  are other modules, injected by type. Lifecycle: `OnInit` (sequential, dependencies first), `OnStart` (spawned),
  `OnStop` (reverse order), `OnTick`, `OnPhysics`, `OnRender`, `OnPlayerAdded` (replays players already in the server).
- **Troves:** every module gets `this.trove`; everything it creates or connects goes there, so a swap leaves nothing
  behind. `this.ctx.persist(key, init)` keeps plain data across swaps.
- **Network:** `createNetwork<C2S, S2C>()` with nested namespaces. The server checks rate limits, shape limits and the
  generated type guard on every client message. `setNetworkLimits({ "chat.say": { maxString: 200 } })` tunes a leaf.
- **UI:** `observeElement(trove, tag, (instance, elementTrove) => ...)`, `isRealFrame`, `popIn` / `popOut` / `bump`
  (UIScale, never Size tweens) and `PopupQueue` (one modal at a time).
- **Dev menu:** devs (Studio, project members, dev badge) get a DEV button, `Ctrl+Shift+D` and `/tt dev`: artifact,
  server status, logs (server, own client, other players' clients), client and server dex, network stats, module
  state, a branch and artifact picker (Server > Branch) and a Claude prompt. Prod-channel servers are read-only. The
  window can be dragged by its header and resized from its corner (double-tap the header to reset).
- **Remote Claude** (dev-channel servers only): while `typetorch remote-claude` runs on a dev's machine, allowlisted
  devs prompt Claude Code from the Claude tab. Each dev pairs once by pasting the pairing code printed by
  typetorch-dev-server; the game server keeps the session URL and the tokens in memory and never sends them to clients.
  No Roblox secret is needed.

## Develop

```sh
bun install
bun run build   # rbxtsc --type package -> out/
```

MIT licensed.
