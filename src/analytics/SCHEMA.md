# TypeTorch analytics: the contract (v1)

What `AnalyticsEngine` (this folder) writes, and what the read side (`@typetorch/analytics`, the DuckDB server, the
Basin stream schemas) reads. TypeScript types: `schema.ts`. Column order and encoding: `sinks.ts`. Plan: plans/16.
Change this file and the types together; a breaking change bumps `v`.

## Tables

Rows are flat JSON objects. Every column is always present (no nulls): missing values are `0`, `false` or `""`.
Integers are written with every digit (never exponent notation).

### events

| Column | Type | Meaning |
|---|---|---|
| `v` | int32 | Row format version: `1` |
| `t` | int64 | Unix ms on the game server's clock. Client events are corrected by the server (`server now - age - ping/2`) |
| `kind` | string | `session`, `tech`, `zone`, `funnel`, `purchase`, `currency`, `state`, `experiment`, `custom`, `recording_meta`, `fleet` |
| `name` | string | Event name (1-64 chars), see below |
| `pid` | string | Random player id (32 hex chars; `t` + 31 hex = temporary, the player-id store couldn't be read). `""` for server-only events. Never the UserId |
| `sid` | string | Session id (32 hex), new per join, kept across hot swaps. `""` for server-only events |
| `job` | string | `game.JobId` (`""` in Studio) |
| `srv` | string | Server type: `public`, `private`, `reserved`, `studio` |
| `place` | int64 | `game.PlaceId` |
| `art` | string | Artifact id that was live on the server |
| `seq` | int64 | That artifact's deploy seq (`0` when unknown) |
| `branch` | string | Server branch |
| `channel` | string | Effective channel: `prod` or `dev` |
| `dev` | string | The session's device class: `desktop`, `phone`, `tablet`, `console`, `vr`, `unknown`. Set once per session from the client's first hello (`unknown` for server-only events and until the client reports; frameworks after 0.4.2 keep it when a later hello says otherwise). How it is decided: the `session` / `device` row below |
| `newp` | bool | The event belongs to the player's first-ever session |
| `state` | string | The player's state **after** this event: `zone:<z>\|screen:<s>\|activity:<a>`, empty parts left out (`""` when nothing is known). Server-only events: `activity:<server activity>` or `""` |
| `exp` | string | JSON object of the player's active experiments, `{"onboarding":"short"}`; `{}` when none |
| `sexp` | string | The server's experiment: the artifact id of a kernel A/B experiment pin, or `""` |
| `src` | string | `server`, or `client` (sent by a client: it can lie; the server checked shapes and rate). Never `client` on `purchase` or `currency` rows |
| `props` | string | JSON object text, at most 4096 bytes. Too large: `{"_trunc":<bytes>}`; not encodable: `{"_err":"encode"}`; a non-object value `x`: `{"value":x}` |

### recordings

First-ever-session detail, one row per packed chunk.

| Column | Type | Meaning |
|---|---|---|
| `v` | int32 | `1` |
| `t` | int64 | Chunk start, unix ms (server clock, corrected like client events) |
| `pid` | string | As events |
| `sid` | string | As events |
| `job` | string | As events |
| `art` | string | As events |
| `chunk` | int32 | 0, 1, 2... per session (a gap means a chunk was lost) |
| `codec` | string | `tt-rec-1` |
| `data` | string | Standard base64 (padded) of the packed chunk, layout below |
| `n` | int32 | Position samples in the chunk (`Sample` + `Camera` records) |

## Event catalog

`src` is `server` unless noted. Props marked `?` are left out when unknown. Game-code helpers are in the last block.

| kind | name | props |
|---|---|---|
| session | `join` | `from`: `direct` (Home, search, sorts: Roblox doesn't say), `teleport` (same game), `teleport_game` (another game), `referral` (invite/referral link), `share` (launch data), `follow` (followed someone); `ctx?` (GameJoinContext.JoinSource name); `tp?` (had teleport data); `party?` (players teleported along); `age` (account age: `<1d`, `1-7d`, `7-30d`, `30-90d`, `90-365d`, `1-3y`, `3y+`); `prem` (Premium); `country?` (ISO code); `friends` (how many of the player's friends are in the server: one friend-list lookup per join, at most 10 pages, `0` when it fails); `ret` (days since the last visit, `-1` first visit or unknown); `late?` (the engine started over 60 s after the join). `t` is the join time |
| session | `device` (src client) | `dev?` (the device class, as the `dev` column; frameworks after 0.4.2, older ones leave it out), `input` (`kbm`, `touch`, `gamepad`, `vr`, `unknown`), `w`, `h` (viewport points), `touch`, `kb`, `mouse`, `pad`, `vr`. Once per session. The class (Roblox gives game scripts no OS): `vr` when VRService.VREnabled; `console` when GuiService:IsTenFootInterface(); touch without a keyboard: `tablet` when the viewport's short side is 600 points or more, else `phone` (the first hello waits up to 2 s for a real viewport); a keyboard or mouse: `desktop` (touch laptops, tablets with a keyboard); else `unknown` |
| session | `leave` | `secs` (session length), `why`: `left`, `shutdown`, `gone` (left while no generation ran the engine), `swap60?` (left within 60 s of a hot swap) |
| tech | `server` | Every `techEvery` s: `fps` (physics), `hb` (Heartbeat rate), `mem` (MB, 10s), `players`, `ping50?`, `ping90?` (ms), `q`, `qr` (queued events, recordings), `dropped`, `sent`, `fails`, `health?`, `errors?` (kernel 0.3.2 health) |
| tech | `client` (src client) | Every `techEvery` s: `fps`, `mem` (MB, 10s), `ping?` (ms) |
| tech | `load` (src client) | `secs`: from the client starting to the engine starting (first client generation only) |
| tech | `error` | Server or client (src). `msg` (first 300 chars, player names replaced by `<player>`), `n` (times in the window). At most 10 per tech tick (server), 5 per 30 s and 100 per session (client) |
| tech | `start` | First generation of a server that runs the engine: `gen`, `kernel`, `load?` |
| tech | `swap` / `rollback` | A generation started by a hot swap (`rollback` for rollback reasons), 5 s after it started: `reason`, `from?` (previous artifact id), `gen`, `load?`, `stop?`, `swap?` (seconds), `players` |
| tech | `swap_out` | Just before a generation stops: `reason`, `next?` (next artifact id), `players` |
| zone | `enter` | `zone`, `from` (previous zone or `""`) |
| zone | `leave` | `zone`, `to?`, `secs` |
| state | `activity` | `to`, `from` (server or client src) |
| state | `screen` | `to`, `from` (`""` = none). Client: ScreenGuis in PlayerGui (Enabled), GuiObjects tagged `TTScreen` (Visible), `screen()` |
| experiment | `<experiment>` | `variant`, `variants` (count), `forced?`. Once per session when assigned or changed. At most 32 experiments per session: a 33rd `experiment()` returns the control (the first variant) and warns. A client's experiment calls count against its event budget (below) |
| recording_meta | `start` | `share` (the recorded share then) |
| recording_meta | `end` | `chunks`, `bytes`, `why`: `window` (60 s after the first input), `cap` (10 min, or the server's 256 KB / 80 chunks), `left`, `end` |
| fleet | `heartbeat` | The kernel's `fleetStatus()` (kernel 0.3.2+), every 60 ± 10 s and once at each generation start. pid `""` |
| fleet | `deploy_report` | One kernel deploy report `{s, b, a, j, r, e?, d?, t, g, k, p}` (r: `swapped`, `failed`, `rolled_back`, `skipped`, `booted`), once per (s, j, r) per server, across generations. pid `""` |
| custom | `<name>` | `track(name, props)`: the game's props |
| funnel | `<funnel>` | `step(funnel, index, name?)`: `i`, `step?` |
| purchase | `<kind>` | Server only. `purchase(player?, {product, robux, where?, kind?})`: name = `kind` (default `product`); `product`, `robux`, `where?` |
| currency | `<currency>` | Server only. `currency(player?, name, delta, reason)`: `delta`, `reason` |

Client-sent kinds are limited to `custom`, `funnel`, `state`, `tech`, within a budget of 120 a minute and 5,000 a
session per player. `purchase` and `currency` are server-only (revenue and the economy are server-authoritative): on
the client `purchase()` and `currency()` warn once and send nothing, the server refuses those kinds from clients, and
the analytics server's ingest refuses such rows marked `src = client` (older engines let clients send them). Revenue
counts only server-sent `purchase` rows; rows from before `src` existed (no `src`) still count.

## tt-rec-1

Little-endian. A chunk decodes on its own (own anchor, own string table). Reference decoder: `decodeChunk` in
`codec.ts`; tests: `scripts/test-analytics.luau`.

Header (4 bytes): `u8 version` (1), `u8 flags` (bit 0: last chunk of the recording), `u16 sample interval ms` (100).

Then records. Every record starts with `u8 tag, u16 dt`: ms since the previous record (the first: since the chunk
start, i.e. the row's `t`). Time is the running sum of `dt`.

| Tag | Record | Payload after tag + dt |
|---|---|---|
| 0 | Wait | none (a gap over 65535 ms) |
| 1 | Anchor | `f32 x, y, z`: origin for the positions that follow (studs) |
| 2 | Sample | `i16 x, y, z` character position, 1/8 stud from the anchor; `u8` character yaw; `i16 x, y, z` camera position minus character position, 1/16 stud (clamped at ±2047 studs); `u8` camera yaw; `i8` camera pitch (15 bytes) |
| 3 | Camera | no character: `i16 x, y, z` camera position, 1/8 stud from the anchor; `u8` yaw; `i8` pitch (8 bytes) |
| 4 | Key | `u8 kind` (bit 7: the game processed it, e.g. typed into UI), `u16 code` (3 bytes) |
| 5 | Pointer | `u8 kind` (bit 7 as Key), `u16 code`, `u16 x`, `u16 y` (0..65535 across the viewport, top-left origin, from InputObject.Position) (7 bytes) |
| 6 | String | `u16 id`, `u8 length`, UTF-8 bytes: defines string `id` (0, 1, 2...) for the rest of the chunk (at most 255 bytes) |
| 7 | Event | `u8 kind`, `u16 string id` (65535: none) (3 bytes) |

- **Angles:** yaw byte `b` -> `b / 256 * 2π - π` radians, yaw 0 = facing -Z, `yaw = atan2(-look.X, -look.Z)`. Pitch
  byte `p` (signed) -> `p / 127 * π/2` radians, up positive.
- **Anchor:** a chunk's first position record is preceded by an Anchor; a new Anchor follows whenever a position is
  more than ±4095 studs from the current one.
- **Sampling:** about 10 Hz; a sample identical to the previous one (1/8 stud, ~1.4 degrees) is skipped, but one is
  written at least every 5 s.
- **Key / Pointer kinds:** 1 key down, 2 key up (code = `Enum.KeyCode.Value`); 3 mouse down, 4 mouse up (code =
  `Enum.UserInputType.Value`: MouseButton1 0, MouseButton2 1, MouseButton3 2); 5 touch start, 6 touch end (code 0);
  7 gamepad button down, 8 up (KeyCode value); 9 thumbstick start, 10 thumbstick stop (KeyCode value of
  Thumbstick1/2); 11 scroll (Pointer, code 1 up, 2 down; at most 5 a second). Keys are never recorded while a TextBox
  or the chat has focus.
- **Event kinds (text):** 1 button activated (path under PlayerGui, e.g. `Shop/Buy/Coins100`), 2 button hovered (path;
  once per second per button), 3 screen opened (name), 4 screen closed (name), 5 prompt shown, 6 prompt hidden,
  7 prompt triggered (ProximityPrompt path under Workspace, a character as `<player>`), 8 died (no text), 9 spawned
  (no text), 10 text box used (path, or `<other>`; never its text), 11 the game's own `track()` event (name).
- **Window:** from the engine's start on the client until 60 s after the first key, click, tap, gamepad button or
  stick; at most 10 minutes. Chunks are cut about every 10 s or 6 KB (and at a hot swap). Typical: 10-20 KB per player.

## Sink settings

The signed settings record's `analytics` field (kernel 0.3.8, plans/20; server-only; before 0.3.8 the ConfigService key
`TypeTorchAnalytics`), a JSON object, written with `typetorch settings set analytics -` (JSON on stdin; the analytics
repo's `bun run local` does it). Every new signed copy applies at once, so dials change live (the CLI pings servers).
`new AnalyticsEngine({ settings })` replaces it (tests, Studio, kernels before 0.3.8).

```json
{
  "backend": "basin",
  "events": "https://<events-stream-id>.ingest.cloudflare.com",
  "recordings": "https://<recordings-stream-id>.ingest.cloudflare.com",
  "token": "<write-only token>",
  "flushSeconds": 15,
  "recordShare": 1,
  "techEvery": 60,
  "experiments": { "onboarding": { "active": true, "weights": [1, 1], "variant": "short" } }
}
```

| Field | Default | Meaning |
|---|---|---|
| `backend` | required | `basin` or `duckdb` |
| `events` | required | http(s) URL. basin: the events stream; duckdb: the server's ingest URL |
| `recordings` | none | basin: the recordings stream (none: nothing is recorded); duckdb: unused |
| `token` | none | Sent as `Authorization: Bearer <token>`. Never logged |
| `flushSeconds` | 15 | 5..300 |
| `recordShare` | 1 | 0..1, share of new players recorded (stable per pid) |
| `techEvery` | 60 | 15..3600 seconds between tech samples |
| `experiments` | none | Per experiment: `active: false` (everyone gets the first variant, not stamped), `weights` (per variant, in the game's order), `variant` (force one) |
| `identity` | the settings' `fleet` url + `/v1/identity` | basin: where identity rows go (below); none and no `fleet` in the settings: not sent. duckdb: unused |
| `identityToken` | the settings' `fleet` token | basin: the token for `identity`. Never logged |

Unknown fields are ignored. Settings errors are warned once (never with the token).

## Transport

- **basin:** `POST <events>` with a JSON array of event rows and `POST <recordings>` with a JSON array of recording
  rows. `Content-Type: application/json`, `Authorization: Bearer <token>` when set, no compression.
- **duckdb:** `POST <events>` with `{"events":[...],"recordings":[...]}`, gzip (`Content-Encoding: gzip`, HttpService
  `Compress`), `Content-Type: application/json`, `Authorization: Bearer <token>`. With identity rows waiting, the body
  also has `"identities":[...]`.
- **Identities** (engine option `identity`, default on): once a player's pid is known, one row `{ "pid", "uid", "t" }`
  (the UserId as a number, unix ms; nothing else about the player) per session, so the dev's own server can map pids
  and UserIds (support, Right to Erasure) and delete the link. Never part of the events table. duckdb: in the batch
  body; basin: `POST <identity>` with `{"identities":[...]}` and `Authorization: Bearer <identityToken>` (Basin rows
  can't be deleted, so they never go to Basin). At most 200 per request; 500 wait at most.
- **Batches:** every `flushSeconds`, or at 500 queued events or 20 recordings. At most 500 event rows (fleet rows
  first) and 50 recording rows per request, about 900 KB each. At most ~10 requests a minute per server (burst 3).
- **Answers:** 2xx sent; 413 the batch is halved and resent (a single row is dropped); 401/403/404 rows are kept and
  sending waits about 300 s (225-375 s, jittered; or until the settings change); 408/429/5xx/no answer retry with
  backoff 5, 10, 20... 300 s (each +-25%); other 4xx drop the batch (counted as rejected).
- **Failure log and status:** at most one log line a minute (the reason and the fix from `hints.ts`, the streak, the next
  try; later lines say how many were held back) and one line when uploads work again. `stats()`: `failures` (in a
  row), `failed` (total), `lastError`, `lastStatus` (0: no answer, an `HttpError` such as NetFail / DnsResolve),
  `lastErrorAt`, `lastOkAt`, `retryIn`, and while failing `reason` and `fix`. The dev menu reads them through
  `analytics/status.ts`.
- **Delivery is at least once:** a hot swap during a request sends its rows again. Readers may drop exact duplicate
  rows.
- **The cloud test sends nothing:** inside `typetorch test --cloud` (the stub kernel's `test = true`, or the workspace
  attribute `TypeTorchTest`) rows are collected as usual but dropped at each flush: no event, recording or identity
  rows and no HTTP request, so a deploy never puts a fake server session into the analytics.
- **Queue:** 10,000 events (1,000 while no settings are known), 2,000 fleet rows, 300 recording chunks; over a cap the
  oldest are dropped and counted (`tech/server` `dropped`). The queue lives in the kernel's persist store across hot
  swaps and is flushed on shutdown (kernel 0.3.2 onClose; older kernels: one BindToClose relay).

## Player ids

DataStore `TypeTorchAnalytics`, key `p/<UserId>` -> `{ "pid": "<32 hex>", "first": <unix s>, "last": <unix s> }`.
One read per join (with retries), a write on the first join (UpdateAsync, keeps a pid another server wrote first) and
one at leave (`last`). A Right to Erasure request deletes the key, which leaves the player's rows anonymous. The
analytics server also keeps pid -> UserId from identity rows (above), which its erasure webhook uses and deletes.

## Suggested Basin stream schemas

Basin drops rows that don't match a structured schema (silently), so the streams must match the columns above:

```json
{ "fields": [
  { "name": "v", "type": "int32", "required": true },
  { "name": "t", "type": "int64", "required": true },
  { "name": "kind", "type": "string", "required": true },
  { "name": "name", "type": "string", "required": true },
  { "name": "pid", "type": "string", "required": true },
  { "name": "sid", "type": "string", "required": true },
  { "name": "job", "type": "string", "required": true },
  { "name": "srv", "type": "string", "required": true },
  { "name": "place", "type": "int64", "required": true },
  { "name": "art", "type": "string", "required": true },
  { "name": "seq", "type": "int64", "required": true },
  { "name": "branch", "type": "string", "required": true },
  { "name": "channel", "type": "string", "required": true },
  { "name": "dev", "type": "string", "required": true },
  { "name": "newp", "type": "bool", "required": true },
  { "name": "state", "type": "string", "required": true },
  { "name": "exp", "type": "string", "required": true },
  { "name": "sexp", "type": "string", "required": true },
  { "name": "src", "type": "string", "required": true },
  { "name": "props", "type": "string", "required": true }
] }
```

```json
{ "fields": [
  { "name": "v", "type": "int32", "required": true },
  { "name": "t", "type": "int64", "required": true },
  { "name": "pid", "type": "string", "required": true },
  { "name": "sid", "type": "string", "required": true },
  { "name": "job", "type": "string", "required": true },
  { "name": "art", "type": "string", "required": true },
  { "name": "chunk", "type": "int32", "required": true },
  { "name": "codec", "type": "string", "required": true },
  { "name": "data", "type": "string", "required": true },
  { "name": "n", "type": "int32", "required": true }
] }
```
