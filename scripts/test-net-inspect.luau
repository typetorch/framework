-- Offline test of the compiled packet capture (out/net/inspect.luau) and the dispatcher hooks (out/net/runtime.luau)
-- under Lune: serialization caps, cycles, datatypes, invalid UTF-8, the ring and its cursors, the per-second cap,
-- guard verdicts, responses, raw channels, and client blocks. The kernel and Promise are stubbed.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-net-inspect.luau ../framework/out/net/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local task = require("@lune/task")
local base = process.args[1] or "out/net/"

local guid = 0
local services = {
	HttpService = {
		GenerateGUID = function()
			guid += 1
			return string.format("%08x-0000-0000-0000-000000000000", guid)
		end,
	},
	-- 0.2.1: sendAll broadcasts when every listed player's client said hello (none listed here).
	Players = {
		GetPlayers = function()
			return {}
		end,
	},
}
local Promise = {}
function Promise.new(executor)
	local promise = { status = "pending" }
	executor(function(value)
		promise.status, promise.value = "resolved", value
	end, function(reason)
		promise.status, promise.value = "rejected", reason
	end)
	return promise
end
-- The server dispatcher asks whether a request handler answered with a Promise (none do here).
function Promise.is(value)
	return type(value) == "table" and value.status ~= nil
end

local env
local script = {}
local modules = {}
local function loadModule(name)
	if modules[name] then
		return modules[name]
	end
	local source = fs.readFile(base .. name .. ".luau")
	modules[name] = luau.load(source, { debugName = name, environment = env })()
	return modules[name]
end
local TS = {
	Promise = Promise,
	getModule = function()
		return "services"
	end,
	import = function(_, from, name)
		if from == "services" then
			return services
		end
		return loadModule(name)
	end,
}
env = setmetatable({
	game = roblox.Instance.new("DataModel"),
	script = script,
	_G = { [script] = TS },
	Instance = roblox.Instance,
	Vector2 = roblox.Vector2,
	Vector3 = roblox.Vector3,
	CFrame = roblox.CFrame,
	Color3 = roblox.Color3,
	UDim = roblox.UDim,
	UDim2 = roblox.UDim2,
	Enum = roblox.Enum,
	task = task,
	DateTime = { now = function() return { UnixTimestampMillis = 1700000000123 } end },
}, { __index = _G })

local inspect = loadModule("inspect")
local runtime = loadModule("runtime")
local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (detail ~= nil and (": " .. tostring(detail)) or ""))
	end
end
local function has(text, needle)
	return string.find(text, needle, 1, true) ~= nil
end

-- Serialization ---------------------------------------------------------------------------------------------------
local pretty = inspect.prettyArgs({ "coin-3", 5, 1.25, true })
check("pretty array", pretty == '[\n  "coin-3",\n  5,\n  1.25,\n  true\n]', pretty)
local preview = inspect.previewArgs({ "coin-3", { amount = 5, b = "x" } })
check("preview one line", preview == '["coin-3", {amount: 5, b: "x"}]', preview)
check("escapes", has(inspect.prettyArgs({ 'a"b\n\\' }), [["a\"b\n\\"]]), inspect.prettyArgs({ 'a"b\n\\' }))
check("nan/inf", has(inspect.previewArgs({ 0 / 0, math.huge, -math.huge }), "nan, inf, -inf"), inspect.previewArgs({ 0 / 0, math.huge }))
local cyclic = { name = "loop" }
cyclic.self = cyclic
check("cycle", has(inspect.prettyArgs({ cyclic }), "self: <cycle>"), inspect.prettyArgs({ cyclic }))
local deep = { a = { b = { c = { d = { e = { f = { g = 1 } } } } } } }
check("depth cap", has(inspect.previewArgs({ deep }), "{...1}"), inspect.previewArgs({ deep }))
local many = {}
for index = 1, 100 do
	many[index] = index
end
local manyText = inspect.prettyArgs({ many })
check("entries cap", has(manyText, "+60 more"), manyText:sub(-40))
local long = string.rep("x", 1000)
check("long string cut", has(inspect.prettyArgs({ long }), "(+700)"), inspect.prettyArgs({ long }):sub(-20))
check("preview budget", #inspect.previewArgs({ long, long }) <= 150, #inspect.previewArgs({ long, long }))
check("pretty budget", #inspect.prettyArgs({ many, many, many, { long, long, long, long, long, long, long, long, long, long, long, long, long, long, long } }) <= 4010)
local binary = "ok\255\254\0"
local binaryText = inspect.prettyArgs({ binary })
check("invalid utf8 escaped", has(binaryText, [["ok\xff\xfe\x00"]]), binaryText)
check("utf8 kept", has(inspect.prettyArgs({ "héllo" }), '"héllo"'), inspect.prettyArgs({ "héllo" }))
local cutText = inspect.prettyArgs({ "a" .. string.rep("é", 200) })
check("cut keeps utf8", utf8.len((cutText:match('"(.-)"'))) ~= nil, cutText:sub(1, 30))
local part = roblox.Instance.new("Part")
part.Name = "Coin"
local folder = roblox.Instance.new("Folder")
folder.Name = "Coins"
part.Parent = folder
local types = inspect.previewArgs({ roblox.Vector3.new(1, 2.5, -3.333), part })
check("Vector3", has(types, "Vector3(1, 2.5, -3.33)"), types)
check("Instance path", has(types, "Part(Coins.Coin)"), types)
local frame = inspect.prettyArgs({ roblox.CFrame.new(1, 2, 3), roblox.Color3.new(1, 0, 0) })
check("CFrame", has(frame, "CFrame(1, 2, 3)"), frame)
check("Color3", has(frame, "Color3(255, 0, 0)"), frame)
local bytes = buffer.create(30)
buffer.writeu8(bytes, 0, 171)
check("buffer", has(inspect.previewArgs({ bytes }), "buffer(30) ab 00"), inspect.previewArgs({ bytes }))
check("mixed keys sorted", inspect.previewArgs({ { [2] = "b", z = 1, a = 2 } }) == '[{[2]: "b", a: 2, z: 1}]', inspect.previewArgs({ { [2] = "b", z = 1, a = 2 } }))
check("odd key quoted", has(inspect.previewArgs({ { ["two words"] = 1 } }), '"two words": 1'))
check("empty", inspect.previewArgs({ {} }) == "[{}]", inspect.previewArgs({ {} }))
check("no arguments", inspect.previewArgs({}) == "[]", inspect.previewArgs({}))
local size, approx = table.unpack(inspect.estimateSize({ "abc", 1 }))
check("size estimate", size == 2 + 5 + 9 and not approx, size)
local huge = {}
for index = 1, 5000 do
	huge[index] = index
end
local _, hugeApprox = table.unpack(inspect.estimateSize({ huge }))
check("size budget", hugeApprox)

-- The ring -------------------------------------------------------------------------------------------------------------
local tap = inspect.PacketTap.new()
for index = 1, 600 do
	if index % 300 == 1 then
		tap.windowStart = -100 -- stay under the per-second cap
	end
	tap:record("out", "fire", "coins.changed", { index })
end
local records, cursor, skipped = table.unpack(tap:since(0, 200))
check("page limit", #records == 200 and records[200].i == 600, #records)
check("cursor", cursor == 600, cursor)
check("skipped = wrapped + over the page", skipped == 400, skipped)
check("evicted", tap:get(50) == nil and tap:get(150) ~= nil and tap:get(600).preview == "[600]")
local none = tap:since(600, 200)[1]
check("nothing new", #none == 0)
tap:clear()
check("cleared", tap:get(600) == nil)
tap:record("in", "invoke", "shop.buy", { "sword" })
local afterClear, afterCursor, afterSkipped = table.unpack(tap:since(600, 200))
check("cursor survives clear", #afterClear == 1 and afterClear[1].i == 601 and afterCursor == 601 and afterSkipped == 0)
local fresh = tap:since(0, 200)[1]
check("clear drops older", #fresh == 1)
local players = { { Name = "Ann", UserId = 1 }, { Name = "Bob", UserId = 2 } }
tap:record("out", "fire", "a", {}, "ok", nil, players[1])
tap:record("out", "fire", "b", {}, "ok", nil, players[2])
tap:record("out", "fire", "c", {}, "ok", nil, "all")
local annOnly = tap:since(601, 50, function(record)
	return record.userId == 1 or record.player == "all"
end)[1]
check("player filter", #annOnly == 2 and annOnly[1].path == "a" and annOnly[2].path == "c")
check("summary drops args", inspect.summarize(annOnly[1]).args == nil and inspect.summarize(annOnly[1]).player == "Ann")
tap.recording = false
check("paused records nothing", tap:record("out", "fire", "x", {}) == nil)
tap.recording = true
local capped = inspect.PacketTap.new()
for _ = 1, 450 do
	capped:record("out", "fire", "spam", {})
end
check("per-second cap", capped.dropped == 50, capped.dropped)
local weird = newproxy(true)
getmetatable(weird).__tostring = function()
	error("boom")
end
local okRecord, weirdRecord = pcall(function()
	return tap:record("out", "fire", "w", { weird })
end)
check("never throws", okRecord and weirdRecord == nil, weirdRecord)
local odd = inspect.previewArgs({ print, coroutine.create(print) })
check("functions and threads", odd == "[<function>, <thread>]", odd)

-- Server dispatcher ------------------------------------------------------------------------------------------------
local sent = {}
local kernel = {}
function kernel:send(player, channel, ...)
	table.insert(sent, { player = player, channel = channel, args = { ... } })
end
function kernel:broadcast(channel, ...)
	table.insert(sent, { channel = channel, args = { ... } })
end
kernel.sendUnreliable = kernel.send
kernel.broadcastUnreliable = kernel.broadcast
local player = { Name = "Ann", UserId = 1, Kick = function() end }
runtime.registeredGuards["coins.collect"] = function(args)
	return type(args[1]) == "string"
end
runtime.registeredGuards["shop.buy"] = function(args)
	return type(args[1]) == "string"
end
local server = runtime.ServerDispatcher.new(kernel)
server.dispatch(player, "e:coins.collect", "coin-1")
check("no tap, no capture", server.tap == nil)
local serverTap = inspect.PacketTap.new()
server.tap = serverTap
local heard = 0
server:addListener("coins.collect", function()
	heard += 1
	if heard == 1 then
		error("listener broke")
	end
end)
server.dispatch(player, "e:coins.collect", "coin-2")
server.dispatch(player, "e:coins.collect", 42)
server.dispatch(player, "e:coins.collect", string.rep("x", 5000))
server.dispatch(player, "e:nope.undeclared", 1)
server.dispatch(player, "zz:what", 1)
server:setRaw("__tt/dev", function() end)
server.dispatch(player, "__tt/dev", 1, "claude.pair", "secret-code")
server:setHandler("shop.buy", function(_, item)
	return item .. " bought"
end)
server.dispatch(player, "r:shop.buy", 7, "sword")
server:send(player, "coins.changed", { 10 })
server:sendAll("coins.changed", { 11 }, true)
local list = serverTap:since(0, 100)[1]
local function at(index)
	return list[index] or {}
end
check("server count (raw never captured)", #list == 9, #list)
check("listener error", at(1).status == "error" and has(at(1).reason or "", "listener broke") and heard == 1, at(1).reason)
check("type guard", at(2).status == "rejected" and at(2).reason == "type guard", at(2).reason)
check("shape limits", at(3).status == "rejected" and at(3).reason == "shape limits", at(3).reason)
check("undeclared", at(4).reason == "undeclared path", at(4).reason)
check("unknown channel", at(5).path == "zz:what" and at(5).reason == "unknown channel", at(5).path)
check("invoke in", at(6).kind == "invoke" and at(6).dir == "in" and at(6).player == "Ann" and at(6).userId == 1)
check("response out", at(7).kind == "response" and at(7).path == "shop.buy" and has(at(7).args, "sword bought"), at(7).args)
check("fire out", at(8).dir == "out" and at(8).kind == "fire" and at(8).player == "Ann")
check("broadcast unreliable", at(9).kind == "unreliable" and at(9).player == "all")
for _ = 1, 30 do
	server.dispatch(player, "e:coins.collect", "spam")
end
local limited = serverTap:since(9, 100)[1]
check("rate limited", limited[#limited].status == "limited" and limited[#limited].reason == "rate limit", limited[#limited] and limited[#limited].status)
server.tap = nil
local before = #serverTap:since(0, 1000)[1]
server:send(player, "coins.changed", { 12 })
check("detached = no capture", #serverTap:since(0, 1000)[1] == before)

-- Client dispatcher ------------------------------------------------------------------------------------------------
local outbox = {}
local clientKernel = {}
function clientKernel:send(channel, ...)
	table.insert(outbox, { channel = channel, args = { ... } })
end
clientKernel.sendUnreliable = clientKernel.send
local client = runtime.ClientDispatcher.new(clientKernel)
local clientTap = inspect.PacketTap.new()
client.tap = clientTap
clientTap.blocked["coins.collect"] = true
client:fire("coins.collect", { "coin-9" })
check("blocked fire not sent", #outbox == 0)
local blockedInvoke = client:invoke("coins.collect", { "x" })
check("blocked invoke rejects", blockedInvoke.status == "rejected" and #outbox == 0, blockedInvoke.value)
local got = 0
client:addListener("coins.changed", function()
	got += 1
end)
clientTap.blocked["coins.changed"] = true
client.dispatch("e:coins.changed", 5)
check("blocked inbound skips listeners", got == 0)
clientTap.blocked["coins.changed"] = nil
client.dispatch("e:coins.changed", 6)
check("unblocked inbound", got == 1)
local promise = client:invoke("shop.buy", { "sword" })
local requestId = outbox[#outbox].args[1]
client.dispatch("__tt/res", requestId, true, "sword bought")
check("invoke resolves", promise.status == "resolved" and promise.value == "sword bought")
client.dispatch("__tt/res", 999, false, "late")
local clientList = clientTap:since(0, 100)[1]
local statuses = {}
for _, record in clientList do
	table.insert(statuses, record.dir .. ":" .. record.kind .. ":" .. record.path .. ":" .. record.status)
end
local joined = table.concat(statuses, " ")
check("client log", joined == "out:fire:coins.collect:blocked out:invoke:coins.collect:blocked in:fire:coins.changed:blocked in:fire:coins.changed:ok out:invoke:shop.buy:ok in:response:shop.buy:ok in:response:(late response):error", joined)
client.tap = nil
client:fire("coins.collect", { "coin-10" })
check("blocks end with the tap", #outbox == 2 and outbox[2].channel == "e:coins.collect")
client:stop()

print(`{passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
