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
  behind. `TypeTorch.persist(key, init)` (or `this.ctx.persist`) keeps plain data across swaps.
- **Network:** `createNetwork<C2S, S2C>()` with nested namespaces. The server checks rate limits, shape limits and the
  generated type guard on every client message. `setNetworkLimits({ "chat.say": { maxString: 200 } })` tunes a leaf.
- **UI:** `observeElement(trove, tag, (instance, elementTrove) => ...)`, `isRealFrame`, `popIn` / `popOut` / `bump`
  (UIScale, never Size tweens) and `PopupQueue` (one modal at a time).
- **Dev menu:** devs (Studio, project members, dev badge) get a DEV button, `Ctrl+Shift+D` and `/tt dev`: artifact,
  server status, logs (server, own client, other players' clients), client and server dex, network stats, module
  state, a branch and artifact picker (Server > Branch) and a Claude prompt. Prod-channel servers are read-only. The
  window can be dragged by its header and resized from its corner (double-tap the header to reset). Modules has
  Overview, State and Assets (hot assets), each with a Server | Client toolbar. In the Dex,
  right-click or long-press a property for Copy value / Copy name and a tree row for Copy path (Roblox has no
  clipboard, so copying opens a small popup with the text selected: Ctrl+C, or long-press > Copy on touch).
- **Remote Claude** (dev-channel servers only): while `typetorch remote-claude` runs on a dev's machine, allowlisted
  devs prompt Claude Code from the Claude tab. Each dev pairs once by pasting the pairing code printed by
  typetorch-dev-server; the game server keeps the session URL and the tokens in memory and never sends them to clients.
  No Roblox secret is needed.

## Runtime API: `TypeTorch`

`import { TypeTorch } from "@typetorch/framework"` works on the server and the client. It describes the running
generation and raises events that belong to it: every listener is dropped when the generation stops, so a swap never
leaves one behind. Each `on*` returns a disconnect function, which a trove can own.

```ts
// Identity
TypeTorch.artifact; // { id, commit, commitHash, branch, channel, builtAt, seq, assetId }
TypeTorch.generation; // 1, 2, 3... per server (or client)
TypeTorch.branch; TypeTorch.channel; TypeTorch.serverType; // "public" | "private" | "reserved" | "studio"
TypeTorch.isPinned(); TypeTorch.kernelVersion; TypeTorch.kernelApi; TypeTorch.jobId; TypeTorch.isStudio;

// How this generation started: a branch change starts a new generation.
const start = TypeTorch.startInfo; // { kind: "boot" | "swap", reason, previous?, branchChanged, requestedBy?, loadSeconds? }
if (start.reason === "auto_rollback") warn("the last deploy failed to start");
this.trove.add(TypeTorch.onBranchChanged(({ from, to }) => resetBranchData(from, to)));

// Before this generation stops (runs before every onStop; keep it short)
this.trove.add(TypeTorch.onSwapOut((info) => this.saveRound(info.reason)));

// A swap is coming: show a small hint, hide it if it's called off
this.trove.add(TypeTorch.onUpdatePending((update) => (hint.Visible = !update.cancelled)));

// State that survives swaps (plain data only)
const scores = TypeTorch.persist("scores.v1", () => new Map<number, number>());

// Dev and roles (server: the kernel decides; client: only the local player, cosmetic)
if (TypeTorch.isAdmin(player)) showAdminPanel(player);
TypeTorch.onPlayerDevChanged((player, info) => setAdminTools(player, info.dev));

// Server only
TypeTorch.status(); // uptime, players, memory, history: cheap
TypeTorch.branches(); TypeTorch.artifacts(); // registry reads, cached ~30 s: may yield, don't call per frame
TypeTorch.requestReload(player); // owner and admins only, checked by the kernel

// Logs (the kernel's ring buffer)
TypeTorch.logs(0, 50);
TypeTorch.onLog((entry) => errors.push(entry)); // don't print from inside it

// Hot assets (below): same as hotAsset(...)
const shop = TypeTorch.asset("ui/shop");
```

- **`startInfo.reason`:** `boot`, `deploy`, `rollback`, `branch`, `pin`, `reload`, `server_rollback`,
  `auto_rollback` or `unknown`. A client's first generation is always `boot`. `requestedBy` (a user id), `loadSeconds`,
  `stopSeconds` and `swapSeconds` are server-only; `swapSeconds` appears once the swap has finished.
- **`persist(key, init)`** keeps a table in the kernel's memory for the server's lifetime; every later generation gets
  the same table back. Store plain data only: tables, arrays, Maps and Sets of strings, numbers, booleans, and
  Players. Never store functions, class instances, Promises, threads, connections, charm atoms or instances this
  generation created: they keep the old generation's code alive or are destroyed by its trove. Version the key when
  the shape changes. Keys starting with `__` are reserved.
- **`onSwapOut`** runs synchronously before every module's `onStop`, so modules can still save into `persist`. It
  doesn't run on server shutdown (use `game.BindToClose`).
- **Kernel versions:** `TypeTorch.features` says what the running kernel supports. Kernel 0.2.2 adds the start
  reason and timings, the next artifact in `onSwapOut`, `onUpdatePending`, server-side `onPlayerDevChanged` and
  `requestReload`. On older kernels `startInfo` still knows boot vs swap, the previous artifact and branch (the
  framework records them), `onBranchChanged` still fires, and the reason of a swap is `unknown`.
- **Edit mode** (UI Labs stories, no kernel): `running` is false, identity has defaults, `persist` keeps a local table,
  events never fire, and the server-only reads throw.

## Hot assets: `hotAsset`

Builders mark models and UI templates in the place with the attribute `TypeTorchAsset` (a key such as `"ui/shop"`),
`typetorch assets sync` uploads them, and the deploy puts the asset manifest in the artifact. Running servers then get
new versions live, with no restart.

```ts
import { hotAsset } from "@typetorch/framework"; // or TypeTorch.asset("ui/shop")

// In a controller's onStart: rebuild clones the template.
const shop = hotAsset("ui/shop");
shop.changed(rebuild, this.trove); // a new version went live
rebuild(shop.get());
```

- **`hotAsset(keyOrId, fallback?)`** works on the server and the client. A number is the Roblox asset id, resolved
  through the manifest (server) or the live copy's `TypeTorchAssetId` attribute (client).
  - `get()` returns the live copy now. With none, it returns `fallback` (an instance you already hold, such as the
    template in the place) if it is still parented, else `undefined`. **Clone it; don't parent or edit it:** a new
    version destroys it.
  - `wait(timeout?)` is `get()` that waits for a live copy (forever without a timeout).
  - `changed(fn, trove?)` calls `fn(instance)` each time a new copy replaces the live one: a new version, a rollback,
    or the first copy reaching a client. It returns a disconnect function. Pass the module's trove so the connection
    ends with it (`shop.changed(rebuild, this.trove)` or `this.trove.add(shop.changed(rebuild))`). Without a trove it
    ends when the generation stops.
  - `key` and `version` (the live copy's `TypeTorchAssetVersion`, an assetVersionId).
- **Clients never request anything.** They read the CollectionService tag `__typetorch_asset:<key>`, and replicated
  assets arrive through replication. Assets under ServerStorage stay server-only.
- **AssetSync** is a server built-in. It runs on every generation start, before any module loads (top-level code
  included). For each manifest key:
  1. it keeps the live copy that already has the manifest's version;
  2. else it adopts the place's own copy, if its `TypeTorchAssetHash` matches (or if the manifest's optional
     `placeVersion` is this server's place version);
  3. else it runs `InsertService:LoadAssetVersion(ver)` (all loads in parallel), strips any scripts, places the copy
     at its path (creating missing Folders), tags it, then destroys the copy it replaces.

  It holds the start for at most 8 s. Loads still running after that keep going, swap in when done and fire
  `changed`. A failed load keeps the old copy (on a new server, the place's copy) and shows under Server > Status >
  Attention.
- **Hot assets persist across swaps.** They aren't in any trove. A swap changes them only when the manifest changes,
  and a rollback brings back the older versions. **Keys the manifest doesn't name are left as they are:** AssetSync
  never deletes builders' content. A key dropped from the manifest keeps its last live copy.
- **Clones never count.** A clone keeps the tag and the attributes, but only the copy whose parent is its
  `TypeTorchAssetPath` (stamped by AssetSync) is the live one. So a template cloned into PlayerGui never shows up in
  `get()`, and AssetSync never destroys it.
- **Dev menu:** Modules > Assets (Server | Client) lists each key's source (kept, baked, loaded, failed), version,
  load time and last error.

## Develop

```sh
bun install
bun run build   # rbxtsc --type package -> out/
```

- **Explorer class icons:** `assets/class-icons.png` is the client's `content/textures/ClassImages.PNG` (a 2352x16
  strip) repacked into a 32-column grid, because live clients downscale textures wider than 1024 px:
  `ffmpeg -i ClassImages.PNG -vf "untile=147x1,tile=32x5:color=0x00000000" class-icons.png`. It is uploaded as image
  `rbxassetid://97389585475400`; `scripts/gen-explorer-icons.ts` generates the index table.

MIT licensed.
