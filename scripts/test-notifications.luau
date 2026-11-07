--!nocheck
-- Offline test of the notifications' pure parts (plans/29) under Lune: the signed launch token (the contract's shared
-- vector, sign -> verify, wrong user, too old, previous key within / after 7 days, bad sig, format), the key hash, the
-- intent checks, the queue (rev order, batching at 200, the body JSON, requeue after a failure, a swap's handover) and
-- the client's opt-in rows. Run after `bun run build`:
--   cd ../kernel && lune run ../framework/scripts/test-notifications.luau ../framework/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")
local root = process.args[1] or "./"

-- roblox-ts returns a TS tuple as an array: (items, body).
local function unpackBatch(result)
	return result[1], result[2]
end

local function loadWith(path, name, modules)
	local script = { Name = name, Parent = { Parent = {} } }
	return luau.load(fs.readFile(root .. path), {
		debugName = name,
		environment = setmetatable({
			script = script,
			_G = { [script] = {
				import = function(_, _, ...)
					local names = { ... }
					local wanted = names[#names]
					local module = modules[wanted]
					assert(module ~= nil, "unexpected import " .. tostring(wanted))
					return module
				end,
			} },
		}, { __index = _G }),
	})()
end

local SHA = loadWith("out/util/sha256.luau", "sha256", {})
local T = loadWith("out/notifications/token.luau", "token", { sha256 = SHA })
local P = loadWith("out/notifications/protocol.luau", "protocol", {})

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end
local quote = function(text)
	return serde.encode("json", text)
end

-- The shared vector (plans/29-contract.md): computed independently with node:crypto, and pinned by the backend's
-- test/notify-token.test.ts too:
--   node -e 'const c=require("node:crypto"),k="k".repeat(43),b=(x)=>Buffer.from(x).toString("base64url");
--     const m=["tt1n","abc0123xyz","gift_new",(123456789).toString(36),(1762500000).toString(36),b("mail:42")].join(".");
--     console.log(m+"."+b(c.createHmac("sha256",Buffer.from(k,"ascii")).update(m).digest().subarray(0,16)))'
local KEY = string.rep("k", 43)
local VECTOR = "tt1n.abc0123xyz.gift_new.21i3v9.t5chpc.bWFpbDo0Mg.qHiEc9Cd2kb-f4921kh__g"
local USER, SENT = 123456789, 1762500000
-- Same tool, previous key "p" x 43, kind streak, no data.
local PREVIOUS = string.rep("p", 43)
local VECTOR_PREVIOUS = "tt1n.zzzzzzzzzz.streak.21i3v9.t5chpc..KhyQ1AJ5cpd4v62lfhqqUg"

-- Encodings ---------------------------------------------------------------------------------------------------------------
do
	check("base36 user", T.toBase36(USER) == "21i3v9", T.toBase36(USER))
	check("base36 time", T.toBase36(SENT) == "t5chpc", T.toBase36(SENT))
	check("base36 zero", T.toBase36(0) == "0")
	check("base36 back", T.fromBase36("21i3v9") == USER and T.fromBase36("t5chpc") == SENT)
	check("base36 refuses upper case / leading zero / empty", T.fromBase36("21I3V9") == nil and T.fromBase36("021i3v9") == nil and T.fromBase36("") == nil)
	check("b64url mail:42", T.base64url("mail:42") == "bWFpbDo0Mg", T.base64url("mail:42"))
	check("b64url empty", T.base64url("") == "")
	local all = {}
	for byte = 0, 255 do
		table.insert(all, string.char(byte))
	end
	local bytes = table.concat(all)
	for size = 0, 7 do
		local sample = bytes:sub(250 - size, 249)
		check("b64url round trip " .. size, T.fromBase64url(T.base64url(sample)) == sample)
	end
	check("b64url all bytes", T.fromBase64url(T.base64url(bytes)) == bytes)
	check("b64url url alphabet", T.base64url(string.char(251, 255, 191)) == "-_-_", T.base64url(string.char(251, 255, 191)))
	check("b64url refuses padding / bad length / stray bits", T.fromBase64url("bQ==") == nil and T.fromBase64url("b") == nil and T.fromBase64url("bR") == nil)
	check("key hash", T.keyHash("20034") == "08f2c7a71012", T.keyHash("20034"))
	check("key hash of the default key", T.keyHash("") == "" and T.keyHash(nil) == "")
end

-- Sign and verify -----------------------------------------------------------------------------------------------------------
do
	local keys = { current = KEY }
	local now = SENT + 3600
	check("vector: sign", T.signToken(KEY, "abc0123xyz", "gift_new", USER, SENT, "mail:42") == VECTOR, T.signToken(KEY, "abc0123xyz", "gift_new", USER, SENT, "mail:42"))
	check("vector: previous-key sign", T.signToken(PREVIOUS, "zzzzzzzzzz", "streak", USER, SENT, "") == VECTOR_PREVIOUS)
	local good = T.verifyToken(VECTOR, USER, keys, now)
	check("vector: verifies", good ~= nil and good.ok == true, good and good.why)
	check("vector: fields", good.nid == "abc0123xyz" and good.kind == "gift_new" and good.userId == USER and good.sentAt == SENT and good.data == "mail:42")
	check("vector: age", good.ageSeconds == 3600, good.ageSeconds)
	check("vector: <= 200 bytes", #VECTOR <= 200)

	local NONE = {}
	local function why(token, userId, k, at)
		local verdict = T.verifyToken(token, userId or USER, if k == NONE then nil else (k or keys), at or now)
		if verdict == nil then
			return "nil"
		end
		return if verdict.ok then "ok" else verdict.why
	end
	check("not ours: game's own launch data", why("mail:42") == "nil")
	check("not ours: nil", why(nil) == "nil")
	check("not ours: prefix is exact", why("tt1x.abc") == "nil" and why("TT1N." .. VECTOR:sub(6)) == "nil")
	check("wrong user", why(VECTOR, 987654321) == "user")
	check("14 days is fine", why(VECTOR, USER, keys, SENT + 14 * 86400) == "ok")
	check("too old", why(VECTOR, USER, keys, SENT + 14 * 86400 + 1) == "old")
	check("future send time: age 0", T.verifyToken(VECTOR, USER, keys, SENT - 50).ageSeconds == 0)
	check("bad sig: one char", why(VECTOR:sub(1, -2) .. "A") == "sig")
	check("bad sig: other key", why(VECTOR, USER, { current = string.rep("x", 43) }) == "sig")
	check("bad sig: no keys", why(VECTOR, USER, NONE) == "sig" and why(VECTOR, USER, {}) == "sig")
	check("bad sig: data changed", why((VECTOR:gsub("bWFpbDo0Mg", "bWFpbDo0Mw"))) == "sig")
	check("bad sig: kind changed", why((VECTOR:gsub("gift_new", "gift_old"))) == "sig")
	-- The uid is signed: a token for someone else can't be re-pointed at the joining player.
	local stolen = VECTOR:gsub("21i3v9", T.toBase36(987654321))
	check("re-pointed uid fails the sig", why(stolen, 987654321) == "sig")
	check("format: 6 parts", why("tt1n.abc0123xyz.gift_new.21i3v9.t5chpc.qHiEc9Cd2kb-f4921kh__g") == "format")
	check("format: 8 parts", why(VECTOR .. ".x") == "format")
	check("format: nid length", why((VECTOR:gsub("abc0123xyz", "abc0123xy"))) == "format")
	check("format: nid upper case", why((VECTOR:gsub("abc0123xyz", "ABC0123XYZ"))) == "format")
	check("format: kind", why((VECTOR:gsub("gift_new", "gift-new"))) == "format")
	check("format: sig length", why(VECTOR:sub(1, -2)) == "format")
	check("format: data not base64url", why((VECTOR:gsub("bWFpbDo0Mg", "bWFp+Do0Mg"))) == "format")
	check("format: over 200 bytes", why(VECTOR .. string.rep("a", 200)) == "format")
	check("format: uid", why((VECTOR:gsub("21i3v9", "21I3V9"))) == "format")

	-- Previous key: accepted while now - since < 14 d (the token lifetime), then refused (`sig`).
	local rotated = { current = KEY, previous = PREVIOUS, since = SENT }
	check("previous key within 14 d", why(VECTOR_PREVIOUS, USER, rotated, SENT + 14 * 86400 - 1) == "ok")
	check("previous key at 7..13 d (the old limit)", why(VECTOR_PREVIOUS, USER, rotated, SENT + 10 * 86400) == "ok")
	check("previous key after 14 d", why(VECTOR_PREVIOUS, USER, { current = KEY, previous = PREVIOUS, since = SENT - 3600 }, SENT + 14 * 86400 - 1800) == "sig")
	check("previous key grace = token life", T.PREVIOUS_KEY_GRACE == 14 * 86400 and T.TOKEN_MAX_AGE == 14 * 86400)
	check("previous key without since", why(VECTOR_PREVIOUS, USER, { current = KEY, previous = PREVIOUS }) == "sig")
	check("current key after a rotation", why(VECTOR, USER, rotated, SENT + 30 * 86400) == "old" and why(VECTOR, USER, rotated, SENT + 10 * 86400) == "ok")
	check("empty data verifies", T.verifyToken(VECTOR_PREVIOUS, USER, rotated, SENT + 60).data == "")

	-- readKeys: settings.backend.notify
	local read = T.readKeys({ keys = { current = KEY, previous = PREVIOUS, since = SENT } })
	check("readKeys", read and read.current == KEY and read.previous == PREVIOUS and read.since == SENT)
	check("readKeys: none", T.readKeys(nil) == nil and T.readKeys({}) == nil and T.readKeys({ keys = { current = "short" } }) == nil)
	check("readKeys: bad previous ignored", T.readKeys({ keys = { current = KEY, previous = 5 } }).previous == nil)

	-- A sign -> verify sweep over kinds, users and data sizes.
	local sweepOk = true
	for index = 0, 64, 7 do
		local data = string.rep("d", index)
		local token = T.signToken(KEY, "n" .. string.format("%09d", index), "kind_" .. index, 1 + index * 1000003, SENT, data)
		local verdict = T.verifyToken(token, 1 + index * 1000003, keys, SENT + 1)
		if not (verdict and verdict.ok and verdict.data == data and #token <= 200) then
			sweepOk = false
		end
	end
	check("sign -> verify sweep", sweepOk)
	local longest = T.signToken(KEY, "abcdefghij", string.rep("k", 24), 2 ^ 53 - 1, 99999999999, string.rep("\255", 64))
	check("worst case fits 200 bytes", #longest <= 200, #longest)
end

-- Intents --------------------------------------------------------------------------------------------------------------------
do
	local state = P.newQueueState()
	local a = P.nextRev(state, 1762500000)
	local b = P.nextRev(state, 1762500000)
	local c = P.nextRev(state, 1762500001)
	check("rev: os.time() * 1000 + seq", a == 1762500000000 and b == 1762500000001 and c == 1762500001000)
	local d = P.nextRev(state, 1762499990)
	check("rev: never goes back (clock step)", d == c + 1, d)
	for _ = 1, 1500 do
		P.nextRev(state, 1762500002)
	end
	check("rev: past 1000 a second stays increasing", state.lastRev == 1762500002000 + 1499, state.lastRev)

	local want = P.cleanWant(123, "gift_new", { key = "mail-1", ["until"] = 1762600000.5, params = { gift = "5 Z-Coins", n = 5 }, data = "mail:1" }, 7)
	check("want: item", type(want) == "table" and want.op == "want" and want.u == 123 and want.k == "gift_new" and want.key == "mail-1" and want["until"] == 1762600000, want)
	check("want: number params become text", want.params.n == "5")
	check("want: no options", type(P.cleanWant(1, "day2", nil, 1)) == "table")
	check("want: bad user", type(P.cleanWant(0, "x", nil, 1)) == "string" and type(P.cleanWant(1.5, "x", nil, 1)) == "string")
	check("want: bad kind", type(P.cleanWant(1, "Gift", nil, 1)) == "string" and type(P.cleanWant(1, string.rep("a", 25), nil, 1)) == "string")
	check("want: key too long", type(P.cleanWant(1, "x", { key = string.rep("k", 65) }, 1)) == "string")
	check("want: data too long", type(P.cleanWant(1, "x", { data = string.rep("d", 65) }, 1)) == "string")
	check("want: until before at", type(P.cleanWant(1, "x", { at = 10, ["until"] = 5 }, 1)) == "string")
	check("want: until == at refused", type(P.cleanWant(1, "x", { at = 10, ["until"] = 10 }, 1)) == "string")
	check("want: until after at", type(P.cleanWant(1, "x", { at = 10, ["until"] = 11 }, 1)) == "table")
	check("want: until == at after flooring refused", type(P.cleanWant(1, "x", { at = 10.2, ["until"] = 10.9 }, 1)) == "string")
	local nine = {}
	for index = 1, 9 do
		nine["p" .. index] = "v"
	end
	check("want: 9 params", type(P.cleanWant(1, "x", { params = nine }, 1)) == "string")
	check("want: dashed param name", P.cleanWant(1, "x", { params = { ["user-streak-remaining"] = "4" } }, 1).params["user-streak-remaining"] == "4")
	check("want: param name", type(P.cleanWant(1, "x", { params = { ["bad name"] = "v" } }, 1)) == "string")
	check("want: param value", type(P.cleanWant(1, "x", { params = { a = string.rep("v", 65) } }, 1)) == "string")
	check("want: template", P.cleanWant(1, "custom", { template = "abc" }, 1).template == "abc")
	local drop = P.cleanDrop(5, "streak", nil, "played", 9)
	check("drop: every key", type(drop) == "table" and drop.key == nil and drop.why == "played")
	check("drop: bad why", type(P.cleanDrop(5, "streak", "k", string.rep("w", 65), 9)) == "string")

	-- JSON: exact text, integers keep every digit.
	check(
		"encode want",
		P.encodeItem(want, quote) == '{"op":"want","u":123,"k":"gift_new","key":"mail-1","until":1762600000,"params":{"gift":"5 Z-Coins","n":"5"},"data":"mail:1","rev":7}',
		P.encodeItem(want, quote)
	)
	check("encode drop", P.encodeItem(drop, quote) == '{"op":"drop","u":5,"k":"streak","why":"played","rev":9}', P.encodeItem(drop, quote))
	check(
		"encode presence",
		P.encodeItem({ op = "presence", u = 9007199254740991, online = false, at = 1762500000 }, quote) == '{"op":"presence","u":9007199254740991,"online":false,"at":1762500000}'
	)
	check(
		"encode presence: at in ms keeps every digit",
		P.encodeItem({ op = "presence", u = 5, online = true, at = 1762500000123 }, quote) == '{"op":"presence","u":5,"online":true,"at":1762500000123}'
	)
	local big = P.cleanWant(1, "x", nil, 1762500000123)
	check("encode: 13-digit rev", P.encodeItem(big, quote):find('"rev":1762500000123', 1, true) ~= nil)
	local decoded = serde.decode("json", P.encodeItem(want, quote))
	check("encode: valid JSON", decoded.params.gift == "5 Z-Coins" and decoded["until"] == 1762600000)
end

-- Queue: batching at 200, flush order, requeue, swap handover ------------------------------------------------------------------
do
	local state = P.newQueueState()
	for index = 1, 450 do
		P.pushItem(state, P.cleanWant(index, "daily", nil, P.nextRev(state, 1762500000)))
	end
	local batch, body = unpackBatch(P.takeBatch(state, quote))
	check("batch: 200 items", #batch == 200 and #state.items == 250)
	check("batch: oldest first", batch[1].u == 1 and batch[200].u == 200 and state.items[1].u == 201)
	local parsed = serde.decode("json", body)
	check("batch: body", parsed.v == 1 and #parsed.items == 200 and parsed.items[1].u == 1)
	local increasing = true
	for index = 2, #parsed.items do
		if parsed.items[index].rev <= parsed.items[index - 1].rev then
			increasing = false
		end
	end
	check("batch: revs increase", increasing)
	check("batch: under the byte cap", #body <= P.BATCH_BYTES, #body)

	-- A failed POST puts the batch back in front, in order.
	P.requeueItems(state, batch)
	check("requeue: front, in order", #state.items == 450 and state.items[1].u == 1 and state.items[201].u == 201)

	-- A split (413) takes fewer.
	local half = unpackBatch(P.takeBatch(state, quote, 100))
	check("batch: smaller max", #half == 100 and state.items[1].u == 101)
	P.requeueItems(state, half)

	-- The byte cap: big items stop a batch early (the first always goes).
	local heavy = P.newQueueState()
	local params = {}
	for index = 1, 8 do
		params["p" .. index] = string.rep("\"", 64) -- JSON-escaped: 2 bytes each
	end
	for index = 1, 200 do
		P.pushItem(heavy, P.cleanWant(index, "x", { key = string.rep("k", 64), params = params, data = string.rep("d", 64) }, index))
	end
	local heavyBatch, heavyBody = unpackBatch(P.takeBatch(heavy, quote))
	check("byte cap", #heavyBatch < 200 and #heavyBatch > 0 and #heavyBody <= P.BATCH_BYTES, #heavyBatch)

	-- A swap mid-request: the queue is plain data in persist (JSON round trip = no functions or instances), the batch
	-- in flight comes back first in the next generation (NotifyServer's constructor does exactly this).
	local live = P.newQueueState()
	for index = 1, 10 do
		P.pushItem(live, P.cleanWant(index, "daily", nil, P.nextRev(live, 1762500000)))
	end
	live.inflight = unpackBatch(P.takeBatch(live, quote, 4))
	local handed = serde.decode("json", serde.encode("json", live))
	check("swap: plain data", #handed.items == 6 and #handed.inflight == 4)
	P.requeueItems(handed, handed.inflight)
	handed.inflight = {}
	check("swap: inflight first, order kept", #handed.items == 10 and handed.items[1].u == 1 and handed.items[5].u == 5 and handed.items[10].u == 10)
	check("swap: rev clock kept", P.nextRev(handed, 1762500000) == live.lastRev + 1)

	-- Cap: presence goes first, then the oldest.
	local capped = P.newQueueState()
	for index = 1, P.QUEUE_CAP do
		if index % 2 == 0 then
			P.pushItem(capped, { op = "presence", u = index, online = true, at = 1 })
		else
			P.pushItem(capped, P.cleanWant(index, "x", nil, index))
		end
	end
	P.pushItem(capped, P.cleanWant(99999, "x", nil, 99999))
	check("cap: size kept", #capped.items == P.QUEUE_CAP and capped.dropped == 1)
	check("cap: a presence item went, not the oldest want", capped.items[1].u == 1 and capped.items[#capped.items].u == 99999)

	-- Calls
	local calls = {}
	for index = 1, P.CALLS_CAP + 5 do
		P.pushCall(calls, { nid = "n", u = index })
	end
	check("calls: cap keeps the newest", #calls == P.CALLS_CAP and calls[1].u == 6)

	-- Answers
	local answer = P.readIntentsAnswer({ ok = true, accepted = 3, rejected = { { i = 1, why = "unknown_kind" }, { i = 2, why = "too_long" } } })
	check("answer: rejected", answer.accepted == 3 and answer.rejected == 2 and answer.why == "unknown_kind")
	check("answer: junk", P.readIntentsAnswer("x").rejected == 0)
	check("opened state", P.readOpenedState({ state = "first" }) == "first" and P.readOpenedState({ state = "repeat" }) == "repeat" and P.readOpenedState({ state = "unknown" }) == "unknown")
	check("opened state: junk", P.readOpenedState({ state = "x" }) == nil and P.readOpenedState(nil) == nil)
end

-- Opt-in rows from a client ----------------------------------------------------------------------------------------------------
do
	local check_ = P.cleanOptInRow({ name = "optin_check", where = "streak_2", can = true, extra = "dropped" })
	check("optin: check", check_ and check_.can == true and check_.where == "streak_2" and check_.extra == nil)
	check("optin: check needs can", P.cleanOptInRow({ name = "optin_check", where = "x" }) == nil)
	check("optin: shown", P.cleanOptInRow({ name = "optin_shown", where = "x" }) ~= nil)
	local closed = P.cleanOptInRow({ name = "optin_closed", where = "x", secs = 99999.7 })
	check("optin: closed secs capped", closed and closed.secs == 3600)
	check("optin: closed needs secs", P.cleanOptInRow({ name = "optin_closed", where = "x" }) == nil)
	check("optin: negative secs", P.cleanOptInRow({ name = "optin_closed", where = "x", secs = -1 }) == nil)
	check("optin: other names refused", P.cleanOptInRow({ name = "open", where = "x" }) == nil and P.cleanOptInRow({ name = "optin_inferred", where = "x" }) == nil)
	check("optin: bad where", P.cleanOptInRow({ name = "optin_shown", where = "bad where" }) == nil and P.cleanOptInRow({ name = "optin_shown", where = string.rep("w", 33) }) == nil)
	check("optin: err trimmed", #P.cleanOptInRow({ name = "optin_shown", where = "x", err = string.rep("e", 300) }).err == 64)
	check("optin: not a table", P.cleanOptInRow("optin_shown") == nil)
end

print(`notifications: {passed} passed, {failed} failed`)
print(`pinned token: {VECTOR}`)
if failed > 0 then
	process.exit(1)
end
