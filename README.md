# @typetorch/framework

The roblox-ts framework of [TypeTorch](https://github.com/typetorch): hot-swappable modules (dependency injection,
lifecycle, troves), guarded networking over the kernel's stable remotes, UI helpers and the in-game dev menu.

It ships **inside every artifact**, so each generation runs its own fresh copy and framework fixes hot-swap like game
code. It needs the TypeTorch kernel in the place (`@typetorch/kernel`), which calls your `Server/boot` and
`Client/boot` modules.

## Install

```sh
npm i @typetorch/framework
npm i -D @typetorch/transformer
```

(`bun add @typetorch/framework` and `bun add -d @typetorch/transformer` work the same.) The framework is a roblox-ts 3
package; `@typetorch/transformer` is its compiler plugin: it generates the network guards, the constructor dependency
ids of `@Service` / `@Controller` and your own macros. Nothing from Flamework is needed: `Modding`, `Reflect` and `t`
come from this package. The starter game ([template](https://github.com/typetorch/template)) has it all set up: clone
it and run `bun install`.

`tsconfig.json`:

```jsonc
{
	"compilerOptions": {
		"experimentalDecorators": true,
		// Every npm scope the game imports from must be a type root (roblox-ts rule).
		"typeRoots": ["node_modules/@rbxts", "node_modules/@typetorch"],
		"types": ["types", "compiler-types"],
		"plugins": [
			// Optional, first when present: $print/$warn with file and line (what every TypeTorch repo uses).
			{ "transform": "rbxts-transform-debug", "environmentRequires": {} },
			{ "transform": "@typetorch/transformer" }
		]
	}
}
```

The payload is a Rojo `Model` project. Map only this package from the `@typetorch` scope (the transformer is Node code
and the kernel lives in the place):

```json
"include": {
	"$path": "include",
	"node_modules": {
		"$className": "Folder",
		"@rbxts": { "$path": "node_modules/@rbxts" },
		"@typetorch": { "$className": "Folder", "framework": { "$path": "node_modules/@typetorch/framework" } }
	}
}
```

Each generation requires its own copy of the payload, so the framework and its `Reflect` registry start fresh on every
swap. It needs the TypeTorch kernel in the place (`@typetorch/kernel`).

### Coming from Flamework

Game code only changes imports: `@Service`, `@Controller`, constructor injection, the lifecycle interfaces and
`createNetwork` are the same.

| Flamework | TypeTorch |
|---|---|
| `rbxts-transformer-flamework` plugin, `node_modules/@flamework` type root | `@typetorch/transformer` plugin, `node_modules/@typetorch` type root |
| `import { Modding, Reflect } from "@flamework/core"` | `import { Modding, Reflect } from "@typetorch/framework"` |
| `import { t } from "@rbxts/t"` (still fine) | also `import { t } from "@typetorch/framework"` |
| `@metadata flamework:parameters` keys, `"flamework:parameters"` metadata | `@metadata typetorch:parameters`, `"typetorch:parameters"` |
| `flamework.build`, `include/flamework`, the `@flamework` Rojo mapping | gone; delete them |

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
- **Bad deploys roll back (kernel 0.3.2):** a server `onStart` that throws is reported to the kernel, which rolls the
  server back to its last known good artifact when it happens within 30 s of start (so do 3 errors from the new
  code's scripts in that time). On a real shutdown every module's `onStop` runs too (the kernel's BindToClose).
- **Troves:** every module gets `this.trove`; everything it creates or connects goes there, so a swap leaves nothing
  behind. `TypeTorch.persist(key, init)` (or `this.ctx.persist`) keeps plain data across swaps.
- **Network:** `createNetwork<C2S, S2C>()` with nested namespaces. The server checks rate limits, shape limits and the
  generated type guard on every client message. `setNetworkLimits({ "chat.say": { maxString: 200 } })` tunes a leaf.
  Across a swap (0.2.1): what the server sends a player waits until that player's client runs the new generation
  (reliable messages are queued, unreliable ones dropped), and on kernel 0.3.2 a request the server can no longer
  answer fails at once ("The game is updating, try again.") instead of timing out.
- **Macros:** `Modding` (from this package) declares compile-time macros that `@typetorch/transformer` fills in:
  `/** @metadata macro */ export function guardOf<T>(guard?: Modding.Generic<T, "guard">) { return guard!; }` makes
  `guardOf<Shape>()` compile to a `t` guard. `Modding.Generic<T, "id" | "text">`, `Many`, `Caller` and `TupleLabels`
  work the same way; see the transformer's README.
- **UI:** `observeElement(trove, tag, (instance, elementTrove) => ...)`, `isRealFrame`, `popIn` / `popOut` / `bump`
  (UIScale, never Size tweens) and `PopupQueue` (one modal at a time).
- **Dev menu:** devs (Studio, project members, dev badge) get a DEV button, `Ctrl+Shift+D` and `/tt dev`: artifact,
  server status, logs (server, own client, other players' clients), client and server dex, network stats, module
  state, a branch and artifact picker (Server > Branch) and a Claude prompt. Prod-channel servers are read-only. The
  window can be dragged by its header and resized from its corner (double-tap the header to reset). Modules has
  Overview, State and Assets (hot assets), each with a Server | Client toolbar. In the Dex,
  right-click or long-press a property for Copy value / Copy name and a tree row for Copy path (Roblox has no
  clipboard, so copying opens a small popup with the text selected: Ctrl+C, or long-press > Copy on touch).
- **Remote Claude** (dev-channel servers only): while `typetorch remote-claude` (`@typetorch/dev-server`) runs on a dev's machine, allowlisted
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
  doesn't run on server shutdown (kernel 0.3.2 runs `onStop` then; on older kernels use `game.BindToClose`).
- **Kernel versions:** `TypeTorch.features` says what the running kernel supports. Kernel 0.2.2 adds the start
  reason and timings, the next artifact in `onSwapOut`, `onUpdatePending`, server-side `onPlayerDevChanged` and
  `requestReload`. On older kernels `startInfo` still knows boot vs swap, the previous artifact and branch (the
  framework records them), `onBranchChanged` still fires, and the reason of a swap is `unknown`.
- **Edit mode** (UI Labs stories, no kernel): `running` is false, identity has defaults, `persist` keeps a local table,
  events never fire, and the server-only reads throw.

## Player data

Saving player data is game code: pick any library (ProfileStore, DataStore2, your own). TypeTorch only gives you the
pieces that keep it safe across swaps:

- **The library lives in the place**, outside the payload, and a small place Script requires it first. Its open
  sessions, autosave loop and shutdown hook then survive every swap (a swap stops the generation's scripts).
- **Session handles live in `persist`**, keyed by `UserId`. `onPlayerAdded` replays everyone after a swap, so it
  re-attaches to the open session instead of loading again.
- **Release only on `Players.PlayerRemoving`**, never in `onStop` or `onSwapOut`.
- **Split store names by channel** (`TypeTorch.channel === "prod" ? "PlayerData" : "PlayerData_dev"`).

Full example with ProfileStore: [Player data guide](https://github.com/typetorch/docs/blob/main/guides/player-data.md).

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

## Analytics: `AnalyticsEngine`

Optional, and all ours: the game server sends rows to the backend the dev picked (Cloudflare Basin streams, or a
self-hosted DuckDB analytics server). Nothing runs until an engine is created: no connections, threads or requests.

```ts
import { AnalyticsEngine } from "@typetorch/framework";

// A server module (onInit): reads the ConfigService key TypeTorchAnalytics.
const analytics = new AnalyticsEngine();
analytics.track(player, "quest_done", { quest: "tutorial" }); // custom
analytics.step(player, "onboarding", 3, "opened_shop"); // funnels
analytics.purchase(player, { product: 1234, robux: 99, where: "shop" }); // after the receipt is granted
analytics.currency(player, "coins", 50, "round_reward"); // economy in (+) and out (-)
analytics.state("round"); // every player's activity; analytics.state(player, "shop") for one
const variant = analytics.experiment(player, "onboarding", ["short", "long"]); // first = control

// A client controller (onStart): everything goes through the server, never to the internet.
const analytics = new AnalyticsEngine();
analytics.track("opened_map");
analytics.screen("Inventory"); // for UIs that aren't separate ScreenGuis
const variant = analytics.experiment("onboarding", ["short", "long"]); // same answer as the server's
```

- **One engine per generation and realm.** Every `new AnalyticsEngine()` joins the one already running (the first one's
  options win), so any module can create its own. It stops with the generation; its unsent rows wait in `persist`
  and the next generation sends them. In edit mode (UI Labs) it is inert.
- **Server calls take the player first** (`track(player, ...)`); without one an event is server-only (no player id).
  Client calls are always about the local player and are marked `src = "client"` (a client can lie). The server
  checks their shape, size (props at most 4 KB) and rate.
- **Options** (all on by default): `sessions` (joins, leaves, device, join source, account age bucket, Premium,
  country, friends in the server, first-ever vs returning, days since the last visit), `tech` (FPS, ping, memory, load
  time, client and server errors, swaps and rollbacks, leaves within 60 s of a swap), `zones` (parts or models tagged
  `TTZone`, named by a `Name` attribute or the instance name), `screens` (ScreenGuis in PlayerGui, GuiObjects tagged
  `TTScreen`), `recording` (the first-ever session in detail), `fleet` (kernel 0.3.2 heartbeats and deploy reports).
  `settings` (server only) replaces the ConfigService key, for tests.
- **Every row** carries the time (server clock), a random player id (never the UserId), the session, the server
  (JobId, type, place), the artifact (id, seq, branch, channel), the device, new vs returning, the player's state
  (`zone:Lobby|screen:Shop|activity:round`) and experiment variants. The exact rows: `src/analytics/SCHEMA.md`.
- **Experiments:** `experiment(...)` is deterministic per player and name (they keep their variant in every session),
  may yield briefly the first time (until the player's id loads), and stamps the variant on the player's later events.
  The settings key turns one off (`active: false`: everyone gets the first variant), sets `weights` or forces a
  `variant`, live.
- **First-ever session:** for new players (a share of them, `recordShare`), the client records character and camera
  about 10 times a second, every input (never while a TextBox or the chat has focus; text boxes only say which box was
  used), buttons pressed and hovered, screens, prompts and deaths, from the join until 60 s after the first input.
  Packed into small binary chunks (10-20 KB a player) and sent through the server.
- **Never collected:** chat or anything typed, usernames and display names (error texts have them replaced), UserIds.
- **Player ids:** DataStore `TypeTorchAnalytics`, key `p/<UserId>` -> `{ pid, first, last }`: one read per join, a
  write on the first join and at leave. Deleting the key (Right to Erasure) leaves that player's rows anonymous.
- **Sending:** one queue on the server (10,000 events; over that the oldest are dropped and counted), a flush every
  `flushSeconds` (15) or at 500 rows, at most ~10 HttpService requests a minute, retries with backoff, and a last
  flush on shutdown (kernel 0.3.2). Delivery is at least once (a swap mid-request sends that batch again).
  `analytics.stats()` (server) has the counters; `flush()` sends soon.

**Settings** (server only, never sent to clients): the ConfigService key `TypeTorchAnalytics`, written by the CLI or in
Creator Hub (Configs), re-read live every few minutes:

```json
{ "backend": "basin", "events": "https://<stream-id>.ingest.cloudflare.com",
  "recordings": "https://<stream-id>.ingest.cloudflare.com", "token": "<write-only token>",
  "flushSeconds": 15, "recordShare": 1, "techEvery": 60,
  "experiments": { "onboarding": { "weights": [1, 1] } } }
```

- `basin`: a JSON array per stream (`events`, `recordings`), `Authorization: Bearer <token>` when set (a token with
  Basin Pipelines Send permission, if the stream requires authentication). Without `recordings` nothing is recorded.
  The streams' schemas must match SCHEMA.md exactly: Basin drops rows that don't, silently.
- `duckdb`: one `POST <events>` with `{"events":[...],"recordings":[...]}`, gzip, `Authorization: Bearer <token>`.
- The token is write-only and never logged. Needs **Allow HTTP Requests** (Game Settings > Security). No key: the
  engine collects but keeps only the newest 1,000 rows until settings appear. Removing the key stops sending, live.

## Develop

```sh
bun install
bun run build   # rbxtsc --type package -> out/
```

- **Runtime of the transformer:** `src/reflection/` (`Reflect`, `Modding`, `t`) is a copy of
  `@typetorch/transformer`'s `runtime-kit/`; keep the two identical.
- **Tests (Lune, offline):** `scripts/test-*.luau`; each file's header has its command (Lune is pinned in the
  kernel's and the template's `rokit.toml`). `scripts/test-generations.luau` takes a game's built payload:
  `cd ../template && bun run payload && lune run ../framework/scripts/test-generations.luau build/payload.rbxm` boots
  two generations in one VM and checks fresh registries, DI and generated guards, then runs the real `startServer`
  with stub kernels (onStart failures reported to kernel 0.3.2, raised on older ones; onClose) and the health lines.
  To test framework changes before the template takes them, build the payload from a copy of the template whose
  `node_modules/@typetorch/framework/out` is this repo's `out/`.
  `scripts/test-analytics.luau` checks the analytics engine's pure parts (experiment assignment, settings, the queue
  and HTTP budget, tt-rec-1, the sink request bodies); `test-analytics-server.luau` and `test-analytics-client.luau`
  run the compiled server and client cores against mocked services (sessions, intake, retries, a swap with a request
  in flight, shutdown; the recorder, screens, batching).
- **Publishing:** `npm publish` runs `prepublishOnly` (clean + build). The package ships only `out/` (no
  `.tsbuildinfo`), `README.md` and `LICENSE`; check with `bun pm pack --dry-run`.

- **Explorer class icons:** `assets/class-icons.png` (kept locally, not in the repo: it is Roblox's own texture) is
  the client's `content/textures/ClassImages.PNG` (a 2352x16 strip) repacked into a 32-column grid, because live
  clients downscale textures wider than 1024 px:
  `ffmpeg -i ClassImages.PNG -vf "untile=147x1,tile=32x5:color=0x00000000" class-icons.png`. It is uploaded as image
  `rbxassetid://97389585475400`; `scripts/gen-explorer-icons.ts` generates the index table.

MIT licensed.
