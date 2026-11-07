--!nocheck
-- Offline test of the notifications server (out/notifications/server.luau, plans/29) under Lune, with mocked services:
-- launch data verified on join (open / open_bad rows, POST /v1/notify/opened, onOpen for players who joined before the
-- callback), presence, want / drop rows (key hashed, offline), intents batched at 200 to /v1/notify/intents with the
-- backend key, a swap in the middle of a request (the batch goes again, first; no second verify, no second presence),
-- `played` + presence offline on leave, the client's opt-in rows (checked, capped), and an unreachable backend (first =
-- true, the opened call retried). Run after `bun run build`:
--   cd ../kernel && lune run ../framework/scripts/test-notify-server.luau ../framework/out/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")
local task = require("@lune/task")
local base = process.args[1] or "out/"

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end

-- Mocks --------------------------------------------------------------------------------------------------------------

local function Signal()
	local handlers = {}
	local signal = {}
	function signal:Connect(fn)
		local connection = { Connected = true }
		handlers[connection] = fn
		function connection:Disconnect()
			handlers[connection] = nil
			connection.Connected = false
		end
		return connection
	end
	function signal:Fire(...)
		for _, fn in table.clone(handlers) do
			task.spawn(fn, ...)
		end
	end
	return signal
end

local Trove = {}
Trove.__index = Trove
local function cleanup(item)
	if type(item) == "function" then
		item()
	elseif type(item) == "thread" then
		pcall(task.cancel, item)
	elseif getmetatable(item) == Trove then
		item:clean()
	elseif type(item) == "table" and item.Disconnect then
		item:Disconnect()
	end
end
function Trove.new()
	return setmetatable({ items = {} }, Trove)
end
function Trove:add(item)
	table.insert(self.items, item)
	return item
end
function Trove:connect(signal, fn)
	return self:add(signal:Connect(fn))
end
function Trove:extend()
	return self:add(Trove.new())
end
function Trove:clean()
	local items = self.items
	self.items = {}
	for index = #items, 1, -1 do
		cleanup(items[index])
	end
end

local INSTANCE = {}
local PlayersService = { PlayerAdded = Signal(), PlayerRemoving = Signal(), list = {} }
PlayersService[INSTANCE] = true
function PlayersService:GetPlayers()
	return table.clone(self.list)
end
function PlayersService:GetPlayerByUserId(userId)
	for _, player in self.list do
		if player.UserId == userId then
			return player
		end
	end
	return nil
end
local function makePlayer(userId, launch)
	local player = { UserId = userId, Name = "P" .. userId, Parent = PlayersService, [INSTANCE] = true }
	function player:IsA(class)
		return class == "Player"
	end
	function player:GetJoinData()
		return { LaunchData = launch }
	end
	return player
end
local function join(player)
	table.insert(PlayersService.list, player)
	PlayersService.PlayerAdded:Fire(player)
end
local function leave(player)
	PlayersService.PlayerRemoving:Fire(player)
	task.wait()
	table.remove(PlayersService.list, table.find(PlayersService.list, player))
	player.Parent = nil
end

local requests = {}
-- path -> function(request) -> response
local routes = {}
local HttpService = {}
function HttpService:JSONEncode(value)
	return serde.encode("json", value)
end
function HttpService:JSONDecode(text)
	return serde.decode("json", text)
end
function HttpService:RequestAsync(request)
	table.insert(requests, request)
	local path = request.Url:match("^https?://[^/]+(.*)$")
	local route = routes[path]
	if not route then
		return { Success = false, StatusCode = 404, StatusMessage = "Not Found", Body = "" }
	end
	return route(request)
end
local function ok(body)
	return { Success = true, StatusCode = 200, StatusMessage = "OK", Body = serde.encode("json", body) }
end
local services = {
	HttpService = HttpService,
	Players = PlayersService,
	Workspace = {
		GetAttribute = function()
			return nil
		end,
	},
}

local persistStore = {}
local closeHooks = {}
local settingsMock = { current = nil, listeners = {} }
local raw = {}
local dispatcher = {}
function dispatcher:setRaw(channel, fn)
	raw[channel] = fn
end
function dispatcher:removeRaw(channel)
	raw[channel] = nil
end

local outFolder = { Name = "out" }
local G = {}
local loaded = {}
local TS = {}
local internals
function TS.getModule(_, scope, name)
	return { external = scope .. "/" .. name }
end
local loadOut
function TS.import(_, parent, ...)
	if type(parent) == "table" and parent.external then
		return services
	end
	local path = table.concat({ ... }, "/")
	if parent ~= outFolder then
		path = parent.Name .. "/" .. path
	end
	if internals[path] then
		return internals[path]
	end
	return loadOut(path)
end
local warnings = {}
function loadOut(path)
	if loaded[path] then
		return loaded[path]
	end
	local folder = { Name = path:match("^[^/]+"), Parent = outFolder }
	local script = { Name = path:match("[^/]+$"), Parent = folder }
	G[script] = TS
	local environment = setmetatable({
		script = script,
		_G = G,
		task = task,
		DateTime = {
			now = function()
				return { UnixTimestampMillis = os.time() * 1000 + math.floor(os.clock() * 1000) % 1000 }
			end,
		},
		typeof = function(value)
			if type(value) == "table" and value[INSTANCE] then
				return "Instance"
			end
			return typeof(value)
		end,
		warn = function(...)
			table.insert(warnings, table.concat({ ... }, " "))
		end,
	}, { __index = _G })
	local value = luau.load(fs.readFile(base .. path .. ".luau"), { debugName = path, environment = environment })()
	loaded[path] = value
	return value
end

internals = {
	typetorch = {
		TypeTorch = {
			persist = function(_, key, init)
				if persistStore[key] == nil then
					persistStore[key] = init()
				end
				return persistStore[key]
			end,
		},
		closeHooksSupported = function()
			return true
		end,
		onGenerationClose = function(fn)
			closeHooks[fn] = true
			return function()
				closeHooks[fn] = nil
			end
		end,
	},
	settings = {
		currentSettings = function()
			return settingsMock.current
		end,
		onSettings = function(fn)
			table.insert(settingsMock.listeners, fn)
			return function() end
		end,
	},
	["net/runtime"] = {
		maybeServerDispatcher = function()
			return dispatcher
		end,
	},
	players = {
		observePlayers = function(trove, callback)
			trove:connect(PlayersService.PlayerAdded, callback)
			for _, player in PlayersService:GetPlayers() do
				task.spawn(callback, player)
			end
			return function() end
		end,
	},
}

local NotifyServer = loadOut("notifications/server").NotifyServer
local Rows = loadOut("analytics/rows")
local Token = loadOut("notifications/token")
local Protocol = loadOut("notifications/protocol")

-- Rows the "analytics engine" receives.
local rows = {}
local function rowsNamed(name)
	local list = {}
	for _, row in rows do
		if row.name == name then
			table.insert(list, row)
		end
	end
	return list
end

-- Setup ---------------------------------------------------------------------------------------------------------------------

local KEY = string.rep("k", 43)
local BACKEND_KEY = "game-key-secret"
settingsMock.current = { backend = { url = "https://b.example.com/", key = BACKEND_KEY, analytics = { flushSeconds = 5 }, notify = { keys = { current = KEY } } } }
local openedCalls = {}
routes["/v1/notify/opened"] = function(request)
	local body = serde.decode("json", request.Body)
	table.insert(openedCalls, body)
	return ok({ state = if #openedCalls == 1 then "first" else "repeat" })
end
local intents = {}
routes["/v1/notify/intents"] = function(request)
	local body = serde.decode("json", request.Body)
	table.insert(intents, body)
	return ok({ ok = true, accepted = #body.items, rejected = {} })
end
local played = {}
routes["/v1/notify/played"] = function(request)
	table.insert(played, serde.decode("json", request.Body))
	return ok({ ok = true })
end

local now = os.time()
local ALICE, BOB, CAROL = 1001, 1002, 1003
local good = Token.signToken(KEY, "abc0123xyz", "gift_new", ALICE, now - 120, "mail:42")
local forged = Token.signToken(string.rep("x", 43), "abc0123xyz", "gift_new", BOB, now - 120, "mail:42")
local alice = makePlayer(ALICE, good)
local bob = makePlayer(BOB, forged)
local carol = makePlayer(CAROL, "shop/7")
join(alice) -- before the server starts: observePlayers hands her over

local trove1 = Trove.new()
local server1 = NotifyServer.new(nil, trove1)
join(bob)
join(carol)
task.wait(0.3)

-- No analytics engine yet: rows are held, then handed over when one registers.
check("rows held without an engine", #persistStore["__typetorch/notify.v1"].held >= 2, #persistStore["__typetorch/notify.v1"].held)
local unregister = Rows.registerBuiltinRows(function(target, kind, name, props)
	table.insert(rows, { target = target, kind = kind, name = name, props = props })
end)
task.wait(1.2)
check("held rows drained", #persistStore["__typetorch/notify.v1"].held == 0 and #rows >= 2)

-- Joins ---------------------------------------------------------------------------------------------------------------------
local opens = rowsNamed("open")
check("open row", #opens == 1 and opens[1].props.nid == "abc0123xyz" and opens[1].props.k == "gift_new" and opens[1].props.first == true, #opens)
check("open row: age", opens[1] and opens[1].props.age >= 119 and opens[1].props.age <= 125, opens[1] and opens[1].props.age)
check("open row: on the player (pid / sid by the engine)", opens[1] and opens[1].target == ALICE)
check("opened called once with nid + u", #openedCalls == 1 and openedCalls[1].nid == "abc0123xyz" and openedCalls[1].u == ALICE)
local bad = rowsNamed("open_bad")
check("open_bad: forged sig", #bad == 1 and bad[1].props.why == "sig" and bad[1].target == BOB)
check("the game's own launch data: no row", #rowsNamed("open") + #rowsNamed("open_bad") == 2)
local opened = requests[1]
check("opened: the ingest headers", opened and opened.Headers.Authorization == "Bearer " .. BACKEND_KEY and opened.Headers["Content-Type"] == "application/json")
check("opened: url without a double slash", opened and opened.Url == "https://b.example.com/v1/notify/opened", opened and opened.Url)

-- onOpen after the join: delivered once, with the token's data.
local delivered = {}
local disconnect = server1:onOpen(function(player, open)
	table.insert(delivered, { player = player, open = open })
end)
task.wait(0.1)
check("onOpen: late callback gets the open", #delivered == 1 and delivered[1].player == alice and delivered[1].open.data == "mail:42" and delivered[1].open.first == true and delivered[1].open.kind == "gift_new")
server1:onOpen(function() end)
task.wait(0.1)
check("onOpen: delivered once", #delivered == 1)
disconnect()

-- want / drop ------------------------------------------------------------------------------------------------------------------
check("want: online player", server1:want(alice, "gift_new", { key = "20034", ["until"] = now + 86400, params = { gift = "5 coins" }, data = "mail:9" }) == true)
check("want: offline UserId", server1:want(424242, "day2") == true)
check("want: refused (until == at)", server1:want(alice, "gift_new", { at = now + 10, ["until"] = now + 10 }) == false)
check("want: refused (bad kind)", server1:want(alice, "Bad Kind") == false and #warnings >= 1)
check("drop", server1:drop(alice, "streak", "20034", "played") == true)
local wants = rowsNamed("want")
check("want rows", #wants == 2)
check("want row: key hashed", wants[1].props.key == "08f2c7a71012" and wants[1].props.k == "gift_new" and wants[1].props.offline == false, wants[1].props.key)
check("want row: offline", wants[2].props.offline == true and wants[2].props.key == nil and wants[2].target == 424242)
local drops = rowsNamed("drop")
check("drop row", #drops == 1 and drops[1].props.key == "08f2c7a71012" and drops[1].props.why == "played")
for _, row in rows do
	local text = serde.encode("json", row.props)
	if text:find("20034", 1, true) or text:find(KEY, 1, true) then
		check("no raw key or HMAC key in rows: " .. row.name, false, text)
	end
end

-- Batching: 250 more wants: one batch of 200 at the next tick, the rest at flushSeconds -------------------------------------------
for index = 1, 250 do
	server1:want(500000 + index, "daily")
end
task.wait(1.5)
check("a full batch goes at once", #intents >= 1 and #intents[1].items == 200, #intents)
local first = intents[1]
check("batch: presence for the three players first", first and first.items[1].op == "presence" and first.items[1].online == true and first.items[3].op == "presence")
check("presence at: unix ms", first and first.items[1].at > 1e12 and math.abs(first.items[1].at - os.time() * 1000) < 60000, first and first.items[1].at)
check("batch: the want as sent", first and first.items[4].op == "want" and first.items[4].key == "20034" and first.items[4].params.gift == "5 coins" and first.items[4].data == "mail:9")
local increasing = true
local lastRev = 0
for _, item in first.items do
	if item.rev then
		if item.rev <= lastRev then
			increasing = false
		end
		lastRev = item.rev
	end
end
check("batch: revs increase", increasing)
check("batch: v1 body", first.v == 1)
local intentsRequest
for _, request in requests do
	if request.Url:find("/v1/notify/intents", 1, true) then
		intentsRequest = request
		break
	end
end
check("intents: key header", intentsRequest and intentsRequest.Headers.Authorization == "Bearer " .. BACKEND_KEY)
local remaining = #persistStore["__typetorch/notify.v1"].queue.items
check("the rest waits for flushSeconds", remaining == 3 + 2 + 2 + 250 - 200 - 1, remaining)

-- A swap in the middle of a request: the batch comes back first in the next generation ------------------------------------------
local hold = true
routes["/v1/notify/intents"] = function(request)
	local body = serde.decode("json", request.Body)
	while hold do
		task.wait(0.05)
	end
	table.insert(intents, body)
	return ok({ ok = true, accepted = #body.items, rejected = {} })
end
task.wait(5)
local store = persistStore["__typetorch/notify.v1"]
check("swap: a request is in flight", #store.queue.inflight > 0, #store.queue.inflight)
local inflightFirst = store.queue.inflight[1]
trove1:clean()
local before = #intents
hold = false
routes["/v1/notify/intents"] = function(request)
	local body = serde.decode("json", request.Body)
	table.insert(intents, body)
	return ok({ ok = true, accepted = #body.items, rejected = {} })
end
local trove2 = Trove.new()
local server2 = NotifyServer.new(nil, trove2)
check("swap: inflight requeued in front", #store.queue.inflight == 0 and store.queue.items[1] == inflightFirst)
task.wait(0.3)
check("swap: no second verify", #rowsNamed("open") == 1 and #rowsNamed("open_bad") == 1 and #openedCalls == 1)
local presences = 0
for _, item in store.queue.items do
	if item.op == "presence" and item.online then
		presences += 1
	end
end
check("swap: no second presence", presences == 0, presences)
local resend = {}
server2:onOpen(function(player)
	table.insert(resend, player)
end)
task.wait(0.1)
check("swap: an open delivered before isn't delivered again", #resend == 0)

-- Presence refresh: every 3 h, `online` again for every player still here; once per round across a swap ------------------------
local function onlinePings(mark)
	local count = 0
	for _, item in store.queue.items do
		if item.op == "presence" and item.online then
			count += 1
		end
	end
	for index = mark + 1, #intents do
		for _, item in intents[index].items do
			if item.op == "presence" and item.online then
				count += 1
			end
		end
	end
	return count
end
local mark = #intents
check("refresh: nothing before 3 h", onlinePings(mark) == 0)
store.presenceRefreshedAt = os.time() - 3 * 3600 - 1
task.wait(1.3)
check("refresh: one online per player here", onlinePings(mark) == 3, onlinePings(mark))
local refreshedAt = store.presenceRefreshedAt
check("refresh: timer reset", refreshedAt >= os.time() - 2)
-- A swap right after the round: the timer is in persist, so the next generation doesn't ping again.
trove2:clean()
local trove2b = Trove.new()
server2 = NotifyServer.new(nil, trove2b)
trove2 = trove2b
task.wait(1.3)
check("refresh: a swap doesn't double-ping", onlinePings(mark) == 3 and store.presenceRefreshedAt == refreshedAt, onlinePings(mark))
store.presenceRefreshedAt = os.time() - 3 * 3600 - 1
task.wait(1.3)
check("refresh: the next round after the swap", onlinePings(mark) == 6, onlinePings(mark))

-- A swap during the opened wait: the next generation writes the open row and fires onOpen, once each -------------------------
local holdOpened = true
routes["/v1/notify/opened"] = function(request)
	while holdOpened do
		task.wait(0.05)
	end
	table.insert(openedCalls, serde.decode("json", request.Body))
	return ok({ state = "first" })
end
local eve = makePlayer(1005, Token.signToken(KEY, "ghi8901rst", "gift_new", 1005, now - 30, "mail:7"))
join(eve)
task.wait(0.5)
local function opensFor(nid)
	local list = {}
	for _, row in rowsNamed("open") do
		if row.props.nid == nid then
			table.insert(list, row)
		end
	end
	return list
end
check("pending: no row while the backend is asked", #opensFor("ghi8901rst") == 0 and store.opens["1005"].pending == true)
trove2:clean()
local trove2c = Trove.new()
server2 = NotifyServer.new(nil, trove2c)
trove2 = trove2c
task.wait(0.3)
check("pending: the next generation writes the row", #opensFor("ghi8901rst") == 1 and opensFor("ghi8901rst")[1].props.first == true and store.opens["1005"].pending == false)
local queuedRetry = false
for _, call in store.queue.opened do
	if call.nid == "ghi8901rst" then
		queuedRetry = true
	end
end
check("pending: the unanswered call is queued for retry", queuedRetry)
local eveOpens = {}
server2:onOpen(function(player, open)
	table.insert(eveOpens, { player = player, open = open })
end)
task.wait(0.1)
holdOpened = false
task.wait(0.3)
check("pending: onOpen once, with the data", #eveOpens == 1 and eveOpens[1].player == eve and eveOpens[1].open.data == "mail:7" and eveOpens[1].open.first == true, #eveOpens)
check("pending: the late answer adds no row", #opensFor("ghi8901rst") == 1)
routes["/v1/notify/opened"] = function(request)
	table.insert(openedCalls, serde.decode("json", request.Body))
	return ok({ state = "first" })
end

-- Leave: played + presence offline ---------------------------------------------------------------------------------------------------
leave(alice)
task.wait(0.1)
local playedRows = rowsNamed("played")
check("played row", #playedRows == 1 and playedRows[1].props.nid == "abc0123xyz" and playedRows[1].props.k == "gift_new" and playedRows[1].props.secs >= 0)
check("played call queued", #store.queue.played == 1 and store.queue.played[1].u == ALICE)
local offline = store.queue.items[#store.queue.items]
check("presence offline", offline.op == "presence" and offline.online == false and offline.u == ALICE and offline.at > 1e12)
leave(carol)
task.wait(0.1)
check("no played for a session that wasn't opened", #rowsNamed("played") == 1)

-- Opt-in rows from a client --------------------------------------------------------------------------------------------------------
local channel = Protocol.CHANNEL
raw[channel](bob, "optin", { name = "optin_check", where = "streak_2", can = true })
raw[channel](bob, "optin", { name = "optin_closed", where = "streak_2", secs = 7 })
raw[channel](bob, "optin", { name = "open", where = "x" })
raw[channel](bob, "optin", { name = "optin_shown", where = "bad where" })
raw[channel](bob, "other", { name = "optin_shown", where = "x" })
for _ = 1, 5 do
	raw[channel](bob, "optin", { name = "optin_shown", where = "streak_2" })
end
check("optin rows", #rowsNamed("optin_check") == 1 and rowsNamed("optin_check")[1].props.can == true and rowsNamed("optin_check")[1].target == bob)
check("optin closed secs", #rowsNamed("optin_closed") == 1 and rowsNamed("optin_closed")[1].props.secs == 7)
check("optin: forged names refused", #rowsNamed("open") == 2 and #rowsNamed("optin_inferred") == 0)
check("optin: capped per session", #rowsNamed("optin_shown") == 3, #rowsNamed("optin_shown"))

-- Flush after the swap: everything left goes, then played -------------------------------------------------------------------------
task.wait(5.5)
local sentItems = 0
for _, body in intents do
	sentItems += #body.items
end
check("all intents sent (the swap's batch twice at most)", #store.queue.items == 0 and sentItems >= 3 + 2 + 2 + 250 - 1 + 2, sentItems)
check("played posted", #played == 1 and played[1].nid == "abc0123xyz" and played[1].u == ALICE and #store.queue.played == 0)

-- Backend down: the open still counts (first = true) and the opened call is retried ----------------------------------------------
routes["/v1/notify/opened"] = function()
	return { Success = false, StatusCode = 503, StatusMessage = "Unavailable", Body = "" }
end
local dave = makePlayer(1004, Token.signToken(KEY, "def4567uvw", "streak", 1004, now - 10, ""))
join(dave)
task.wait(0.5)
local daveOpen = opensFor("def4567uvw")[1]
check("down: open counts as first", daveOpen and daveOpen.props.first == true and daveOpen.props.nid == "def4567uvw")
check("down: opened call queued", #store.queue.opened == 1 and store.queue.opened[1].nid == "def4567uvw")

-- Close: sessions end, the queue goes once ------------------------------------------------------------------------------------------
routes["/v1/notify/opened"] = function(request)
	table.insert(openedCalls, serde.decode("json", request.Body))
	return ok({ state = "first" })
end
for hook in closeHooks do
	hook()
end
local retried = {}
for _, call in openedCalls do
	retried[call.nid] = (retried[call.nid] or 0) + 1
end
check("close: played for dave and eve, opened retried", #played == 3 and #store.queue.opened == 0 and retried["def4567uvw"] == 1 and (retried["ghi8901rst"] or 0) >= 1, #played)
check("close: the queue went", #store.queue.items == 0)

-- No backend: nothing is posted, rows still written ----------------------------------------------------------------------------------
trove2:clean()
settingsMock.current = nil
for key in persistStore do
	persistStore[key] = nil
end
local count = #requests
local trove3 = Trove.new()
local server3 = NotifyServer.new(nil, trove3)
server3:want(77, "daily")
task.wait(1.2)
check("no backend: no request", #requests == count)
check("no backend: row written", rowsNamed("want")[#rowsNamed("want")].target == 77)
check("no backend: no presence (notify not set up)", #persistStore["__typetorch/notify.v1"].queue.items == 1)
trove3:clean()
unregister()

-- The HMAC key and the backend key never reach a warning.
for _, line in warnings do
	if line:find(KEY, 1, true) or line:find(BACKEND_KEY, 1, true) then
		check("no secret in warnings", false, line)
	end
end

print(`notify server: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
process.exit(0)
