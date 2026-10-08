--!nocheck
-- Offline test of the compiled game messaging and server list (out/messaging.luau, out/servers.luau, with
-- out/runtime/relay.luau and out/devtools/roll-call.luau) under Lune, against stub kernels: topic and data rules, the
-- `from` filter, one kernel listener per topic, the relay, "needs kernel 0.3.8" on older kernels, the cloud test no-op,
-- edit-mode loopback, server-only errors, publish errors (too big, bad data, queue full); the shared roll call on kernel
-- 0.3.8 (onRollCall) and before (its own subscription), rows with `pv` and `i`, setServerInfo caps, servers() filters,
-- the cache and its TTL, never `k` or `e`.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-messaging.luau ../framework/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-messaging.luau
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")
local task = require("@lune/task")
local root = process.args[1] or "./"

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end
local function has(text, needle)
	return string.find(tostring(text), needle, 1, true) ~= nil
end

-- Stubs --------------------------------------------------------------------------------------------------------------

local warnings = {}
local attributes = {}
local subscriptions = {} -- topic -> handler (MessagingService)
local publishes = {} -- { topic, data }
local replies = {} -- rows other servers answer a roll call ask with: { j, s }
local players = 3

local function signal()
	local handlers = {}
	return {
		Connect = function(_, fn)
			table.insert(handlers, fn)
			return {
				Disconnect = function()
					local index = table.find(handlers, fn)
					if index then
						table.remove(handlers, index)
					end
				end,
			}
		end,
		Fire = function(_, ...)
			for _, fn in table.clone(handlers) do
				task.spawn(fn, ...)
			end
		end,
	}
end

local services = {
	Workspace = {
		GetAttribute = function(_, name)
			return attributes[name]
		end,
	},
	HttpService = {
		JSONEncode = function(_, value)
			return serde.encode("json", value)
		end,
		JSONDecode = function(_, text)
			return serde.decode("json", text)
		end,
	},
	Players = {
		MaxPlayers = 20,
		GetPlayers = function()
			local list = {}
			for index = 1, players do
				list[index] = index
			end
			return list
		end,
	},
	MessagingService = {
		SubscribeAsync = function(_, topic, fn)
			subscriptions[topic] = fn
			return {
				Disconnect = function()
					if subscriptions[topic] == fn then
						subscriptions[topic] = nil
					end
				end,
			}
		end,
		PublishAsync = function(_, topic, data)
			table.insert(publishes, { topic = topic, data = serde.decode("json", data) })
			if topic == "TypeTorch/rollcall" then
				local ask = serde.decode("json", data)
				for _, reply in replies do
					task.delay(0.05, function()
						local handler = subscriptions[`TypeTorch/rollcall/{ask.j}`]
						if handler then
							handler({ Data = serde.encode("json", { q = ask.q, j = reply.j, s = reply.s }) })
						end
					end)
				end
			end
		end,
	},
}

local Instance = {
	new = function(className)
		assert(className == "BindableEvent", className)
		local event = signal()
		return { Event = event, Fire = function(_, ...) event:Fire(...) end, Destroy = function() end }
	end,
}

local env
local modules = {}
local PATHS = { relay = "out/runtime/relay.luau", ["roll-call"] = "out/devtools/roll-call.luau", messaging = "out/messaging.luau", servers = "out/servers.luau", budget = "out/budget.luau" }
local function loadModule(name)
	if modules[name] then
		return modules[name]
	end
	local source = fs.readFile(root .. PATHS[name])
	modules[name] = luau.load(source, { debugName = name, environment = env })()
	return modules[name]
end
local script = {}
local TS = {
	getModule = function()
		return "services"
	end,
	import = function(_, from, ...)
		if from == "services" then
			return services
		end
		local parts = { ... }
		return loadModule(parts[#parts])
	end,
}
local gameProps = { JobId = "job-self", PlaceVersion = 42, PlaceId = 7 }
env = setmetatable({
	game = setmetatable({}, { __index = gameProps }),
	script = script,
	_G = { [script] = TS },
	Instance = Instance,
	task = task,
	warn = function(...)
		table.insert(warnings, table.concat({ ... }, " "))
	end,
	DateTime = {
		now = function()
			return { UnixTimestampMillis = math.floor(os.time() * 1000) }
		end,
	},
}, { __index = _G })

local Messaging = loadModule("messaging")
local Servers = loadModule("servers")
local RollCallModule = loadModule("roll-call")

local function trove()
	local cleanups = {}
	return {
		add = function(_, value)
			table.insert(cleanups, value)
			return value
		end,
		connect = function(_, event, fn)
			return event:Connect(fn)
		end,
		destroy = function()
			for _, value in cleanups do
				if type(value) == "function" then
					value()
				end
			end
		end,
	}
end

local function meta(fields)
	local value = { channel = "prod", branch = "prod", jobId = "job-other", serverType = "public", placeVersion = 42, sentAt = os.time(), self = false }
	for key, inner in fields or {} do
		value[key] = inner
	end
	return value
end

-- Rules --------------------------------------------------------------------------------------------------------------

check("topic: ok", Messaging.topicProblem("1guard") == nil and Messaging.topicProblem("a.b:c/d_e-f") == nil)
check("topic: empty, reserved, spaces, too long, not a string", Messaging.topicProblem("") ~= nil and has(Messaging.topicProblem("__x"), "reserved") and Messaging.topicProblem("a b") ~= nil and Messaging.topicProblem(string.rep("a", 65)) ~= nil and Messaging.topicProblem(5) ~= nil)
local cycle = {}
cycle.me = cycle
check("json: plain data passes", Messaging.jsonProblem({ kind = "ban", ids = { 1, 2, 3 }, nested = { ok = true, name = "x" } }) == nil and Messaging.jsonProblem(nil) == nil and Messaging.jsonProblem("s") == nil)
check("json: function, NaN, inf, cycle, mixed, holes, metatable, key type", Messaging.jsonProblem(function() end) ~= nil and has(Messaging.jsonProblem(0 / 0), "finite") and Messaging.jsonProblem(math.huge) ~= nil and has(Messaging.jsonProblem(cycle), "itself") and has(Messaging.jsonProblem({ 1, x = 2 }), "mixing") and has(Messaging.jsonProblem({ [1] = 1, [3] = 3 }), "holes") and has(Messaging.jsonProblem(setmetatable({}, {})), "metatable") and has(Messaging.jsonProblem({ [true] = 1 }), "key"))
check("from: default hears prod and this branch, not another dev branch", Messaging.hears(nil, meta(), "dev") and Messaging.hears(nil, meta({ channel = "dev", branch = "dev" }), "dev") and not Messaging.hears(nil, meta({ channel = "dev", branch = "feature" }), "dev"))
check("from: prod / branch / all", not Messaging.hears("prod", meta({ channel = "dev", branch = "dev" }), "dev") and not Messaging.hears("branch", meta(), "dev") and Messaging.hears("all", meta({ channel = "dev", branch = "x" }), "dev"))

-- Edit mode: no kernel, this process only -----------------------------------------------------------------------------

local api = Messaging.messaging
local heard = {}
local stop = api:subscribe("announce", function(data, info)
	table.insert(heard, { data = data, meta = info })
end)
check("edit mode: publish loops back (self, studio)", api:publish("announce", "hi") == true)
task.wait(0.05)
check("edit mode: the listener heard it", heard[1] ~= nil and heard[1].data == "hi" and heard[1].meta.self == true and heard[1].meta.serverType == "studio")
stop()
api:publish("announce", "again")
task.wait(0.05)
check("edit mode: a disconnected listener hears nothing", #heard == 1)
local ok, err = pcall(api.publish, api, "announce", function() end)
check("edit mode: bad data throws with the reason", not ok and has(err, "can't travel as JSON"), err)
check("edit mode: status is undefined", api:status() == nil)

-- Older kernels, a missing module, the client, the cloud test ---------------------------------------------------------

local function bind(kernel, realm, branch)
	local t = trove()
	Messaging.bindMessaging(realm or "server", kernel, t, branch or "prod", kernel.kernelVersion)
	return t
end
bind({ kernelVersion = "0.3.7" })
ok, err = pcall(api.subscribe, api, "announce", function() end)
check("kernel 0.3.7: subscribe throws 'needs kernel 0.3.8'", not ok and has(err, "needs kernel 0.3.8") and has(err, "0.3.7"), err)
ok, err = pcall(api.publish, api, "announce", 1)
check("kernel 0.3.7: publish throws 'needs kernel 0.3.8'", not ok and has(err, "needs kernel 0.3.8"), err)
bind({ kernelVersion = "0.3.8" })
ok, err = pcall(api.publish, api, "announce", 1)
check("kernel 0.3.8 without its Messaging module: says what to map", not ok and has(err, "doesn't map its Messaging module"), err)
bind({ kernelVersion = "0.3.8" }, "client")
ok, err = pcall(api.publish, api, "announce", 1)
check("client: server-only", not ok and has(err, "server-only"), err)
local stubCalls = 0
bind({ kernelVersion = "0.3.8", test = true, messagingPublish = function()
	stubCalls += 1
end })
local before = Messaging.skippedPublishes()
check("cloud test: publish is a no-op (true, nothing reaches the kernel)", api:publish("announce", { a = 1 }) == true and stubCalls == 0 and Messaging.skippedPublishes() == before + 1)
attributes.TypeTorchTest = true
check("cloud test: the place's TypeTorchTest attribute counts too", Messaging.isCloudTest({}) == true)
attributes.TypeTorchTest = nil

-- Kernel 0.3.8 --------------------------------------------------------------------------------------------------------

local kernelListeners = {} -- topic -> { handler, disconnected }
local kernelPublishes = {}
local nextReport = nil
local fake = {
	kernelVersion = "0.3.8",
	messagingSubscribe = function(_, topic, handler)
		local entry = { handler = handler, disconnected = false }
		kernelListeners[topic] = kernelListeners[topic] or {}
		table.insert(kernelListeners[topic], entry)
		return function()
			entry.disconnected = true
		end
	end,
	messagingPublish = function(_, topic, data, options)
		table.insert(kernelPublishes, { topic = topic, data = data, options = options })
		return nextReport or { ok = true, queued = true, size = 120 }
	end,
	messagingStatus = function()
		return { topic = "TypeTorch/game", state = "on" }
	end,
}
local genTrove = bind(fake, "server", "dev")
local got = { a = {}, b = {}, c = {} }
local stopA = api:subscribe("1guard", function(data, info)
	table.insert(got.a, { data = data, meta = info })
end)
local stopB = api:subscribe("1guard", function(data, info)
	table.insert(got.b, { data = data, meta = info })
end, { from = "branch" })
api:subscribe("1guard", function(data)
	table.insert(got.c, data)
end, { from = "all" })
check("0.3.8: one kernel listener per topic, however many callbacks", #kernelListeners["1guard"] == 1)
local kernelHandler = kernelListeners["1guard"][1].handler
kernelHandler({ kind = "ban" }, meta())
kernelHandler({ kind = "dev" }, meta({ channel = "dev", branch = "dev" }))
kernelHandler({ kind = "feature" }, meta({ channel = "dev", branch = "feature" }))
task.wait(0.1)
check("0.3.8: default listener hears prod and this branch (dev), not another dev branch", #got.a == 2 and got.a[1].data.kind == "ban" and got.a[2].data.kind == "dev")
check("0.3.8: from = branch hears only this branch; from = all hears everything", #got.b == 1 and got.b[1].data.kind == "dev" and #got.c == 3)
check("0.3.8: publish passes topic, data and options to the kernel", api:publish("1guard", { kind = "ban", userId = 5 }, { to = "prod" }) == true and kernelPublishes[1].topic == "1guard" and kernelPublishes[1].options.to == "prod")
ok, err = pcall(api.publish, api, "1guard", 1, { to = "everyone" })
check("0.3.8: bad options.to throws", not ok and has(err, "options.to"), err)
nextReport = { ok = false, error = "too_big", size = 1133, limit = 1000, overhead = 118 }
ok, err = pcall(api.publish, api, "1guard", { text = string.rep("x", 1000) })
check("0.3.8: too big throws with the size, the limit and what is left for data", not ok and has(err, "1133 bytes") and has(err, "1000-byte limit") and has(err, "882 bytes"), err)
nextReport = { ok = false, error = "queue_full" }
check("0.3.8: a full queue returns false and warns", api:publish("1guard", 1) == false and has(warnings[#warnings], "queue is full"))
nextReport = nil
check("0.3.8: status() is the kernel's", api:status().state == "on")
stopA()
stopB()
check("0.3.8: the kernel listener stays while a callback remains", kernelListeners["1guard"][1].disconnected == false)
-- The generation stops: a late kernel call (it was already queued) reaches nobody.
Messaging.unbindMessaging()
kernelHandler({ kind = "late" }, meta())
task.wait(0.05)
check("0.3.8: after the generation stopped nothing is delivered", #got.c == 3)
genTrove.destroy()

-- Server list --------------------------------------------------------------------------------------------------------

local persisted = {}
local rollCallHandler = nil
local serverKernel = {
	kernelVersion = "0.3.8",
	serverType = "public",
	branch = "prod",
	channel = "prod",
	artifact = { id = "a1" },
	persist = function(_, key, init)
		persisted[key] = persisted[key] or init()
		return persisted[key]
	end,
	fleetStatus = function()
		return { t = "public", b = "prod", c = "prod", a = "a1", n = players, m = 20, s = os.time() - 100, u = os.time(), p = 7, k = nil, v = "0.3.8", q = 3, g = 1, h = "ok", sv = 2 }
	end,
	onRollCall = function(_, handler)
		rollCallHandler = handler
	end,
}
local serversTrove = trove()
Servers.bindServers(serverKernel, serversTrove, "prod")
task.wait(0.05)
check("servers: kernel 0.3.8 holds the ask topic (onRollCall), the generation doesn't subscribe it", rollCallHandler ~= nil and subscriptions["TypeTorch/rollcall"] == nil)
ok, err = pcall(Servers.setServerInfo, { blob = string.rep("x", 500) })
check("setServerInfo: over 400 bytes throws with the size", not ok and has(err, "400-byte cap"), err)
ok, err = pcall(Servers.setServerInfo, { [1] = "x", y = 2 })
check("setServerInfo: string field names only", not ok, err)
Servers.setServerInfo({ region = "eu", vc = true })
local row = Servers.serverRow()
check("serverRow: fleet status + pv (place version) + i (the game's fields)", row.pv == 42 and row.i.region == "eu" and row.i.vc == true and row.t == "public" and row.h == "ok")
check("setServerInfo: kept in the kernel's persist store (survives swaps)", persisted["__typetorch/serverInfo"].value.region == "eu")
-- Another server asks: this one answers on the asker's reply topic with its row.
rollCallHandler(serde.encode("json", { q = 9, j = "asker-1", t = math.floor(os.time() * 1000) }))
task.wait(1.3)
local answer = nil
for _, entry in publishes do
	if entry.topic == "TypeTorch/rollcall/asker-1" then
		answer = entry.data
	end
end
check("roll call: the ask (through the kernel) is answered with the row (pv, i)", answer ~= nil and answer.q == 9 and answer.j == "job-self" and answer.s.pv == 42 and answer.s.i.region == "eu")
-- servers(): other servers answer this one's ask.
local now = os.time()
replies = {
	{ j = "prod-1", s = { t = "public", b = "prod", c = "prod", n = 5, m = 20, s = now - 50, u = now, pv = 42, i = { region = "us" }, k = "secret-code", e = "some error" } },
	{ j = "dev-same", s = { t = "reserved", b = "prod", c = "dev", n = 1, m = 20, s = now - 10, u = now, pv = 41 } },
	{ j = "dev-other", s = { t = "reserved", b = "feature", c = "dev", n = 2, m = 20, s = now - 10, u = now, pv = 41 } },
	{ j = "broken", s = { t = "public", b = "prod", n = 0, m = 20, s = now - 10, u = now } },
}
local started = os.clock()
local list = Servers.listServers()
local asked = 0
for _, entry in publishes do
	if entry.topic == "TypeTorch/rollcall" then
		asked += 1
	end
end
local byJob = {}
for _, server in list do
	byJob[server.jobId] = server
end
check("servers(): one ask, collected for 3 s", asked == 1 and os.clock() - started >= 2.9)
check("servers(): default = prod servers and this branch's (dev-same), plus this server first; not another dev branch or one running nothing", list[1].here == true and list[1].jobId == "job-self" and byJob["prod-1"] ~= nil and byJob["dev-same"] ~= nil and byJob["dev-other"] == nil and byJob.broken == nil)
local prod1 = byJob["prod-1"]
check("servers(): public fields only (place version, players, type, branch, channel, uptime, info), never k or e", prod1.placeVersion == 42 and prod1.players == 5 and prod1.maxPlayers == 20 and prod1.serverType == "public" and prod1.branch == "prod" and prod1.channel == "prod" and prod1.uptime >= 50 and prod1.info.region == "us" and prod1.k == nil and prod1.e == nil and prod1.accessCode == nil)
check("servers(): sorted here first, then by players", list[2].jobId == "prod-1")
local all = Servers.listServers({ includeDev = true, includeSelf = false })
local allJobs = {}
for _, server in all do
	allJobs[server.jobId] = true
end
check("servers({ includeDev, includeSelf = false }): every server that answered, not this one", allJobs["dev-other"] and allJobs.broken and not allJobs["job-self"])
local asks = 0
for _, entry in publishes do
	if entry.topic == "TypeTorch/rollcall" then
		asks += 1
	end
end
check("servers(): cached (no second ask within the TTL)", asks == 1)
check("servers(): the TTL is clamp(3 s x servers, 30 s, 10 min)", Servers.listSeconds(5) == 30 and Servers.listSeconds(100) == 300 and Servers.listSeconds(1000) == 600)
Servers.setServerInfo(nil)
check("setServerInfo(undefined) clears the fields", Servers.serverRow().i == nil)
Servers.unbindServers()
serversTrove.destroy()

-- An older kernel: the generation subscribes the ask topic itself (same protocol).
local oldKernel = table.clone(serverKernel)
oldKernel.onRollCall = nil
oldKernel.kernelVersion = "0.3.7"
local oldTrove = trove()
Servers.bindServers(oldKernel, oldTrove, "prod")
task.wait(0.1)
check("servers: before 0.3.8 the generation subscribes TypeTorch/rollcall itself", subscriptions["TypeTorch/rollcall"] ~= nil)
Servers.unbindServers()
oldTrove.destroy()
-- The cloud test: nobody is asked; the list is this server alone.
subscriptions["TypeTorch/rollcall"] = nil
local testKernel = table.clone(serverKernel)
testKernel.test = true
local testRollCall = nil
testKernel.onRollCall = function(_, handler)
	testRollCall = handler
end
local testTrove = trove()
Servers.bindServers(testKernel, testTrove, "prod")
local publishedBefore = #publishes
local only = Servers.listServers()
task.wait(0.05)
check("servers: the cloud test doesn't listen or ask: only this server", testRollCall == nil and #publishes == publishedBefore and #only == 1 and only[1].here == true)
Servers.unbindServers()
testTrove.destroy()
check("roll call: REPLIES_PER_MINUTE is 30 (Roblox's newer send limit)", RollCallModule.REPLIES_PER_MINUTE == 30)

print(`{passed} passed, {failed} failed (test-messaging)`)
process.exit(if failed == 0 then 0 else 1)
