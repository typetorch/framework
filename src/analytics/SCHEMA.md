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
| `kind` | string | `session`, `tech`, `zone`, `funnel`, `purchase`, `currency`, `state`, `experiment`, `custom`, `recording_meta`, `fleet`, `notify`, `feedback` |
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

First-ever-session detail, one row per packed chunk: `tt-rec-1` (always, when the session is recorded) and, for
extended sessions (plans/36), `tt-ext-1` rows next to them (same `sid`, their own `chunk` counter). Queries that read
one codec filter on `codec`.

| Column | Type | Meaning |
|---|---|---|
| `v` | int32 | `1` |
| `t` | int64 | Chunk start, unix ms (server clock, corrected like client events) |
| `pid` | string | As events |
| `sid` | string | As events |
| `job` | string | As events |
| `art` | string | As events |
| `chunk` | int32 | 0, 1, 2... per session and codec (a gap means a chunk was lost) |
| `codec` | string | `tt-rec-1`, or `tt-ext-1` (the extended recording) |
| `data` | string | Standard base64 (padded) of the packed chunk, layouts below |
| `n` | int32 | tt-rec-1: position samples in the chunk (`Sample` + `Camera` records); tt-ext-1: records in the chunk |

## Event catalog

`src` is `server` unless noted. Props marked `?` are left out when unknown. Game-code helpers are in the last block.

| kind | name | props |
|---|---|---|
| session | `join` | `from`: `direct` (Home, search, sorts: Roblox doesn't say), `teleport` (same game), `teleport_game` (another game), `referral` (invite/referral link), `notification` (a TypeTorch notification's launch data verified), `share` (other launch data), `follow` (followed someone); join metadata (plans/29): `src_place?`, `src_game?` (SourcePlaceId / SourceGameId), `ref?` / `follow?` (the referrer / followed user as their pid when this game knows them, else `"other"`: never a UserId; players in the server are free, others cost one DataStore read each, at most 2 per join and only with read budget to spare), `party?` (players teleported along) + `party_pids?` (the pids of those this game knows, at most 10), `ctx?`, `ctx_item?`, `ctx_asset?`, `ctx_outfit?`, `ctx_asset_type?` (GameJoinContext JoinSource / ItemType / AssetId / OutfitId / AssetType), `launch?` (`notification` + `nid`, `nk` (kind); `tt_bad` + `launch_bad` (`format`, `sig`, `user`, `old`); or the game's own launch data: `launch_len`, plus its first 32 chars in `launch` only with the settings' `joinLaunchPrefix`), `tp?` + `tp_bytes?` (TeleportData present, its JSON size; never the content), `age_days` (exact account age), `locale?`, `verified?` (HasVerifiedBadge), `membership` (MembershipType name); `age` (account age: `<1d`, `1-7d`, `7-30d`, `30-90d`, `90-365d`, `1-3y`, `3y+`); `prem` (Premium); `country?` (ISO code); `pol` (the player policy, PolicyService:GetPolicyInfoForPlayerAsync with a 5 s deadline: `ok`, `failed`, `timeout`) and with `ok` `pol_ads`, `pol_rand` (ArePaidRandomItemsRestricted), `pol_trade` (IsPaidItemTradingAllowed), `pol_share` (IsContentSharingAllowed), `pol_subs` (IsEligibleToPurchaseSubscription), `pol_cn` (IsSubjectToChinaPolicies), `pol_links` (AllowedExternalLinkReferences, comma separated); `trust?` (Player.DeviceTrustLevel at the join, usually `Pending`: the leave row has the settled level); `friends` (how many of the player's friends are in the server: one friend-list lookup per join, at most 10 pages, `0` when it fails); `ret` (days since the last visit, `-1` first visit or unknown); `late?` (the engine started over 60 s after the join); `jd?` (plans/30, with the settings' `joinData` `"full"`, the default: the raw join data, below). With `joinData` `"off"` only `from`, `ctx`, `tp`, `party`, `age`, `prem`, `country`, `friends`, `ret`, `late` are written. `t` is the join time |
| session | `device` (src client) | `dev?` (the device class, as the `dev` column; frameworks after 0.4.2, older ones leave it out), `input` (`kbm`, `touch`, `gamepad`, `vr`, `unknown`), `w`, `h` (viewport points), `touch`, `kb`, `mouse`, `pad`, `vr`. Once per session. The class (Roblox gives game scripts no OS): `vr` when VRService.VREnabled; `console` when GuiService:IsTenFootInterface(); touch without a keyboard: `tablet` when the viewport's short side is 600 points or more, else `phone` (the first hello waits up to 2 s for a real viewport); a keyboard or mouse: `desktop` (touch laptops, tablets with a keyboard); else `unknown` |
| notify | `want`, `drop` | Notifications (plans/29), written by the game server: `k` (kind), `key?` (first 12 hex of SHA-256 of the intent's key; never the key), `at?`, `until?`, `offline` (want: the user isn't in this server; the row then has no pid), `why?` (drop) |
| notify | `optin_check`, `optin_shown`, `optin_closed` | The client's opt-in prompt, checked and written by the server (at most 3 of each per session): `where`, `can` (check), `err?` (`timeout`, `swap` or the error's first 64 chars), `secs` (closed: how long it was up) |
| notify | `open`, `open_bad`, `played` | A join from a notification: `open` (`nid`, `k`, `age` (secs since sent), `first`), `open_bad` (`why`: `format`, `sig`, `user`, `old`), `played` (`nid`, `k`, `secs`: the opened session's length, at its end). Backend rows of the same kind (`planned`, `sent`, ...) come from `src = "backend"` |
| feedback | `submit` | Player feedback (plans/32): `TypeTorch.feedback().submit(player, ...)`, checked and written by the game server (a client never writes this kind; no UserId or username: pid → user through the identity store). `scale` (the configured scale's id, e.g. `faces5`, `stars5`; text-only rows carry it too), `type` (`thumbs`, `stars`, `scale`), `steps` (thumbs 2, stars / scale 2..10), `r?` (thumbs `0` down / `1` up; stars / scale `1..steps`; left out for text-only feedback), `norm?` (`r` on 0..1: thumbs `r`, else `(r-1)/(steps-1)`, 4 decimals; with `r`), `label?` (the step's label from the config, when the scale has labels and `r` is set), `text?` (control and invisible format characters stripped, whitespace runs collapsed to one space, trimmed; at most `maxText` characters (default 1000) and at most 2000 UTF-8 bytes, never half a code point, cut further only if JSON escapes would push the row past 4096 bytes), `len` (the original text's length in characters before sanitising and the cap; `0` when no text is left), `topic?` (1-32 of `[a-z0-9_]`, e.g. `bug`, `idea`), `play_s` (whole seconds since the session's join), `ctx?` (the game's context: at most 8 keys of 1-24 `[a-z0-9_]`, values string (at most 64 characters) / number / boolean). The scale comes from the settings record's `game.feedback` (else the game's `configure`, else `{ id: "stars5", type: "stars", steps: 5 }`). Older `custom` / `feedback` rows (`rating`, `text`, `length`) are read as scale `legacy_faces5` by the backend |
| session | `leave` | `secs` (session length), `why`: `left`, `shutdown`, `gone` (left while no generation ran the engine), `swap60?` (left within 60 s of a hot swap), `trust?` (Player.DeviceTrustLevel at the leave: `Pending` (never settled; always in Studio), `Unknown`, `None`, `Standard`, `Full`; missing on engines without it) |
| tech | `server` | Every `techEvery` s: `fps` (physics), `hb` (Heartbeat rate), `mem` (MB, 10s), `players`, `ping50?`, `ping90?` (ms), `q`, `qr` (queued events, recordings), `dropped`, `sent`, `fails`, `health?`, `errors?` (kernel 0.3.2 health) |
| tech | `client` (src client) | Every `techEvery` s: `fps`, `mem` (MB, 10s), `ping?` (ms); while an extended recording runs (dry runs too, plans/36): `xb` (tt-ext-1 bytes built per second over the period), `xms` (the recorder's ms per second, all streams), `xmax` (its worst single frame, ms), `xui` (visible UI nodes) |
| tech | `load` (src client) | `secs`: from the client starting to the engine starting (first client generation only) |
| tech | `error` | Server or client (src). `msg` (first 300 chars, player names replaced by `<player>`), `n` (times in the window). At most 10 per tech tick (server), 5 per 30 s and 100 per session (client) |
| tech | `start` | First generation of a server that runs the engine: `gen`, `kernel`, `load?` |
| tech | `assets` | Each generation whose artifact has hot assets (or an unusable manifest), at its start: `gen`, `boot` (the server's first generation), `manifest` (`ok`, `invalid`, `unread`), `place?` (`same`: the manifest names this place version; `vouched`: the place's backup vouches for it; `differs`: keys without a matching baked copy load from their uploads; `unknown`), `mpv?` (the manifest's place version), `pv?` (game.PlaceVersion), `keys`, `kept`, `baked`, `loaded`, `failed`, `loading` (keys per AssetSync source), `missing` (keys with nothing live), `late` (loaded after the start-up wait), `timedOut`, `ms?`, `first?` (the first failure or manifest error) |
| tech | `swap` / `rollback` | A generation started by a hot swap (`rollback` for rollback reasons), 5 s after it started: `reason`, `from?` (previous artifact id), `gen`, `load?`, `stop?`, `swap?` (seconds), `players` |
| tech | `swap_out` | Just before a generation stops: `reason`, `next?` (next artifact id), `players` |
| zone | `enter` | `zone`, `from` (previous zone or `""`) |
| zone | `leave` | `zone`, `to?`, `secs` |
| state | `activity` | `to`, `from` (server or client src) |
| state | `screen` | `to`, `from` (`""` = none). Client: ScreenGuis in PlayerGui (Enabled), GuiObjects tagged `TTScreen` (Visible), `screen()` |
| experiment | `<experiment>` | `variant`, `variants` (count), `vi` (the variant's 1-based position in the game's list; 0.7.1+), `forced?` (the settings or the player's own dev pick chose it). Once per session when assigned or changed, and again when the same variant becomes or stops being forced. At most 32 experiments per session: a 33rd `experiment()` returns the control (the first variant) and warns. A client's experiment calls count against its event budget (below) |
| recording_meta | `start` | `share` (the recorded share then), `secs?` (the window then: `recordSeconds`, or `extended.seconds` for an extended session; frameworks before it leave it out and used 60) |
| recording_meta | `ext_start` | plans/36, the first tt-ext-1 chunk arrived: `secs` (`extended.seconds`) |
| recording_meta | `ext_end` | `chunks`, `bytes`, `why`: as `end`'s (`window`, `left`, `cap` = 2 MB or 200 chunks, `end`) |
| recording_meta | `end` | `chunks`, `bytes`, `why`: `window` (`recordSeconds`, default 60 s, after the first input), `cap` (10 min, or the recording's 256 KB / 80 chunks), `left`, `end` |
| fleet | `heartbeat` | The kernel's `fleetStatus()` (kernel 0.3.2+), every 60 ± 10 s and once at each generation start. pid `""` |
| fleet | `deploy_report` | One kernel deploy report `{s, b, a, j, r, e?, d?, t, g, k, p}` (r: `swapped`, `failed`, `rolled_back`, `skipped`, `booted`), once per (s, j, r) per server, across generations. pid `""` |
| custom | `<name>` | `track(name, props)`: the game's props, plus the position props below when asked for |
| funnel | `<funnel>` | `step(funnel, index, name?)`: `i`, `step?` |
| purchase | `<kind>` | Server only. `purchase(player?, {product, robux, where?, kind?})`: name = `kind` (default `product`); `product`, `robux`, `where?` |
| currency | `<currency>` | Server only. `currency(player?, name, delta, reason)`: `delta`, `reason` |

**Positions** (`custom`, `funnel`, `purchase`, `currency`): `px`, `py`, `pz` (numbers, studs, rounded to 0.1) are the
position of a player's character root part (the model's PrimaryPart, else `HumanoidRootPart`) when the event was
tracked. Added on request (`track(..., { position: true | player })`) or for every event whose name is in the engine
option `positions` or the settings' `positions`: server events read the event player's character, client events
(src `client`) the local player's. Left out when there is no character, root part or finite position, and never
written over `px` / `py` / `pz` the game set itself (any of the three: the game's props are kept as they are). The
backend's map layers read exactly these keys. A client event tracked before the server's hello doesn't know the
settings' list yet (the code's `positions` works from the start).

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
- **Window:** from the engine's start on the client until `recordSeconds` (settings, default 60, 10..600) after the
  first key, click, tap, gamepad button or stick; at most 10 minutes from the start. Chunks are cut about every 10 s
  or 6 KB (and at a hot swap). A recording also ends at 256 KB or 80 chunks (`why` `cap`).
- **Storage per recorded minute** (measured from the encoder, `scripts/test-analytics.luau`): an active player (moving
  every sample, 4 key records a second, a click every 2 s, a button every 5 s) 13.2 KB of chunk bytes (~220 B/s; a
  Sample record is 18 bytes, 10 a second while moving), stored as 17.6 KB of base64 in 6 rows; moving with no input
  10.9 KB (14.6 KB base64); idle (one keepalive sample per 5 s) 0.3 KB. So `recordSeconds` 60 costs 10-20 KB per
  recorded player (the time before the first input adds to it), 300 about 55-70 KB, and 600 about 110-135 KB of
  chunk bytes, inside the 256 KB cap (the cap counts chunk bytes, not base64).

## tt-ext-1

The extended recording (plans/36): poses, other players and tracked models, their animations, and the UI tree, in
rows next to tt-rec-1. tt-rec-1 itself is unchanged (an extended session's tt-rec-1 window is `extended.seconds`).

Row: as tt-rec-1 (`v` 1, `t` chunk start unix ms, `pid`, `sid`, `job`, `art`, `chunk`, `codec` = `tt-ext-1`, `data`
base64, `n` = number of records in the chunk, String and Wait records included). `chunk` is tt-ext-1's own counter (0, 1,
2... per session). Little-endian throughout. Reference encoder and decoder: `ext-codec.ts` (`ExtWriter`,
`decodeExtChunk`); tests: `scripts/test-analytics.luau` (every record type) and `scripts/test-analytics-ext.luau` (the
recorder in a mock world).

Header (4 bytes): `u8 version` (1), `u8 flags` (bit 0: last chunk; bit 1: the chunk starts with a Keyframe), `u16 0`.

Records: `u8 tag, u16 dt` (ms since the previous record; the first since the row's `t`; a gap over 65535 ms is a Wait
record), `u16 length` (payload bytes: a decoder skips unknown tags by it), then the payload.

**Segments**: a Keyframe record (tag 2) starts a segment: the string table, the Anchor, the entities (with their rigs
and playing animations) and the UI tree are cleared, and the full state follows (View, Anchor, every Rig with a full
Pose, Spawn, Look, playing Anim, the whole UI tree, the UI tree possibly over several frames). A Keyframe at the start,
then every `uiKeyframeSeconds` (60), when an AFK pause ends, and at a hot swap (the new client generation starts with
one; the old one writes a Gone for every entity first). A Keyframe is always the first record of its chunk (the
recorder cuts the chunk before it), so a decoder can start at any chunk whose flag bit 1 is set. Chunks are cut about
every 10 s or 24 KB (at most 32 KB: the server refuses larger ones).

| Tag | Record | Payload |
|---|---|---|
| 0 | Wait | none (`dt` 65535, `length` 0) |
| 1 | String | `u16 id`, UTF-8 bytes (the rest of the payload; at most 1000 bytes, cut at a character boundary). Ids count from 0 per segment; a string is defined once per segment, before the first record that uses it. String id 65535 = none |
| 2 | Keyframe | `u16 0` (reserved) |
| 3 | View | `u16 viewport w, u16 h` (px), `u16 inset top` (GuiService:GetGuiInset() top-left Y, px), `u8 fov` (degrees), `u8 fps` (the client's fps over the last second, max 255). Written at a Keyframe, on any change, and once a second for fps |
| 4 | Afk | `u8 1` = AFK from here (every other stream pauses), `u8 0` = back (a Keyframe follows at once, in the next chunk) |
| 5 | Anchor | `f32 x, y, z`: origin for Move positions in this segment (whole studs: the camera's position at the Keyframe; a new Anchor at the camera when a position leaves ±4095 studs) |
| 6 | Rig | `u8 entity` (0 = the recorded player), `u8 rig` (0 none, 1 R6, 2 R15: the Humanoid's RigType; 3 other: no Humanoid), `u8 n` (at most 32), `n × u16` string ids: the Motor6D names in the order Pose uses: the standard ones first (R6: RootJoint, Neck, Left Shoulder, Right Shoulder, Left Hip, Right Hip; R15: Root, Waist, Neck, LeftShoulder, LeftElbow, LeftWrist, RightShoulder, RightElbow, RightWrist, LeftHip, LeftKnee, LeftAnkle, RightHip, RightKnee, RightAnkle; those present), then any other Motor6D (a weapon's joint). Re-sent (with a full Pose) when the character's Motor6Ds change |
| 7 | Pose | `u8 entity`, `u32 mask` (bit i = joint i of the Rig), per set bit 4 bytes: the joint's `Motor6D.Transform` rotation as smallest-three: `u32 = idx \| (a << 2) \| (b << 12) \| (c << 22)`, `idx` (0..3) the dropped (largest-magnitude) component of (x, y, z, w) with the quaternion's sign flipped so it is positive, `a, b, c` the other three in order, each `round((v / 0.70710678 + 1) / 2 × 1023)` (round half up; decode `v = (q / 1023 × 2 - 1) × 0.70710678`, the dropped one `sqrt(1 - a² - b² - c²)`; ~0.25° worst error). Only joints that moved over ~2° since the last Pose (all of them after a Rig or Keyframe); every tick (`hz`) |
| 8 | Spawn | `u8 entity` (1..255; reused only after a Gone), `u16 kind` string id (`player` for another player's character, else the game's `replay.track` kind), `u8 flags` (bit 0 has a Humanoid, bit 1 another player's character), `f32 x, y, z` (pivot), `u8 yaw`, `u16 size x, y, z` (the model's extents, 1/8 stud) |
| 9 | Look | `u8 entity`, `u8 flags` (bit 0 body colours follow), [`18 bytes`: BodyColors RGB head, torso, left arm, right arm, left leg, right leg], `u8 n`, `n × (u8 slot, u16 string id)`: slot 1 Shirt template, 2 Pants template, 3 ShirtGraphic (T-shirt) graphic, 4 face texture. Only for tracked models with a Humanoid (never other players: they stay the default avatar), and only when there is something to say |
| 10 | Move | `u8 count`, `count × (u8 entity, i16 x, i16 y, i16 z, u8 yaw)`: positions 1/8 stud from the Anchor; only entities that moved over 1/8 stud or turned, every tick; at least every 5 s |
| 11 | Gone | `u8 entity` (left the radius or the `entMax` nearest, destroyed, untracked, or a hot swap) |
| 12 | AnimPlay | `u8 entity`, `u16 track` (the recorder's id for this AnimationTrack, per entity, from 0; a track played again after it stopped gets a new id), `u16 animation` string id (the Animation's AnimationId, e.g. `rbxassetid://180426354`), `i16 speed × 100`, `u8 weight × 255` (WeightTarget, 0..1), `u8 flags` (bit 0 looped), `u16 time position × 100` (s, capped at 655.35). From Animator.AnimationPlayed, and for every track still playing at a Spawn or a Keyframe |
| 13 | AnimStop | `u8 entity`, `u16 track` (the track's Stopped) |
| 14 | AnimAdjust | `u8 entity`, `u16 track`, `i16 speed × 100`, `u8 weight × 255` (AdjustSpeed / AdjustWeight, seen at the next tick) |
| 20 | UiNode | a node becomes visible (or is re-sent after a Keyframe): `u16 id`, `u16 parent` (65535 = none: a ScreenGui), `u8 class`, `u16 mask`, then the fields below for every set bit, in bit order |
| 21 | UiProps | `u16 id`, `u16 mask`, the changed fields in bit order |
| 22 | UiGone | `u16 id` (removed, or no longer visible: Visible false, an ancestor hidden, the ScreenGui disabled). A node that goes hidden gets one, and so does each of its descendants that was visible |

Yaw bytes as tt-rec-1: `b / 256 × 2π - π` radians, 0 = facing -Z.

UI classes: 0 ScreenGui (its `order` field = DisplayOrder; rect = the screen), 1 Frame, 2 TextLabel, 3 TextButton, 4
TextBox, 5 ImageLabel, 6 ImageButton, 7 ScrollingFrame, 8 ViewportFrame (drawn as an empty box), 9 CanvasGroup, 10
VideoFrame (empty box). Other GuiObjects as 1. Recorded: every enabled ScreenGui in PlayerGui except the framework's own
(`TypeTorch*`) and Roblox's `Freecam`, `BubbleChat`, `Chat`, `ProximityPrompts`, `RbxCameraUI`; GuiObjects inside
Folders count as children of the nearest GuiObject above. At most 4000 nodes; ids are reused after a UiGone.

UI fields (mask bits). A UiNode sends the fields of its class: a ScreenGui `rect` and `order`; every GuiObject
`rect`, `order`, `background`; text classes `text` and `textStyle`; image classes `image` and `imageStyle`. The rest
only when not at their default, which a decoder assumes when they are missing: `rotation` 0, `imageRect` all 0,
`stroke` none, `corner` 0, `clip` 0, `gradient` none. A UiNode never sets bit 11 (its parent is in the header).

| Bit | Field | Bytes |
|---|---|---|
| 0 | rect | `i16 x, i16 y, u16 w, u16 h`: AbsolutePosition / AbsoluteSize (px) |
| 1 | rotation | `i16` AbsoluteRotation × 10 |
| 2 | order | `u16` draw order: a rank in the recorder's depth-first draw order over all recorded nodes (ScreenGuis by DisplayOrder, children by ZIndex then child order under ZIndexBehavior Sibling; under Global the ScreenGui's GuiObjects by ZIndex then tree order). Compare ranks only: they have gaps (hidden nodes keep theirs). A ScreenGui: its DisplayOrder |
| 3 | background | `u8 r, g, b, u8 transparency × 255` |
| 4 | text | `u16` string id (Text as set; RichText markup kept) |
| 5 | textStyle | `u8 r, g, b, u8 transparency × 255, u8 size` (TextSize; TextBounds.Y when TextScaled), `u16 family` string id (FontFace.Family), `u16 weight` (FontFace.Weight value), `u8 xAlign` (0 left, 1 centre, 2 right), `u8 yAlign` (0 top, 1 centre, 2 bottom), `u8 flags` (bit 0 scaled, bit 1 wrapped, bit 2 rich text), `u8 stroke transparency × 255` (TextStrokeTransparency), `u8 stroke r, g, b` |
| 6 | image | `u16` string id (Image as set, e.g. `rbxassetid://123`) |
| 7 | imageStyle | `u8 r, g, b` (ImageColor3), `u8 transparency × 255`, `u8 scaleType` (Enum.ScaleType value) |
| 8 | imageRect | `u16 offset x, y, size x, y`, `u16 slice x0, y0, x1, y1` (SliceCenter; all 0 = none) |
| 9 | stroke | the border: `u8 r, g, b, u8 transparency × 255, u8 thickness × 4`. A UIStroke (enabled; on a text object only with ApplyStrokeMode Border), else the classic border when BorderSizePixel > 0 (BorderColor3, BackgroundTransparency, BorderSizePixel). Thickness 0 = none |
| 10 | corner | `u8` UICorner radius in px (Scale × min(w, h) + Offset) |
| 11 | parent | `u16` (UiProps only: reparented) |
| 12 | clip | `u8` ClipsDescendants (ScrollingFrame / CanvasGroup always clip) |
| 13 | gradient | UIGradient (enabled): `u8 n` keypoints (at most 20) × (`u8 time × 255, u8 r, g, b`), `i16 rotation` (whole degrees). n 0 = none (drawn as a CSS gradient) |

How the UI is read (the cost): structure from one DescendantAdded / DescendantRemoving pair per ScreenGui (no
per-instance Changed connections); properties polled at `hz` and diffed, time-sliced to `uiBudgetMs` per frame (0.6 of
it on phones and tablets); rect, rotation, background, text, text colour and size, image and image colour every pass,
the rest (fonts, alignment, flags, text stroke, scale type, slices, stroke, corner, clip, gradient, ZIndex) every 4th
pass per node, so such a change can show up ~1 s late. Under 30 fps the UI passes halve, under 20 they pause.

Who and when: sessions recorded by tt-rec-1 whose player is eligible (total playtime under `maxPlaytime` at the join:
the player record's `play`; a first visit is 0; a record without `play` is unknown and not eligible) and whose variant
of the built-in experiment `tt_extended_recording` (variants `["off", "on"]`, set in the settings' `experiments`) is
`on`. Both arms are stamped in `exp`, so `off` is the control. No `tt_extended_recording` in `experiments`: nobody.
The extended recording runs from the hello until `extended.seconds` after the first input (its tt-rec-1 stream runs as
long), and ends with tt-rec-1 (`why` as tt-rec-1's) or at 2 MB / 200 chunks (`cap`). AFK (no key, click, tap, gamepad
button or stick for `afkSeconds` and the character not moving over 0.5 studs, or the game's `replay.setAfk`): one Afk
record and nothing else until the player is back; a session AFK from the start writes nothing until then.

## Sink settings

Server-only, from the signed settings record (kernel 0.3.8, plans/20; before 0.3.8 the ConfigService key
`TypeTorchAnalytics`). Every new signed copy applies at once, so dials change live (the CLI pings servers).
`new AnalyticsEngine({ settings })` replaces it (tests, Studio, kernels before 0.3.8).

- **`backend`** (kernel 0.4.0 / framework 0.4.0, plans/21) = `{ url, key, analytics? }` is the sink: `duckdb` at
  `<url>/v1/ingest` with `key` as the token, and the dials below from `backend.analytics`. It is written by
  `typetorch backend setup` (CLI 0.9+; `--flush-seconds`, `--record-share`), which `@typetorch/backend`'s
  `writeBackendSettings()` and `bun run local` run. `typetorch experiment` writes `backend.analytics.experiments`.
- **`analytics`** (the object below) is read while `backend` is missing, and whenever it names a `basin` sink
  (`backend` can't describe Basin streams). `backend setup` also derives a `duckdb` copy of it for frameworks before
  0.4. CLI 0.9 removed `typetorch settings set analytics` (it now points to `backend setup`), so a Basin sink has no CLI
  writer.
- **No CLI writer yet** for `recordSeconds`, `positions`, `techEvery`, `joinData`, `joinLaunchPrefix` and `extended`: they keep
  their defaults unless the record already holds them (`backend setup` keeps the existing `backend.analytics` fields),
  or the game passes `new AnalyticsEngine({ settings })`. `positions` can also be set in code with the engine option of
  the same name. `identity` and `identityToken` (Basin only) live in the old `analytics` value, which has no CLI writer
  either.

```json
{
  "backend": "basin",
  "events": "https://<events-stream-id>.ingest.cloudflare.com",
  "recordings": "https://<recordings-stream-id>.ingest.cloudflare.com",
  "token": "<write-only token>",
  "flushSeconds": 15,
  "recordShare": 1,
  "recordSeconds": 60,
  "positions": ["down", "death_final", "round_result"],
  "techEvery": 60,
  "experiments": { "onboarding": { "active": true, "weights": [1, 1], "variant": "short", "players": { "123456": "long" } } },
  "extended": { "seconds": 300, "dryRun": true }
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
| `recordSeconds` | 60 | 10..600: seconds a recording runs after the first input (at most 10 minutes from its start; the 256 KB / 80 chunk caps stay). Storage: tt-rec-1 above |
| `positions` | none | Event names (1-64 characters, at most 64) whose game-code events always carry `px`, `py`, `pz` (Positions above), added to the engine option `positions`; sent to clients in the hello. Not a list: an error line, none used |
| `techEvery` | 60 | 15..3600 seconds between tech samples |
| `experiments` | none | Per experiment: `active: false` (everyone gets the first variant, not stamped), `weights` (per variant, in the game's order), `variant` (force one), `players` (`{ [UserId or pid]: variant }`, at most 200: forces one player's variant over everything else, stamped `forced`; each client's hello gets only its own entry). The CLI writes them: `typetorch experiment` |
| `identity` | the settings' `fleet` url + `/v1/identity` | basin: where identity rows go (below); none and no `fleet` in the settings: not sent. duckdb: unused |
| `identityToken` | the settings' `fleet` token | basin: the token for `identity`. Never logged |
| `joinData` | `"full"` | `"full"`: the join row carries `jd` (below); `"summary"`: no `jd`; `"off"`: no `jd` and only the pre-plans/29 join props (no pid lookups). Anything else is an error line (warned) and means `"full"`. In `backend.analytics` (or the old `analytics` value) |
| `extended` | defaults | plans/36, framework 0.7.2: the extended recording's dials (tt-ext-1 above); every field optional, a bad one is an error line and keeps its default: `seconds` (300, 10..600: after the first input; the session's tt-rec-1 window too), `maxPlaytime` (60 s of total playtime at the join), `afkSeconds` (30, 5..600), `hz` (3.33, 1..10: Pose / Move / UI polls a second), `entMax` (24, 0..255), `entRadius` (150 studs, 10..2000), `uiBudgetMs` (0.25 ms a frame, 0.05..4; phones and tablets 0.6 of it), `uiKeyframeSeconds` (60, 10..600), `dryRun` (false: true builds everything and sends nothing but the `tech` counters), `streams` (`{ pose, ent, ui, view }`, each true / false, default true). Who records: the experiment `tt_extended_recording` (`["off", "on"]`) in `experiments`, e.g. `"tt_extended_recording": { "weights": [9, 1] }`; without it nobody does. Sent to the client in the hello |
| `joinLaunchPrefix` | false | true: the join row's `launch` keeps the first 32 characters of the game's own launch data (off: only `launch_len`). Set it in `backend.analytics` (or the old `analytics` value) |

Unknown fields are ignored. Settings errors are warned once (never with the token).

## The raw join data (`jd`, plans/30)

The `session` / `join` row's `jd` prop mirrors `Player:GetJoinData()` field by field, privacy-safe, at most 1024 bytes of
JSON (written by the framework's own encoder, so an empty table stays `{}` where the shape says object):

| field | content |
|---|---|
| `keys` | The top-level keys Roblox returned, sorted (each cut to 32 characters) |
| `LaunchData?`, `LaunchDataLen?` | The launch data cut to 200 bytes at a UTF-8 boundary, and its full byte length; present iff the key is |
| `SourcePlaceId?`, `SourceGameId?` | Numbers, present iff the keys are |
| `GameJoinContext?` | Present iff the key is: every field as text (EnumItems by name), `{}` when empty |
| `TeleportData?` | `{ bytes?, type, keys? }`: its JSON size, type and top-level keys (at most 20, 32 characters each, sorted); never the content |
| `Members?` | `{ count, pids? }`: each member's pid when this game knows them (players in the server, or one of the join's at most 2 budget-checked DataStore reads shared with the summary props), else `"other"`; the joining player by their own pid |
| `ReferredByPlayerId?`, `FollowUserId?` | pid or `"other"`; absent for 0 |
| `other?` | Any other top-level key: its type name only, never the value |
| `trunc?` | `true` when cut to fit: TeleportData keys first (then the list), Members pids (then the list), LaunchData (shorter), GameJoinContext values (64 each), `other` |

No other player's UserId is ever in `jd`. Example (Roblox dropped a notification's launch data):
`{"keys":["GameJoinContext","LaunchData"],"LaunchData":"","LaunchDataLen":0,"GameJoinContext":{}}`.

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

DataStore `TypeTorchAnalytics`, key `p/<UserId>` -> `{ "pid": "<32 hex>", "first": <unix s>, "last": <unix s>, "play":
<s> }`. One read per join (with retries), a write on the first join (UpdateAsync, keeps a pid another server wrote
first) and one at leave (`last`, and the session's seconds added to `play` in the same UpdateAsync). `play` (framework
0.7.2) is the total playtime: a new record starts at 0; a record from an older framework has none and gets none
(unknown, never guessed). A Right to Erasure request deletes the key, which leaves the player's rows anonymous. The
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
