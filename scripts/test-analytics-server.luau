--!nocheck
-- The analytics server core (out/analytics/server.luau) end to end under Lune, with mocked services, kernel, persist
-- and network: player ids, joins, client intake (hello, events, experiments, recording chunks), fleet rows, the sink
-- (duckdb body, retry with backoff, refused batches), a hot swap with a request in flight (persist handover, no
-- duplicate joins or deploy reports), leaves and the shutdown flush. Real time: takes about 30 s.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml and template/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-analytics-server.luau ../framework/out/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local task = require("@lune/task")
local base = process.args[1] or "out/"
local Enum = roblox.Enum

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
function Trove:remove(item)
	local index = table.find(self.items, item)
	if index then
		table.remove(self.items, index)
		cleanup(item)
	end
end
function Trove:clean()
	local items = self.items
	self.items = {}
	for index = #items, 1, -1 do
		cleanup(items[index])
	end
end
Trove.destroy = Trove.clean

local PlayersService = { PlayerAdded = Signal(), PlayerRemoving = Signal(), list = {} }
function PlayersService:GetPlayers()
	return table.clone(self.list)
end
-- Friend lists by UserId as pages of UserIds (FriendPages); a string makes GetFriendsAsync error with it.
local friendLists = {}
local friendCalls = { lists = 0, advances = 0 }
local onAdvance = nil
function PlayersService:GetFriendsAsync(userId)
	friendCalls.lists += 1
	local list = friendLists[userId] or { {} }
	if type(list) == "string" then
		error(list)
	end
	local pages = { index = 1, IsFinished = #list <= 1 }
	function pages:GetCurrentPage()
		local entries = {}
		for _, id in list[self.index] do
			table.insert(entries, { Id = id, Username = "user" .. id, AvatarUri = "", AvatarFinal = true, IsOnline = true })
		end
		return entries
	end
	function pages:AdvanceToNextPageAsync()
		friendCalls.advances += 1
		if onAdvance then
			onAdvance()
		end
		self.index += 1
		self.IsFinished = self.index >= #list
	end
	return pages
end

local function makePlayer(userId, name)
	local player = {
		UserId = userId,
		Name = name,
		DisplayName = name,
		Parent = PlayersService,
		AccountAge = 12,
		MembershipType = Enum.MembershipType.None,
		FollowUserId = 0,
	}
	function player:GetJoinData()
		return {}
	end
	function player:GetNetworkPing()
		return 0.1
	end
	return player
end

local guids = 0
local requests = {}
local respond = function()
	return { Success = true, StatusCode = 200, StatusMessage = "OK", Body = "" }
end
local HttpService = {
	GenerateGUID = function()
		guids += 1
		return string.format("%08X-1111-4111-8111-%012X", guids, guids)
	end,
	JSONEncode = function(_, value)
		return serde.encode("json", value)
	end,
	JSONDecode = function(_, text)
		return serde.decode("json", text)
	end,
	RequestAsync = function(_, request)
		table.insert(requests, request)
		return respond(request)
	end,
}

local records = {}
local DataStoreService = {
	GetDataStore = function()
		return {
			GetAsync = function(_, key)
				return records[key], nil
			end,
			UpdateAsync = function(_, key, transform)
				local value = transform(records[key])
				if value ~= nil then
					records[key] = value
				end
				return value
			end,
		}
	end,
	GetRequestBudgetForRequestType = function()
		return 100
	end,
}

local services = {
	HttpService = HttpService,
	Players = PlayersService,
	DataStoreService = DataStoreService,
	LocalizationService = {
		GetCountryRegionForPlayerAsync = function()
			return "US"
		end,
	},
	CollectionService = {
		GetInstanceAddedSignal = function()
			return Signal()
		end,
		GetInstanceRemovedSignal = function()
			return Signal()
		end,
		GetTagged = function()
			return {}
		end,
	},
	ConfigService = {},
	RunService = { Heartbeat = Signal() },
	Stats = {
		GetTotalMemoryUsageMb = function()
			return 512
		end,
	},
	Workspace = {
		GetRealPhysicsFPS = function()
			return 60
		end,
	},
}

local kernelPersist = {}
local swapOutListeners = {}
local closeHooks = {}
local TypeTorch = {
	artifact = { id = "art1", seq = 7 },
	serverType = "public",
	branch = "main",
	channel = "prod",
	generation = 1,
	kernelVersion = "0.3.2",
	startInfo = { kind = "boot", reason = "boot", branchChanged = false, startedAt = os.time() },
}
function TypeTorch:persist(key, init)
	if kernelPersist[key] == nil then
		kernelPersist[key] = init()
	end
	return kernelPersist[key]
end
function TypeTorch:onLog()
	return function() end
end
function TypeTorch:onSwapOut(fn)
	swapOutListeners[fn] = true
	return function()
		swapOutListeners[fn] = nil
	end
end

local sent = {}
local raw = {}
local dispatcher = {
	kernel = {
		send = function(_, player, channel, ...)
			table.insert(sent, { player = player, channel = channel, args = { ... } })
		end,
	},
}
function dispatcher:setRaw(channel, fn)
	raw[channel] = fn
end
function dispatcher:removeRaw(channel)
	raw[channel] = nil
end

local reports = {
	{ s = 11, b = "main", a = "art1", j = "job-1", r = "swapped", t = 1, g = 1, k = "0.3.2", p = 3 },
	{ s = 12, b = "main", a = "art2", j = "job-1", r = "booted", t = 2, g = 1, k = "0.3.2", p = 3 },
}
local kernel = {
	fleetStatus = function()
		return { t = os.time(), b = "main", h = "ok", n = #PlayersService.list, sv = 1 }
	end,
	onDeployReport = function(_, callback)
		for _, report in reports do
			callback(report)
		end
		return function() end
	end,
}

-- 0.3.8: the signed settings (src/settings.ts) as the kernel would hand them over; off unless a check turns it on.
local settingsMock = { supported = false, current = nil, listeners = {} }
local internals = {
	settings = {
		settingsSupported = function()
			return settingsMock.supported
		end,
		currentSettings = function()
			return settingsMock.current
		end,
		onSettings = function(fn)
			table.insert(settingsMock.listeners, fn)
			return function()
				local index = table.find(settingsMock.listeners, fn)
				if index then
					table.remove(settingsMock.listeners, index)
				end
			end
		end,
	},
	["net/runtime"] = {
		maybeServerDispatcher = function()
			return dispatcher
		end,
	},
	players = {
		observePlayers = function(trove, callback)
			trove:connect(PlayersService.PlayerAdded, function(player)
				callback(player, Trove.new())
			end)
			for _, player in PlayersService.list do
				task.spawn(callback, player, Trove.new())
			end
		end,
	},
	typetorch = {
		TypeTorch = TypeTorch,
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
}

local warnings = {}
local outFolder = { Name = "out" }
local analyticsFolder = { Name = "analytics", Parent = outFolder }
local G = {}
local loaded = {}
local TS = {}
function TS.getModule(_, scope, name)
	return { external = scope .. "/" .. name }
end
local loadAnalytics
function TS.import(_, parent, ...)
	local path = table.concat({ ... }, "/")
	if type(parent) == "table" and parent.external then
		assert(parent.external == "@rbxts/services", "unexpected package " .. parent.external)
		return services
	end
	if parent == analyticsFolder then
		return loadAnalytics(path)
	end
	if parent == outFolder then
		return assert(internals[path], "no mock for " .. path)
	end
	error("unexpected import " .. path)
end
local clockBase = os.time() * 1000
function loadAnalytics(name)
	if loaded[name] then
		return loaded[name]
	end
	local script = { Name = name, Parent = analyticsFolder }
	G[script] = TS
	local environment = setmetatable({
		script = script,
		_G = G,
		task = task,
		Enum = Enum,
		game = { JobId = "job-1", PlaceId = 123, GameId = 456, BindToClose = function() end },
		DateTime = {
			now = function()
				return { UnixTimestampMillis = clockBase + math.floor(os.clock() * 1000) }
			end,
		},
		warn = function(...)
			table.insert(warnings, table.concat({ ... }, " "))
		end,
	}, { __index = _G })
	local value = luau.load(fs.readFile(base .. "analytics/" .. name .. ".luau"), { debugName = name, environment = environment })()
	loaded[name] = value
	return value
end

local nowMs = function()
	return clockBase + math.floor(os.clock() * 1000)
end
local ServerAnalytics = loadAnalytics("server").ServerAnalytics
local E = loadAnalytics("experiments")
local C = loadAnalytics("codec")
local store = function()
	return kernelPersist["__typetorch/analytics.v1"]
end
local function rowsNamed(rows, kind, name)
	local found = {}
	for _, row in rows do
		if row.kind == kind and (name == nil or row.name == name) then
			table.insert(found, row)
		end
	end
	return found
end
local function allEvents()
	local list = table.clone(store().events.rows)
	for _, row in store().fleet.rows do
		table.insert(list, row)
	end
	return list
end
--- Rows of `kind`/`name` in the queue and in every request body sent so far.
local function everywhere(kind, name)
	local found = rowsNamed(store().events.rows, kind, name)
	for _, sentRequest in requests do
		local ok, decoded = pcall(serde.decode, "json", sentRequest.Body)
		if ok and decoded.events then
			for _, row in rowsNamed(decoded.events, kind, name) do
				table.insert(found, row)
			end
		end
	end
	return found
end
local function hiFor(player)
	local last
	for _, message in sent do
		if message.player == player and message.args[1] == "hi" then
			last = message.args[2]
		end
	end
	return last
end

-- Generation 1 -------------------------------------------------------------------------------------------------------

records["p/2"] = { pid = "existingpid00000000000000000002", first = os.time() - 10 * 86400, last = os.time() - 3 * 86400 }
local newbie = makePlayer(1, "NewbieName")
local regular = makePlayer(2, "RegularName")
PlayersService.list = { newbie, regular }
-- The newbie's friend list holds the regular on page 2 (of 3); the regular's holds the newbie on page 11 (of 12),
-- past the 10-page cap.
friendLists[1] = { { 90, 91 }, { 92, 2 }, { 93 } }
friendLists[2] = {}
for page = 1, 12 do
	friendLists[2][page] = if page == 11 then { 1 } else { 200 + page }
end

local options = {
	settings = { backend = "duckdb", events = "https://a.example.com/ingest", token = "TKN-secret", flushSeconds = 5 },
	zones = false,
}
local trove1 = Trove.new()
local core1 = ServerAnalytics.new(options, { trove = trove1, server = kernel }, trove1)
task.wait(0.2)

check("new player: record created", records["p/1"] ~= nil and #records["p/1"].pid == 32, records["p/1"] and records["p/1"].pid)
local newbiePid = records["p/1"].pid
check("pid is not the UserId", not string.find(newbiePid, "^1$"))
check("returning player keeps pid", records["p/2"].pid == "existingpid00000000000000000002")

raw["__tt/an"](newbie, "hello", { dev = "phone", input = "touch", w = 390, h = 844, touch = true, load = 2.5 })
raw["__tt/an"](regular, "hello", { dev = "desktop", input = "kbm", w = 1920, h = 1080, kb = true, mouse = true })
local hiNew = hiFor(newbie)
local hiReg = hiFor(regular)
check("hi: new player", hiNew ~= nil and hiNew.pid == newbiePid and hiNew.newp == true and hiNew.rec == true, hiNew and hiNew.pid)
check("hi: returning player", hiReg ~= nil and hiReg.newp == false and hiReg.rec == false)
check("hi: tech interval", hiNew.tech == 60)
task.wait(0.6) -- joins wait for the device

local joins = rowsNamed(store().events.rows, "session", "join")
check("two joins", #joins == 2, #joins)
local joinNew, joinReg
for _, row in joins do
	if row.pid == newbiePid then
		joinNew = row
	else
		joinReg = row
	end
end
local joinNewProps = joinNew and serde.decode("json", joinNew.props)
local joinRegProps = joinReg and serde.decode("json", joinReg.props)
check("join: new player props", joinNewProps and joinNewProps.from == "direct" and joinNewProps.ret == -1 and joinNewProps.age == "7-30d" and joinNewProps.country == "US" and joinNewProps.prem == false)
check("join: returning ret = 3 days", joinRegProps and joinRegProps.ret == 3, joinRegProps and joinRegProps.ret)
check("join: newp", joinNew.newp == true and joinReg.newp == false)
check("join: device stamped", joinNew.dev == "phone" and joinReg.dev == "desktop")
check("join: identity", joinNew.art == "art1" and joinNew.seq == 7 and joinNew.job == "job-1" and joinNew.place == 123 and joinNew.srv == "public" and joinNew.channel == "prod")
check("join: sid", #joinNew.sid == 32 and joinNew.sid ~= joinReg.sid)
-- friends: one GetFriendsAsync per join, intersected with the players here.
check("join: friends found on page 2", joinNewProps and joinNewProps.friends == 1, joinNewProps and joinNewProps.friends)
check("join: friends past the 10-page cap not seen", joinRegProps and joinRegProps.friends == 0, joinRegProps and joinRegProps.friends)
check("friends: one lookup per join", friendCalls.lists == 2, friendCalls.lists)
check("friends: paging stops when all are found, and at 10 pages", friendCalls.advances == 1 + 9, friendCalls.advances)
local third = makePlayer(3, "ThirdName")
friendLists[3] = "HTTP 500"
check("friends: a failed lookup counts 0", core1:friendsHere(third) == 0)
local listsBefore = friendCalls.lists
PlayersService.list = { third }
check("friends: alone, no lookup", core1:friendsHere(third) == 0 and friendCalls.lists == listsBefore)
PlayersService.list = { newbie, regular }
friendLists[3] = { { 1 }, { 2 } }
onAdvance = function()
	third.Parent = nil -- leaves while the next page loads
end
check("friends: the player leaving mid-lookup keeps the count so far", core1:friendsHere(third) == 1)
onAdvance = nil
local device = rowsNamed(store().events.rows, "session", "device")
check("device rows from the client", #device == 2 and device[1].src == "client")
check("load row", #rowsNamed(store().events.rows, "tech", "load") == 1)

core1:track(newbie, "custom", "quest_done", { quest = "tutorial" })
core1:track(nil, "custom", "server_thing", nil)
core1:setActivity(nil, "round")
local variant = core1:experiment(newbie, "onboarding", { "short", "long" })
check("experiment = assignVariant", variant == E.assignVariant(newbiePid, "onboarding", { "short", "long" }).variant, variant)
core1:track(newbie, "custom", "after_exp", nil)
local rows = store().events.rows
local quest = rowsNamed(rows, "custom", "quest_done")[1]
check("track: row", quest and quest.pid == newbiePid and quest.props == '{"quest":"tutorial"}' and quest.src == "server")
local serverThing = rowsNamed(rows, "custom", "server_thing")[1]
check("server-only event", serverThing and serverThing.pid == "" and serverThing.sid == "" and serverThing.dev == "unknown" and serverThing.props == "{}")
check("activity rows per player", #rowsNamed(rows, "state", "activity") == 2)
local afterExp = rowsNamed(rows, "custom", "after_exp")[1]
check("exp stamped", afterExp and serde.decode("json", afterExp.exp).onboarding == variant, afterExp and afterExp.exp)
check("state stamped", afterExp and afterExp.state == "activity:round", afterExp and afterExp.state)
check("experiment row", #rowsNamed(rows, "experiment", "onboarding") == 1)
core1:experiment(newbie, "onboarding", { "short", "long" })
check("experiment row once", #rowsNamed(store().events.rows, "experiment", "onboarding") == 1)

-- Client events: valid, server-only kinds (session, purchase, currency), bad JSON, a screen change.
raw["__tt/an"](newbie, "ev", {
	{ 100, "custom", "opened_map", "{}" },
	{ 50, "state", "screen", '{"to":"Shop","from":""}' },
	{ 10, "session", "join", "{}" },
	{ 10, "custom", "bad", "{not json" },
	{ 8, "purchase", "product", '{"product":1234,"robux":9999}' },
	{ 7, "currency", "coins", '{"delta":100000,"reason":"free"}' },
	{ 5, "custom", "after_screen", '{"a":1}' },
})
rows = store().events.rows
local opened = rowsNamed(rows, "custom", "opened_map")[1]
check("client event", opened and opened.src == "client" and opened.pid == newbiePid)
check("client time corrected", opened and math.abs(opened.t - (nowMs() - 100 - 50)) < 200, opened and (nowMs() - opened.t))
check("client session kind refused", #rowsNamed(rows, "session", "join") == 2)
check("client bad json refused", #rowsNamed(rows, "custom", "bad") == 0)
check("client purchase and currency refused", #rowsNamed(rows, "purchase") == 0 and #rowsNamed(rows, "currency") == 0)
local afterScreen = rowsNamed(rows, "custom", "after_screen")[1]
check("screen in state", afterScreen and afterScreen.state == "screen:Shop|activity:round", afterScreen and afterScreen.state)
check("screen row", #rowsNamed(rows, "state", "screen") == 1)

-- Rate limit: a burst of 120, then about 2 a second.
local flood = {}
for index = 1, 50 do
	flood[index] = { 0, "custom", "flood", "{}" }
end
for _ = 1, 4 do
	raw["__tt/an"](regular, "ev", flood)
end
local floods = #rowsNamed(store().events.rows, "custom", "flood")
check("client rate limit", floods >= 120 and floods <= 122, floods)
raw["__tt/an"](regular, "ev", table.create(51, { 0, "custom", "too_many", "{}" }))
check("batch over 50 refused", #rowsNamed(store().events.rows, "custom", "too_many") == 0)

-- Recording chunks (new player only).
local writer = C.RecWriter.new(100)
writer:sample(0, 1, 2, 3, 0, 4, 5, 6, 0, 0)
writer:event(10, 1, "Shop/Buy")
local chunk0 = writer:finish(false)
raw["__tt/an"](newbie, "rec", 0, 1000, writer.samples, chunk0, false, "")
raw["__tt/an"](newbie, "rec", 0, 1000, 1, chunk0, false, "") -- a resend
raw["__tt/an"](regular, "rec", 0, 1000, 1, chunk0, false, "") -- not recorded
raw["__tt/an"](newbie, "rec", 1, 500, 0, C.RecWriter.new(100):finish(true), true, "window")
raw["__tt/an"](newbie, "rec", 2, 500, 0, buffer.fromstring("\9\0\0\0"), false, "") -- after the end
local recs = store().recordings.rows
check("recordings: 2 chunks", #recs == 2, #recs)
check("recording row", recs[1].pid == newbiePid and recs[1].chunk == 0 and recs[1].codec == "tt-rec-1" and recs[1].n == 1 and recs[1].art == "art1")
check("recording data", buffer.tostring(C.fromBase64(recs[1].data)) == buffer.tostring(chunk0))
check("recording t", math.abs(recs[1].t - (nowMs() - 1000 - 50)) < 200)
local metaEnd = rowsNamed(store().events.rows, "recording_meta", "end")[1]
check("recording_meta start + end", #rowsNamed(store().events.rows, "recording_meta", "start") == 1 and metaEnd and serde.decode("json", metaEnd.props).why == "window")

-- Fleet rows: a heartbeat at start, the replayed reports once each.
check("fleet heartbeat", #rowsNamed(store().fleet.rows, "fleet", "heartbeat") == 1)
check("fleet deploy reports", #rowsNamed(store().fleet.rows, "fleet", "deploy_report") == 2)
check("fleet row shape", store().fleet.rows[1].pid == "" and store().fleet.rows[1].src == "server" and serde.decode("json", store().fleet.rows[1].props).h == "ok")

-- Sink: a 503, then a retry that succeeds ------------------------------------------------------------------------------
local queuedBefore = #store().events.rows
respond = function()
	return { Success = false, StatusCode = 503, StatusMessage = "Service Unavailable", Body = "" }
end
core1:flushSoon()
task.wait(1.5)
check("one request", #requests == 1, #requests)
local request = requests[1]
check("duckdb request", request.Url == "https://a.example.com/ingest" and request.Method == "POST" and request.Compress == Enum.HttpCompression.Gzip)
check("bearer token", request.Headers.Authorization == "Bearer TKN-secret" and request.Headers["Content-Type"] == "application/json")
local body = serde.decode("json", request.Body)
check("body: fleet rows first", body.events[1].kind == "fleet")
check("body: events and recordings", #body.events == queuedBefore + 3 and #body.recordings == 2, #body.events)
-- One identity row per session with a known pid (pid -> UserId), in its own array, never among the events.
local identityOk = body.identities ~= nil and #body.identities >= 1
for _, who in body.identities or {} do
	if typeof(who.uid) ~= "number" or who.uid <= 0 or typeof(who.pid) ~= "string" or #who.pid < 8 then
		identityOk = false
	end
end
check("body: identities", identityOk, body.identities and #body.identities)
local identityInEvents = false
for _, event in body.events do
	if event.uid ~= nil then
		identityInEvents = true
	end
end
check("identities never in events", not identityInEvents)
check("503: rows back in the queue", #store().events.rows == queuedBefore and #store().fleet.rows == 3 and #store().recordings.rows == 2)
check("503: identities back too", #store().identities == #body.identities and #store().inflightIdentities == 0)
check("503: failure counted", store().failures == 1 and #store().inflightEvents == 0)
local tokenLeaked = false
for _, line in warnings do
	if string.find(line, "TKN", 1, true) then
		tokenLeaked = true
	end
end
check("warned without the token", #warnings > 0 and not tokenLeaked, warnings[1])
respond = function()
	return { Success = true, StatusCode = 200, StatusMessage = "OK", Body = "" }
end
task.wait(7.5) -- backoff 3.75-6.25 s
check("retry sent", #requests == 2, #requests)
check("queue empty after 200", #store().events.rows == 0 and #store().fleet.rows == 0 and #store().recordings.rows == 0 and #store().identities == 0)
check("sent counted", store().sent == queuedBefore + 3 + 2 and store().failures == 0, store().sent)
check("no token in rows", not string.find(requests[2].Body, "TKN", 1, true))

-- A refused batch is dropped.
core1:track(newbie, "custom", "refused_one", nil)
respond = function()
	return { Success = false, StatusCode = 400, StatusMessage = "Bad Request", Body = "" }
end
core1:flushSoon()
task.wait(1.5)
check("400: dropped", #store().events.rows == 0 and store().rejected >= 1, store().rejected)

-- Hot swap with a request in flight ------------------------------------------------------------------------------------
core1:track(newbie, "custom", "in_flight", nil)
respond = function()
	task.wait(1000) -- never answers
end
core1:flushSoon()
task.wait(1.5)
check("in flight: kept in persist", #store().inflightEvents == 1 and store().inflightEvents[1].name == "in_flight")
for listener in swapOutListeners do
	listener({ reason = "deploy", next = { id = "art2" } })
end
swapOutListeners = {}
trove1:clean()
check("swap_out row", #rowsNamed(store().events.rows, "tech", "swap_out") == 1)
core1:track(newbie, "custom", "after_stop", nil)
check("a stopped core emits nothing", #rowsNamed(store().events.rows, "custom", "after_stop") == 0)

respond = function()
	return { Success = true, StatusCode = 200, StatusMessage = "OK", Body = "" }
end
TypeTorch.generation = 2
TypeTorch.artifact = { id = "art2", seq = 8 }
TypeTorch.startInfo = { kind = "swap", reason = "deploy", branchChanged = false, startedAt = os.time(), previous = { artifact = { id = "art1" }, generation = 1 }, loadSeconds = 0.4 }
local trove2 = Trove.new()
local core2 = ServerAnalytics.new(options, { trove = trove2, server = kernel }, trove2)
task.wait(0.3)
check("handover: in-flight rows requeued", #rowsNamed(store().events.rows, "custom", "in_flight") == 1 and #store().inflightEvents == 0)
check("handover: no second join", #rowsNamed(store().events.rows, "session", "join") == 0)
check("handover: deploy reports not repeated", #rowsNamed(store().fleet.rows, "fleet", "deploy_report") == 0)
check("handover: heartbeat at start", #rowsNamed(store().fleet.rows, "fleet", "heartbeat") == 1)
raw["__tt/an"](newbie, "hello", { dev = "phone", input = "touch" })
local hiAgain = hiFor(newbie)
check("handover: same pid, still recording flag off after end", hiAgain.pid == newbiePid and hiAgain.rec == false)
core2:track(newbie, "custom", "gen2_event", nil)
local gen2 = rowsNamed(store().events.rows, "custom", "gen2_event")[1]
check("gen 2 rows: new artifact, same session", gen2 and gen2.art == "art2" and gen2.seq == 8 and gen2.sid == joinNew.sid and gen2.newp == true)
check("gen 2 rows: experiment kept", gen2 and serde.decode("json", gen2.exp).onboarding == variant)
task.wait(5.2)
local swap = everywhere("tech", "swap")[1]
check("swap row", swap and serde.decode("json", swap.props).from == "art1" and serde.decode("json", swap.props).reason == "deploy")

-- Leave and shutdown ---------------------------------------------------------------------------------------------------
local before = records["p/2"].last
table.remove(PlayersService.list, table.find(PlayersService.list, regular))
PlayersService.PlayerRemoving:Fire(regular)
task.wait(0.2)
local leave = rowsNamed(store().events.rows, "session", "leave")[1]
local leaveProps = leave and serde.decode("json", leave.props)
check("leave row", leave and leave.pid == "existingpid00000000000000000002" and leaveProps.why == "left" and leaveProps.swap60 == true)
check("leave writes last", records["p/2"].last >= before and records["p/2"].pid == "existingpid00000000000000000002")
check("session removed", store().players["2"] == nil)

local requestsBefore = #requests
for hook in closeHooks do
	if hook then
		task.spawn(hook)
	end
end
task.wait(1)
local shutdownBody = requests[#requests] and serde.decode("json", requests[#requests].Body)
local shutdownLeave = false
for _, row in (shutdownBody and shutdownBody.events) or {} do
	if row.kind == "session" and row.name == "leave" and serde.decode("json", row.props).why == "shutdown" then
		shutdownLeave = true
	end
end
check("shutdown flush", #requests > requestsBefore and #store().events.rows == 0, #requests - requestsBefore)
check("shutdown leave sent", shutdownLeave)
check("shutdown writes last", records["p/1"].pid == newbiePid and records["p/1"].last ~= nil)
trove2:clean()

-- 0.3.8 (plans/20): without options.settings the sink comes from the signed settings record (`analytics`, `fleet`),
-- live through the kernel's change hook; on an older kernel there is none, with one warning.
do
	local troveOld = Trove.new()
	local warnedBefore = #warnings
	local coreOld = ServerAnalytics.new({ zones = false }, { trove = troveOld, server = kernel }, troveOld)
	task.wait(0.1)
	local said = false
	for index = warnedBefore + 1, #warnings do
		said = said or string.find(warnings[index], "no sink settings", 1, true) ~= nil
	end
	check("settings: an older kernel: no sink settings, one warning", coreOld.settings == nil and said)
	troveOld:clean()
	settingsMock.supported = true
	settingsMock.current = { seq = 1, at = "2026-10-06T12:00:00.000Z", analytics = { backend = "duckdb", events = "https://s.example.com/ingest", token = "TKN-settings", flushSeconds = 5 } }
	local troveNew = Trove.new()
	local coreNew = ServerAnalytics.new({ zones = false }, { trove = troveNew, server = kernel }, troveNew)
	task.wait(0.1)
	check("settings: kernel 0.3.8: the sink comes from the signed settings", coreNew.settings ~= nil and coreNew.settings.events == "https://s.example.com/ingest")
	for _, listener in table.clone(settingsMock.listeners) do
		listener({ seq = 2, at = "2026-10-06T12:01:00.000Z", analytics = { backend = "duckdb", events = "https://t.example.com/ingest", token = "TKN-settings-2", flushSeconds = 5 }, fleet = { url = "https://fleet.example.com", token = "F" } })
	end
	task.wait(0.05)
	check("settings: a new copy applies live (and the fleet value comes with it)", coreNew.settings.events == "https://t.example.com/ingest" and coreNew.fleetSettings ~= nil and coreNew.fleetSettings.url == "https://fleet.example.com")
	troveNew:clean()
	check("settings: the engine's listener goes with its trove", #settingsMock.listeners == 0)
end

print(`analytics server: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
process.exit(0)
