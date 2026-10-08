-- Offline test of the analytics engine's pure parts (plans/16) under Lune: experiment assignment, settings parsing,
-- the send queue and HTTP budget (cap, retry, swap handover), the tt-rec-1 codec and base64, and the sink request
-- bodies. Run after `bun run build` (Lune is pinned in kernel/rokit.toml and template/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-analytics.luau ../framework/out/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")
local base = process.args[1] or "out/"

local function load(path)
	return luau.load(fs.readFile(base .. path), { debugName = path, environment = setmetatable({}, { __index = _G }) })()
end

local E = load("analytics/experiments.luau")
local S = load("analytics/settings.luau")
local Q = load("analytics/queue.luau")
local C = load("analytics/codec.luau")
local K = load("analytics/sinks.luau")
local P = load("analytics/protocol.luau")
local H = load("analytics/hints.luau")

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end
local function near(a, b, tolerance)
	return math.abs(a - b) <= tolerance
end
local decode = function(text)
	return serde.decode("json", text)
end
local quote = function(text)
	return serde.encode("json", text)
end

-- Experiments --------------------------------------------------------------------------------------------------------
check("fnv empty", E.hash32("") == 2166136261, E.hash32(""))
check("fnv a", E.hash32("a") == 0xe40c292c, E.hash32("a"))
check("fnv foobar", E.hash32("foobar") == 0xbf9cf968, E.hash32("foobar"))
check("unitHash range", E.unitHash("x") >= 0 and E.unitHash("x") < 1)

local pids = {}
for index = 1, 10000 do
	pids[index] = string.format("%032x", index * 7919)
end
local function share(variants, override, wanted)
	local count = 0
	for _, pid in pids do
		if E.assignVariant(pid, "onboarding", variants, override).variant == wanted then
			count += 1
		end
	end
	return count / #pids
end
local half = share({ "short", "long" }, nil, "long")
check("even split ~50%", near(half, 0.5, 0.03), half)
local third = share({ "a", "b", "c" }, nil, "c")
check("three-way ~33%", near(third, 1 / 3, 0.03), third)
local tenth = share({ "a", "b" }, { weights = { 9, 1 } }, "b")
check("weights 9:1 ~10%", near(tenth, 0.1, 0.02), tenth)
check("bad weights length = even", near(share({ "a", "b" }, { weights = { 1 } }, "b"), half, 0.0001))
check("negative weight = even", near(share({ "a", "b" }, { weights = { 1, -1 } }, "b"), half, 0.0001))
check("zero total = even", near(share({ "a", "b" }, { weights = { 0, 0 } }, "b"), half, 0.0001))
check("weight 0 never picked", share({ "a", "b" }, { weights = { 1, 0 } }, "b") == 0)

local stable = true
local subset = true
for index = 1, 2000 do
	local pid = pids[index]
	local first = E.assignVariant(pid, "onboarding", { "short", "long" })
	local again = E.assignVariant(pid, "onboarding", { "short", "long" })
	if first.variant ~= again.variant then
		stable = false
	end
	-- Shrinking B's share only moves players from B to A (cumulative thresholds).
	local narrow = E.assignVariant(pid, "onboarding", { "short", "long" }, { weights = { 9, 1 } })
	if narrow.variant == "long" and first.variant ~= "long" then
		subset = false
	end
end
check("assignment stable", stable)
check("weight change moves few players", subset)
local other = 0
for index = 1, 2000 do
	local a = E.assignVariant(pids[index], "onboarding", { "x", "y" }).variant
	local b = E.assignVariant(pids[index], "shop", { "x", "y" }).variant
	if a ~= b then
		other += 1
	end
end
check("experiments independent", near(other / 2000, 0.5, 0.05), other)
local off = E.assignVariant("p1", "onboarding", { "short", "long" }, { active = false })
check("inactive = control", off.variant == "short" and off.active == false)
local forced = E.assignVariant("p1", "onboarding", { "short", "long" }, { variant = "long" })
check("forced variant", forced.variant == "long" and forced.forced and forced.active)
check("forced unknown variant ignored", E.assignVariant("p1", "x", { "a", "b" }, { variant = "zzz" }).forced == false)
check("no variants", E.assignVariant("p1", "x", {}).variant == "")
local share30 = 0
for _, pid in pids do
	if E.inShare(pid, 0.3) then
		share30 += 1
	end
end
check("inShare 30%", near(share30 / #pids, 0.3, 0.03), share30)
check("inShare 0", not E.inShare("p", 0))
check("inShare 1", E.inShare("p", 1))
check("name ok", E.isExperimentName("onboarding_v2"))
check("name too long", not E.isExperimentName(string.rep("a", 65)))
check("name space", not E.isExperimentName("a b"))
check("variants ok", E.isVariantList({ "a", "b" }))
check("variants dup", not E.isVariantList({ "a", "a" }))
check("variants empty", not E.isVariantList({}))
check("variants map", not E.isVariantList({ a = "x" }))
check("variants 17", not E.isVariantList(table.create(17, "x")))

-- Settings -----------------------------------------------------------------------------------------------------------
local none = S.parseSettings(nil, decode)
check("no key: no settings", none.settings == nil and #none.errors == 0)
local full = S.parseSettings({
	backend = "basin",
	events = "https://abc.ingest.cloudflare.com",
	recordings = "https://def.ingest.cloudflare.com",
	token = "SECRET-TOKEN-123",
	flushSeconds = 2,
	recordShare = 1.5,
	techEvery = 30,
	experiments = { onboarding = { active = false, weights = { 1, 2 } }, shop = { variant = "b" } },
}, decode)
check("full: settings", full.settings ~= nil)
check("full: no errors", #full.errors == 0, table.concat(full.errors, "; "))
check("full: backend", full.settings.backend == "basin")
check("full: flush clamped to 5", full.settings.flushSeconds == 5)
check("full: share clamped to 1", full.settings.recordShare == 1)
check("full: techEvery", full.settings.techEvery == 30)
check("full: token kept", full.settings.token == "SECRET-TOKEN-123")
check("full: experiments", full.settings.experiments.onboarding.active == false and full.settings.experiments.shop.variant == "b")
check("full: weights", #full.settings.experiments.onboarding.weights == 2)
check("full: records supported", S.recordsSupported(full.settings))
local json = S.parseSettings('{"backend":"duckdb","events":"https://a.example.com/ingest"}', decode)
check("json string", json.settings ~= nil and json.settings.backend == "duckdb")
check("defaults", json.settings.flushSeconds == 15 and json.settings.recordShare == 1 and json.settings.techEvery == 60)
check("duckdb records supported", S.recordsSupported(json.settings))
local basinNoRec = S.parseSettings({ backend = "basin", events = "https://a.example.com" }, decode)
check("basin without recordings URL", not S.recordsSupported(basinNoRec.settings))
check("bad json", S.parseSettings("{nope", decode).settings == nil)
check("array root", S.parseSettings("[1]", decode).settings == nil or false)
check("bad backend", S.parseSettings({ backend = "clickhouse", events = "https://a.b" }, decode).settings == nil)
check("bad url", S.parseSettings({ backend = "basin", events = "ftp://a.b" }, decode).settings == nil)
check("url with space", S.parseSettings({ backend = "basin", events = "https://a b" }, decode).settings == nil)
local badToken = S.parseSettings({ backend = "basin", events = "https://a.b", token = 42, flushSeconds = "x" }, decode)
check("bad token: settings still usable", badToken.settings ~= nil and badToken.settings.token == nil)
check("bad token: errors", #badToken.errors == 2, table.concat(badToken.errors, "; "))
local leaky = S.parseSettings({ backend = "nope", events = "https://a.b", token = "SECRET-TOKEN-123" }, decode)
local leaked = false
for _, message in leaky.errors do
	if string.find(message, "SECRET", 1, true) then
		leaked = true
	end
end
check("errors never contain the token", not leaked)
check("bad experiment entry", #S.parseSettings({ backend = "basin", events = "https://a.b", experiments = { x = 5 } }, decode).errors == 1)

-- Queue ----------------------------------------------------------------------------------------------------------------
local state = Q.newQueueState()
local queue = Q.RowQueue.new(state, 100)
for index = 1, 100 do
	queue:push({ id = index })
end
check("queue: at cap", queue:size() == 100 and state.dropped == 0)
queue:push({ id = 101 })
check("queue: over cap drops a tenth + 1", queue:size() == 90, queue:size())
check("queue: dropped counted", state.dropped == 11, state.dropped)
check("queue: oldest dropped", state.rows[1].id == 12, state.rows[1].id)
check("queue: newest kept", state.rows[#state.rows].id == 101)
local sizeOf = function()
	return 100
end
local taken = queue:take(10, 1000, sizeOf)
check("take: rows", #taken == 10 and taken[1].id == 12 and taken[10].id == 21)
check("take: removed", queue:size() == 80 and state.rows[1].id == 22)
local byBytes = queue:take(50, 250, sizeOf)
check("take: byte limit", #byBytes == 2, #byBytes)
local big = queue:take(5, 10, sizeOf)
check("take: first row always", #big == 1)
queue:requeue(big)
queue:requeue(byBytes)
check("requeue: order", state.rows[1].id == 22 and state.rows[2].id == 23 and state.rows[3].id == 24, state.rows[1].id)
check("requeue: size", queue:size() == 80)
local empty = Q.RowQueue.new(Q.newQueueState(), 10)
check("take empty", #empty:take(10, 100, sizeOf) == 0)

-- Handover: the state is plain data; a new generation's queue over the same table sees every row, in order.
local roundTrip = serde.decode("json", serde.encode("json", state))
local next = Q.RowQueue.new(roundTrip, 100)
check("handover: plain data", next:size() == 80 and roundTrip.rows[1].id == 22 and roundTrip.dropped == 11)
local small = Q.RowQueue.new(Q.newQueueState(), 5)
for index = 1, 5 do
	small:push(index)
end
small:requeue({ -1, -2 })
check("requeue over cap drops oldest", small:size() <= 5 and small.state.rows[#small.state.rows] == 5, small:size())

local bucket = { tokens = 3, last = 0 }
check("bucket burst 1", Q.takeToken(bucket, 0, 3, 10))
check("bucket burst 2", Q.takeToken(bucket, 0, 3, 10))
check("bucket burst 3", Q.takeToken(bucket, 0, 3, 10))
check("bucket empty", not Q.takeToken(bucket, 0, 3, 10))
check("bucket 5 s later still empty", not Q.takeToken(bucket, 5, 3, 10))
check("bucket 6 s later refilled", Q.takeToken(bucket, 6.1, 3, 10))
local perMinute = 0
local minute = { tokens = 3, last = 0 }
for second = 0, 600 do
	for _ = 1, 5 do
		if Q.takeToken(minute, second, 3, 10) then
			perMinute += 1
		end
	end
end
check("bucket: ~10 a minute over 10 minutes", perMinute <= 104 and perMinute >= 98, perMinute)
check("backoff 0", Q.backoffSeconds(0, 0.5) == 0)
check("backoff 1", Q.backoffSeconds(1, 0.5) == 5)
check("backoff 3", Q.backoffSeconds(3, 0.5) == 20)
check("backoff capped", Q.backoffSeconds(20, 0.5) == 300)
check("backoff jitter low", Q.backoffSeconds(2, 0) == 7.5)
check("config wait: 300 s spread by jitter (0.75-1.25)", Q.configWaitSeconds(0.5) == 300 and Q.configWaitSeconds(0) == 225 and Q.configWaitSeconds(1) == 375 and Q.configWaitSeconds(7) == 375)
check("status 200", Q.classifyStatus(200) == "sent")
check("status 204", Q.classifyStatus(204) == "sent")
check("status 0", Q.classifyStatus(0) == "retry")
check("status 429", Q.classifyStatus(429) == "retry")
check("status 503", Q.classifyStatus(503) == "retry")
check("status 413", Q.classifyStatus(413) == "split")
check("status 401", Q.classifyStatus(401) == "config")
check("status 404", Q.classifyStatus(404) == "config")
check("status 400", Q.classifyStatus(400) == "drop")

-- Codec ----------------------------------------------------------------------------------------------------------------
local writer = C.RecWriter.new(100)
writer:sample(0, 100.3, 5.1, -40.7, 0.5, 108.3, 12.2, -30.1, 0.6, -0.3)
writer:sample(100, 101.3, 5.1, -40.7, -3.0, 109.3, 12.2, -30.1, 3.1, 1.2)
writer:camera(200, 200, 50, -20, 1.0, -1.5)
writer:key(250, 1, 119, false)
writer:pointer(300, 3, 0, 0.25, 0.75, true)
writer:event(310, 1, "Shop/Buy/Coins100")
writer:event(320, 2, "Shop/Buy/Coins100")
writer:event(330, 8, nil)
writer:sample(70000 + 330, 5000, 5.1, 0, 0, 5000, 5.1, 10, 0, 0) -- 70 s gap and far away: Wait + new anchor
local chunk = writer:finish(true)
local decoded = C.decodeChunk(chunk)
check("decode: version", decoded.version == 1 and decoded.last == true and decoded.intervalMs == 100)
local records = decoded.records
local tags = {}
for _, record in records do
	table.insert(tags, record.tag)
end
check("decode: record order", table.concat(tags, ",") == "1,2,2,3,4,5,6,7,7,7,0,1,2", table.concat(tags, ","))
local s1 = records[2]
check("sample: time", s1.at == 0)
check("sample: char pos", near(s1.values[1], 100.3, 0.07) and near(s1.values[2], 5.1, 0.07) and near(s1.values[3], -40.7, 0.07))
check("sample: char yaw", near(s1.values[4], 0.5, 0.025), s1.values[4])
check("sample: camera pos", near(s1.values[5], 108.3, 0.1) and near(s1.values[6], 12.2, 0.1) and near(s1.values[7], -30.1, 0.1))
check("sample: camera yaw", near(s1.values[8], 0.6, 0.025))
check("sample: pitch", near(s1.values[9], -0.3, 0.013), s1.values[9])
local s2 = records[3]
check("sample 2: time", s2.at == 100)
check("sample 2: yaw wraps", near(s2.values[4], -3.0, 0.025) and (near(s2.values[8], 3.1, 0.025) or near(s2.values[8], 3.1 - 2 * math.pi, 0.025)), s2.values[8])
local cam = records[4]
check("camera: pos", near(cam.values[1], 200, 0.07) and near(cam.values[2], 50, 0.07) and near(cam.values[3], -20, 0.07))
check("camera: pitch", near(cam.values[5], -1.5, 0.013))
check("key", records[5].kind == 1 and records[5].code == 119 and records[5].processed == false and records[5].at == 250)
check("pointer", records[6].kind == 3 and records[6].processed == true and near(records[6].x, 0.25, 0.0001) and near(records[6].y, 0.75, 0.0001))
check("string defined once", records[7].text == "Shop/Buy/Coins100" and records[8].text == "Shop/Buy/Coins100" and records[9].text == "Shop/Buy/Coins100")
check("event kinds", records[8].kind == 1 and records[9].kind == 2 and records[10].kind == 8 and records[10].text == nil)
check("wait record", records[11].at == 330 + 65535)
check("far sample re-anchors", records[12].tag == 1 and near(records[13].values[1], 5000, 0.07) and records[13].at == 70330)
check("samples counted", writer.samples == 4, writer.samples)
check("not last", C.decodeChunk(C.RecWriter.new(100):finish(false)).last == false)
check("empty chunk", #C.decodeChunk(C.RecWriter.new(100):finish(false)).records == 0)
check("long string cut to 255", (function()
	local w = C.RecWriter.new(100)
	w:event(0, 11, string.rep("x", 400))
	return #C.decodeChunk(w:finish(false)).records[2].text == 255
end)())
check("bad version throws", not pcall(C.decodeChunk, buffer.fromstring("\2\0\100\0")))
check("truncated throws", not pcall(C.decodeChunk, buffer.fromstring("\1\0\100\0\2\0\0\1")))

-- About 90 s of a moving player at 10 Hz plus some input: well inside the 20-30 KB per new player of plans/16.
local session = C.RecWriter.new(100)
for step = 0, 899 do
	local t = step * 100
	session:sample(t, step * 0.4, 3, math.sin(step / 20) * 30, step / 50, step * 0.4 + 10, 8, 10, step / 50, -0.2)
	if step % 20 == 0 then
		session:key(t + 5, 1, 119, false)
		session:event(t + 6, 1, "HUD/Play")
	end
end
local sessionBytes = buffer.len(session:finish(true))
check("90 s session under 20 KB", sessionBytes < 20000, sessionBytes)

check("base64 Man", C.toBase64(buffer.fromstring("Man")) == "TWFu")
check("base64 Ma", C.toBase64(buffer.fromstring("Ma")) == "TWE=")
check("base64 M", C.toBase64(buffer.fromstring("M")) == "TQ==")
check("base64 empty", C.toBase64(buffer.create(0)) == "")
local text = C.toBase64(chunk)
check("base64 roundtrip", buffer.tostring(C.fromBase64(text)) == buffer.tostring(chunk))
local allBytes = buffer.create(256)
for index = 0, 255 do
	buffer.writeu8(allBytes, index, index)
end
check("base64 all bytes", buffer.tostring(C.fromBase64(C.toBase64(allBytes))) == buffer.tostring(allBytes))

-- Sinks ----------------------------------------------------------------------------------------------------------------
local row = {
	v = 1,
	t = 1759680000123,
	kind = "custom",
	name = 'quest "done"',
	pid = "abc",
	sid = "def",
	job = "job-1",
	srv = "public",
	place = 123456789012,
	art = "a1b2",
	seq = 42,
	branch = "main",
	channel = "prod",
	dev = "phone",
	newp = true,
	state = "zone:Lobby|activity:round",
	exp = '{"onboarding":"short"}',
	sexp = "",
	src = "server",
	props = '{"quest":"tutorial"}',
}
local encoded = K.encodeRow(row, K.EVENT_COLUMNS, quote)
check("row: exact t", string.find(encoded, '"t":1759680000123', 1, true) ~= nil, encoded)
check("row: exact place", string.find(encoded, '"place":123456789012', 1, true) ~= nil)
check("row: bool", string.find(encoded, '"newp":true', 1, true) ~= nil)
local back = serde.decode("json", encoded)
check("row: valid json", back.name == 'quest "done"' and back.props == '{"quest":"tutorial"}' and back.seq == 42)
local columns = 0
for _ in back do
	columns += 1
end
check("row: 20 columns", columns == 20 and #K.EVENT_COLUMNS == 20, columns)
local sparse = serde.decode("json", K.encodeRow({ t = 5.7 }, K.EVENT_COLUMNS, quote))
check("row: missing values filled", sparse.v == 0 and sparse.t == 5 and sparse.name == "" and sparse.newp == false)
check("recording columns", #K.RECORDING_COLUMNS == 10)
local recording = { v = 1, t = 1759680000123, pid = "abc", sid = "def", job = "j", art = "a", chunk = 0, codec = "tt-rec-1", data = text, n = 4 }

local basinSettings = full.settings
local requests = K.buildRequests(basinSettings, { row }, { recording }, quote)
check("basin: two requests", #requests == 2)
check("basin: events url", requests[1].url == "https://abc.ingest.cloudflare.com" and requests[1].table == "events")
check("basin: recordings url", requests[2].url == "https://def.ingest.cloudflare.com" and requests[2].table == "recordings")
check("basin: bearer", requests[1].headers.Authorization == "Bearer SECRET-TOKEN-123")
check("basin: json", requests[1].headers["Content-Type"] == "application/json")
check("basin: not gzip", requests[1].gzip == false)
local array = serde.decode("json", requests[1].body)
check("basin: JSON array of rows", #array == 1 and array[1].t == 1759680000123)
check("basin: recordings body", serde.decode("json", requests[2].body)[1].data == text)
check("basin: no events, no request", #K.buildRequests(basinSettings, {}, { recording }, quote) == 1)
check("basin: no recordings URL", #K.buildRequests(basinNoRec.settings, { row }, { recording }, quote) == 1)
local noToken = K.buildRequests(basinNoRec.settings, { row }, {}, quote)[1]
check("basin: no token, no header", noToken.headers.Authorization == nil)
local duck = K.buildRequests(json.settings, { row, row }, { recording }, quote)
check("duckdb: one request", #duck == 1 and duck[1].table == "both" and duck[1].gzip == true)
local body = serde.decode("json", duck[1].body)
check("duckdb: body", #body.events == 2 and #body.recordings == 1 and body.recordings[1].codec == "tt-rec-1")
check("duckdb: counts", duck[1].events == 2 and duck[1].recordings == 1)
check("duckdb: empty", #K.buildRequests(json.settings, {}, {}, quote) == 0)
check("estimate covers encoding", K.estimateEventBytes(row) >= #encoded, K.estimateEventBytes(row))

-- Identities (pid -> UserId, for the dev's own server; never in the events table) --------------------------------------
local identity = { pid = "abc", uid = 1234567890123, t = 1759680000123 }
local duckWho = K.buildRequests(json.settings, { row }, {}, quote, { identity })
local whoBody = serde.decode("json", duckWho[1].body)
check("identity: duckdb, same body", #duckWho == 1 and #whoBody.identities == 1 and duckWho[1].identities == 1)
check("identity: exact uid", string.find(duckWho[1].body, '"uid":1234567890123', 1, true) ~= nil, duckWho[1].body)
check("identity: not in events", #whoBody.events == 1 and whoBody.events[1].uid == nil)
check("identity: duckdb body without identities keeps its shape", serde.decode("json", duck[1].body).identities == nil)
check("identity: duckdb sends identities alone", #K.buildRequests(json.settings, {}, {}, quote, { identity }) == 1)
local fleetValue = { url = "https://fleet.example.com/", token = "FLEET-TOKEN" }
local target = S.identityTarget(basinSettings, fleetValue, decode)
check("identity: basin target from TypeTorchFleet", target ~= nil and target.url == "https://fleet.example.com/v1/identity" and target.token == "FLEET-TOKEN")
check("identity: TypeTorchFleet as JSON text", S.identityTarget(basinSettings, '{"url":"https://f.example.com","token":"T"}', decode).url == "https://f.example.com/v1/identity")
check("identity: basin without fleet, no target", S.identityTarget(basinSettings, nil, decode) == nil)
check("identity: duckdb never needs a target", S.identityTarget(json.settings, fleetValue, decode) == nil)
local basinWho = K.buildRequests(basinSettings, { row }, {}, quote, { identity }, target)
check("identity: basin, own request", #basinWho == 2 and basinWho[2].table == "identities" and basinWho[2].url == "https://fleet.example.com/v1/identity")
check("identity: basin, fleet token", basinWho[2].headers.Authorization == "Bearer FLEET-TOKEN")
check("identity: basin events untouched", serde.decode("json", basinWho[1].body)[1].uid == nil)
check("identity: basin body", serde.decode("json", basinWho[2].body).identities[1].pid == "abc")
check("identity: basin without target, nothing sent", #K.buildRequests(basinSettings, {}, {}, quote, { identity }) == 0)
local explicit = S.parseSettings({ backend = "basin", events = "https://abc.ingest.cloudflare.com", identity = "https://my.example.com/v1/identity", identityToken = "ID-TOKEN" }, decode)
check("identity: settings fields", explicit.settings.identity == "https://my.example.com/v1/identity" and explicit.settings.identityToken == "ID-TOKEN" and #explicit.errors == 0)
local explicitTarget = S.identityTarget(explicit.settings, fleetValue, decode)
check("identity: explicit URL and token win", explicitTarget.url == "https://my.example.com/v1/identity" and explicitTarget.token == "ID-TOKEN")
local badIdentity = S.parseSettings({ backend = "basin", events = "https://abc.ingest.cloudflare.com", identity = "ftp://x", identityToken = "" }, decode)
check("identity: bad fields reported, token never echoed", #badIdentity.errors == 2 and not string.find(table.concat(badIdentity.errors, " "), "ID-TOKEN", 1, true))

-- Protocol ------------------------------------------------------------------------------------------------------------
check("hello clean", P.cleanHello({ dev = "phone", input = "touch", w = 390.4, h = 844, touch = true, load = 3.14159 }).w == 390)
check("hello bad dev", P.cleanHello({ dev = "toaster" }).dev == "unknown")
check("hello not table", P.cleanHello("x") == nil)
check("hello load", P.cleanHello({ load = 3.14159 }).load == 3.1)
check("event ok", P.cleanClientEvent({ 100, "custom", "quest_done", "{}" }) ~= nil)
check("event bad kind", P.cleanClientEvent({ 100, "session", "join", "{}" }) == nil)
check("event fleet kind refused", P.cleanClientEvent({ 100, "fleet", "heartbeat", "{}" }) == nil)
check("event purchase from a client refused", P.cleanClientEvent({ 100, "purchase", "product", '{"product":1,"robux":99}' }) == nil)
check("event currency from a client refused", P.cleanClientEvent({ 100, "currency", "coins", '{"delta":50}' }) == nil)
check("event funnel, state, tech ok", P.cleanClientEvent({ 1, "funnel", "onboarding", '{"i":1}' }) ~= nil and P.cleanClientEvent({ 1, "state", "screen", '{"to":"Shop"}' }) ~= nil and P.cleanClientEvent({ 1, "tech", "client", '{"fps":60}' }) ~= nil)
check("event old", P.cleanClientEvent({ 700000, "custom", "x", "{}" }) == nil)
check("event props not object", P.cleanClientEvent({ 1, "custom", "x", "[1]" }) == nil)
check("event props too big", P.cleanClientEvent({ 1, "custom", "x", "{" .. string.rep("a", 4100) .. "}" }) == nil)
check("event name control char", P.cleanClientEvent({ 1, "custom", "a\nb", "{}" }) == nil)
check("event nan age", P.cleanClientEvent({ 0 / 0, "custom", "x", "{}" }) == nil)

-- Failure help (hints.luau): what a failed upload means and the fix; shared by the log line and the dev menu --------------
local function has(text, needle)
	return text ~= nil and string.find(text, needle, 1, true) ~= nil
end
check("httpErrorName", H.httpErrorName("both: HttpError: NetFail") == "NetFail" and H.httpErrorName("HttpError:DnsResolve") == "DnsResolve")
check("httpErrorName: none", H.httpErrorName("HTTP 530") == nil and H.httpErrorName(nil) == nil)
local netFail = H.describeFailure(0, "both: HttpError: NetFail")
check("NetFail: reason", has(netFail.reason, "NetFail") and has(netFail.reason, "broke mid-request"), netFail.reason)
check("NetFail: fix names doctor, the tunnel and bun run local", has(netFail.fix, "typetorch doctor") and has(netFail.fix, "quick tunnel") and has(netFail.fix, "bun run local"), netFail.fix)
local dns = H.describeFailure(0, "analytics: HttpError: DnsResolve")
check("DnsResolve: a stale quick tunnel", has(dns.reason, "DnsResolve") and has(dns.fix, "trycloudflare.com") and has(dns.fix, "bun run local"), dns.fix)
check("ConnectFail", has(H.describeFailure(0, "HttpError: ConnectFail").reason, "ConnectFail") and has(H.describeFailure(0, "HttpError: ConnectFail").fix, "down"))
check("TimedOut", has(H.describeFailure(0, "HttpError: TimedOut").reason, "TimedOut"))
check("Ssl", has(H.describeFailure(0, "HttpError: SslVerificationFail").fix, "certificate"))
check("InvalidUrl", has(H.describeFailure(0, "HttpError: InvalidUrl").fix, "settings set analytics"))
check("redirects", has(H.describeFailure(0, "HttpError: TooManyRedirects").reason, "redirects"))
check("an unknown HttpError is named", has(H.describeFailure(0, "HttpError: Strange").reason, "Strange"))
check("HttpService off", has(H.describeFailure(0, "Http requests are not enabled. Enable via game settings.").fix, "Allow HTTP Requests"))
check("Roblox's request limit", has(H.describeFailure(0, "Number of requests exceeded limit").fix, "500"))
check("no message at all", H.describeFailure(0, nil).reason == "no answer" and has(H.describeFailure(0, nil).fix, "typetorch doctor"))
check("unknown text is kept, cut", #H.describeFailure(0, string.rep("x", 500)).reason == 120)
check("HTTP 530: tunnel", has(H.describeFailure(530).reason, "tunnel has nothing behind it") and has(H.describeFailure(530).fix, "bun run local"))
check("HTTP 502/504: server behind the tunnel", has(H.describeFailure(502).reason, "behind the tunnel") and has(H.describeFailure(504).reason, "HTTP 504"))
check("HTTP 401/403: token", has(H.describeFailure(401).fix, "TT_ANALYTICS_INGEST_TOKENS") and has(H.describeFailure(403).reason, "refused the token"))
check("HTTP 404: URL", has(H.describeFailure(404).fix, "/v1/ingest"))
check("HTTP 429/413/500/408", has(H.describeFailure(429).reason, "rate limited") and has(H.describeFailure(413).fix, "splits") and has(H.describeFailure(500).fix, "log") and has(H.describeFailure(408).reason, "timed out"))
check("an unusual status", H.describeFailure(418).reason == "HTTP 418")
check("fleet error text: HTTP 530", H.describeFleetError("HTTP 530").reason == H.describeFailure(530).reason)
check("fleet error text: HttpError", has(H.describeFleetError("HttpError: NetFail").reason, "NetFail"))
check("fleet error text: none", H.describeFleetError(nil) == nil)

print(`analytics: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
