--!nocheck
-- The Flamework networking compatibility layer (createFlameworkCompat, plans/19 item 5), end to end under Lune:
--   - the four handlers and GlobalEvents/GlobalFunctions:createServer/createClient; namespaces shared by both event
--     trees merge; an event and a function with the same path, or a path another network declared, are refused;
--   - server: connect (one thread per call, guards first, Disconnect, troves, errors warned and counted), predict,
--     fire(player | players), the call shorthand, except, broadcast; setCallback with plain values, Promises
--     (resolved / rejected) and errors; function predict;
--   - a swap: the old generation's handlers fail clearly, the new generation's listeners are the only ones that run;
--   - client: fire and the call shorthand, connect, predict (no traffic), invoke and the call shorthand,
--     invokeWithTimeout (seconds), createClient({ defaultTimeout }) and a leaf's own timeout.
-- It runs the real startServer/startClient of out/ with real RuntimeLib, Promise, trove and t (the harness of
-- test-modules.luau) and drives each generation's dispatcher with the messages the kernel would deliver.
--
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml and template/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-flamework-compat.luau ../framework/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-flamework-compat.luau
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local realTask = require("@lune/task")

local root = process.args[1] or "./"
if string.sub(root, -1) ~= "/" and string.sub(root, -1) ~= "\\" then
	root ..= "/"
end

local passed, failed = 0, 0
local function check(label: string, condition: any, detail: any?)
	if condition then
		passed += 1
	else
		failed += 1
		print(`FAIL  {label}{if detail ~= nil then ": " .. tostring(detail) else ""}`)
	end
end
local function has(text: any, part: string): boolean
	return type(text) == "string" and string.find(text, part, 1, true) ~= nil
end

-- Errors raised in threads the framework spawns (onStart, callbacks) and warnings, recorded instead of printed -------

local threadErrors = {}
local warnings = {}
local function guarded(fn)
	return function(...)
		local ok, err = pcall(fn, ...)
		if not ok then
			table.insert(threadErrors, tostring(err))
		end
	end
end
local task = table.clone(realTask)
task.spawn = function(fn, ...)
	if type(fn) == "thread" then
		return realTask.spawn(fn, ...)
	end
	return realTask.spawn(guarded(fn), ...)
end
task.defer = function(fn, ...)
	if type(fn) == "thread" then
		return realTask.defer(fn, ...)
	end
	return realTask.defer(guarded(fn), ...)
end
task.delay = function(seconds, fn, ...)
	if type(fn) == "thread" then
		return realTask.delay(seconds, fn, ...)
	end
	return realTask.delay(seconds, guarded(fn), ...)
end

-- Tree emulator (the payload layout: include/RuntimeLib, include/node_modules/@rbxts|@typetorch, Server/...) ---------

local Node = {}
local nodeMeta = {}
local inner = setmetatable({}, { __mode = "k" })

nodeMeta.__index = function(self, key)
	local data = inner[self]
	if Node[key] then
		return Node[key]
	end
	if key == "ClassName" or key == "Name" or key == "Parent" or key == "Source" then
		return data[key]
	end
	for _, child in data.children do
		if inner[child].Name == key then
			return child
		end
	end
	error(`{key} is not a valid member of {data.ClassName} "{Node.GetFullName(self)}"`, 2)
end
nodeMeta.__tostring = function(self)
	return inner[self].Name
end

function Node.FindFirstChild(self, name: string)
	for _, child in inner[self].children do
		if inner[child].Name == name then
			return child
		end
	end
	return nil
end
function Node.WaitForChild(self, name: string)
	return Node.FindFirstChild(self, name) or error(`Infinite yield on {Node.GetFullName(self)}:WaitForChild("{name}")`, 2)
end
function Node.GetChildren(self)
	return table.clone(inner[self].children)
end
function Node.GetDescendants(self)
	local list = {}
	local function walk(node)
		for _, child in inner[node].children do
			table.insert(list, child)
			walk(child)
		end
	end
	walk(self)
	return list
end
function Node.IsA(self, className: string)
	return className == "Instance" or inner[self].ClassName == className
end
function Node.GetFullName(self)
	local parts = {}
	local node = self
	while node do
		table.insert(parts, 1, inner[node].Name)
		node = inner[node].Parent
	end
	return table.concat(parts, ".")
end
function Node.FindFirstAncestorWhichIsA(self, className: string)
	local node = inner[self].Parent
	while node do
		if Node.IsA(node, className) then
			return node
		end
		node = inner[node].Parent
	end
	return nil
end
function Node.GetAttribute()
	return nil
end

local function newNode(className: string, name: string, parent, source: string?, loader: any?)
	local node = setmetatable({}, nodeMeta)
	inner[node] = { ClassName = className, Name = name, Parent = parent, Source = source, loader = loader, children = {} }
	if parent then
		table.insert(inner[parent].children, node)
	end
	return node
end

local sources = {}
local function read(path: string): string
	sources[path] = sources[path] or fs.readFile(path)
	return sources[path]
end

--- A directory as roblox-ts/Rojo map it: a folder with init.lua(u) is that ModuleScript; .lua(u) files are modules.
local function mountDir(dir: string, name: string, parent)
	local initFile = nil
	for _, candidate in { "init.luau", "init.lua" } do
		if fs.isFile(`{dir}/{candidate}`) then
			initFile = candidate
		end
	end
	local node = newNode(if initFile then "ModuleScript" else "Folder", name, parent, if initFile then read(`{dir}/{initFile}`) else nil)
	for _, entry in fs.readDir(dir) do
		local full = `{dir}/{entry}`
		if fs.isDir(full) then
			mountDir(full, entry, node)
		elseif entry ~= initFile then
			local base = string.match(entry, "^(.-)%.luau?$")
			if base then
				newNode("ModuleScript", base, node, read(full))
			end
		end
	end
	return node
end

-- Mocks ----------------------------------------------------------------------------------------------------------------

local function Signal(name: string)
	local handlers = {}
	local signal = { _name = name }
	function signal:Connect(fn)
		local connection = { Connected = true }
		handlers[connection] = fn
		function connection:Disconnect()
			handlers[connection] = nil
			connection.Connected = false
		end
		return connection
	end
	function signal:Once(fn)
		local connection
		connection = signal:Connect(function(...)
			connection:Disconnect()
			fn(...)
		end)
		return connection
	end
	function signal:Wait() end
	function signal:Fire(...)
		for connection, fn in table.clone(handlers) do
			if connection.Connected then
				task.spawn(fn, ...)
			end
		end
	end
	function signal:count()
		local n = 0
		for _ in handlers do
			n += 1
		end
		return n
	end
	return signal
end

local function inert(name: string)
	return setmetatable({}, {
		__index = function(_, key)
			return inert(`{name}.{tostring(key)}`)
		end,
		__newindex = function() end,
		__call = function()
			return inert(`{name}()`)
		end,
		__tostring = function()
			return name
		end,
		__len = function()
			return 0
		end,
		__iter = function()
			return next, {}
		end,
	})
end
local function inertClass(name: string)
	return {
		new = function()
			return inert(`{name}.new()`)
		end,
	}
end

local currentRealm = "server"
local Players = { Name = "Players", PlayerAdded = Signal("PlayerAdded"), PlayerRemoving = Signal("PlayerRemoving"), list = {} }
function Players:GetPlayers()
	return table.clone(self.list)
end

local RunService = setmetatable({
	IsServer = function()
		return currentRealm == "server"
	end,
	IsClient = function()
		return currentRealm == "client"
	end,
	IsStudio = function()
		return false
	end,
	IsRunning = function()
		return true
	end,
	IsEdit = function()
		return false
	end,
	Heartbeat = Signal("Heartbeat"),
	Stepped = Signal("Stepped"),
	PreSimulation = Signal("PreSimulation"),
	RenderStepped = Signal("RenderStepped"),
}, {
	__index = function(_, key)
		return inert(`RunService.{key}`)
	end,
})

local services = { Players = Players, RunService = RunService, LogService = { MessageOut = Signal("MessageOut") } }
setmetatable(services, {
	__index = function(self, key)
		local value = inert(key)
		rawset(self, key, value)
		return value
	end,
})
local game = setmetatable({
	GetService = function(_, name: string)
		return services[name]
	end,
	IsLoaded = function()
		return true
	end,
	Loaded = Signal("Loaded"),
	JobId = "job-test",
	PlaceId = 1,
}, {
	__index = function(_, key)
		return inert(`game.{key}`)
	end,
})

local nextUserId = 100
local function newCharacter(name: string)
	local character = { Name = name, Parent = "Workspace", AncestryChanged = Signal(`{name}.AncestryChanged`) }
	function character:IsDescendantOf()
		return self.Parent ~= nil
	end
	return character
end
local function newPlayer(name: string, character: boolean?)
	nextUserId += 1
	local player = {
		Name = name,
		UserId = nextUserId,
		Parent = Players,
		CharacterAdded = Signal(`{name}.CharacterAdded`),
		CharacterRemoving = Signal(`{name}.CharacterRemoving`),
		spawns = 0,
	}
	if character then
		player.spawns = 1
		player.Character = newCharacter(`{name}#1`)
	end
	return player
end
local function join(player)
	table.insert(Players.list, player)
	Players.PlayerAdded:Fire(player)
end
--- A real leave: PlayerRemoving while the Player is still parented, then it is removed.
local function leave(player)
	local index = table.find(Players.list, player)
	if index then
		table.remove(Players.list, index)
	end
	Players.PlayerRemoving:Fire(player)
	player.Parent = nil
end
--- A respawn: CharacterRemoving for the old model, the old model leaves the game, CharacterAdded for the new one.
local function respawn(player)
	local old = player.Character
	if old then
		player.CharacterRemoving:Fire(old)
	end
	player.spawns += 1
	local new = newCharacter(`{player.Name}#{player.spawns}`)
	player.Character = new
	if old then
		old.Parent = nil
		old.AncestryChanged:Fire(old, nil)
	end
	player.CharacterAdded:Fire(new)
	return new
end

-- VM: one shared _G (roblox-ts keeps per-ModuleScript runtime pointers in it); require caches per ModuleScript --------

local G = {}
local cache = {}
local loading = {}
local logs = {}
local globals = {
	game = game,
	workspace = services.Workspace,
	Workspace = services.Workspace,
	_G = G,
	shared = {},
	task = task,
	tick = os.clock,
	time = os.clock,
	elapsedTime = os.clock,
	wait = task.wait,
	delay = task.delay,
	spawn = task.spawn,
	print = function(...)
		table.insert(logs, table.concat({ ... }, " "))
	end,
	warn = function(...)
		local parts = {}
		for _, part in { ... } do
			table.insert(parts, tostring(part))
		end
		table.insert(warnings, table.concat(parts, " "))
	end,
	settings = function()
		return inert("settings()")
	end,
	UserSettings = function()
		return inert("UserSettings()")
	end,
	version = function()
		return "0.0.0"
	end,
	Enum = roblox.Enum,
	Instance = inertClass("Instance"),
	TweenInfo = inertClass("TweenInfo"),
	RaycastParams = inertClass("RaycastParams"),
	OverlapParams = inertClass("OverlapParams"),
	DateTime = {
		now = function()
			return { UnixTimestamp = os.time(), UnixTimestampMillis = os.time() * 1000 }
		end,
		fromUnixTimestamp = function(seconds)
			return { UnixTimestamp = seconds }
		end,
	},
	Random = {
		new = function()
			return {
				NextNumber = function(_, a, b)
					return (a or 0) + math.random() * ((b or 1) - (a or 0))
				end,
				NextInteger = function(_, a, b)
					return math.random(a, b)
				end,
			}
		end,
	},
}
for _, name in {
	"Axes", "BrickColor", "CFrame", "Color3", "ColorSequence", "ColorSequenceKeypoint", "Content", "Faces", "Font",
	"NumberRange", "NumberSequence", "NumberSequenceKeypoint", "PhysicalProperties", "Ray", "Rect", "Region3",
	"Region3int16", "UDim", "UDim2", "Vector2", "Vector2int16", "Vector3", "Vector3int16",
} do
	globals[name] = roblox[name] or inertClass(name)
end

local requireModule
local function requireFrom(script)
	return function(target)
		return requireModule(target)
	end
end
function requireModule(module)
	assert(type(module) == "table" and inner[module] and module.ClassName == "ModuleScript", `require expects a ModuleScript, got {module}`)
	local hit = cache[module]
	if hit then
		return hit.value
	end
	assert(not loading[module], `cyclic require of {module:GetFullName()}`)
	loading[module] = true
	local value
	local ok, err = pcall(function()
		local loader = inner[module].loader
		if loader then
			value = loader(module)
		else
			local environment = table.clone(globals)
			environment.script = module
			environment.require = requireFrom(module)
			value = luau.load(module.Source, { debugName = module:GetFullName(), environment = environment })()
		end
	end)
	loading[module] = nil
	if not ok then
		error(err, 0)
	end
	cache[module] = { value = value }
	return value
end

local rtsInclude = `{root}node_modules/roblox-ts/include/`
local function buildTree(label: string)
	local model = newNode("Folder", label, nil)
	local include = newNode("Folder", "include", model)
	newNode("ModuleScript", "RuntimeLib", include, read(`{rtsInclude}RuntimeLib.lua`))
	newNode("ModuleScript", "Promise", include, read(`{rtsInclude}Promise.lua`))
	local nodeModules = newNode("Folder", "node_modules", include)
	local rbxts = newNode("Folder", "@rbxts", nodeModules)
	mountDir(`{root}node_modules/@rbxts/trove`, "trove", rbxts)
	mountDir(`{root}node_modules/@rbxts/t`, "t", rbxts)
	newNode("ModuleScript", "services", rbxts, nil, function()
		return services
	end)
	local scope = newNode("Folder", "@typetorch", nodeModules)
	local framework = newNode("Folder", "framework", scope)
	mountDir(`{root}out`, "out", framework)
	newNode("Folder", "Server", model)
	return model
end

-- Generations ----------------------------------------------------------------------------------------------------------

local generationCount = 0
local function newGeneration(realm: string)
	generationCount += 1
	currentRealm = realm
	local model = buildTree(`payload#{generationCount}`)
	local TS = requireModule(model.include.RuntimeLib)
	local out = model.include.node_modules["@typetorch"].framework.out
	local server = model.Server
	local fw = TS.import(server, out)
	return {
		realm = realm,
		TS = TS,
		fw = fw,
		Reflect = fw.Reflect,
		registry = TS.import(server, out, "runtime", "registry"),
		netRuntime = TS.import(server, out, "net", "runtime"),
		limits = TS.import(server, out, "net", "limits"),
		Trove = TS.import(out, TS.getModule(out, "@rbxts", "trove").out).Trove,
		modules = newNode("Folder", "modules", server),
		record = { initOrder = {}, characters = {}, cleaned = {} },
	}
end

-- Flamework compat tests ----------------------------------------------------------------------------------------------

-- Players are tables here; on Roblox they are Instances (Flamework's fire(player | players) tells them apart that way).
local realTypeof = typeof
globals.typeof = function(value)
	if type(value) == "table" and rawget(value, "__player") then
		return "Instance"
	end
	return realTypeof(value)
end

local nextUserId = 100
local function newPlayer(name: string)
	nextUserId += 1
	return { __player = true, Name = name, UserId = nextUserId, Parent = Players }
end

local serverSent = {}
local clientSent = {}
local function kernelFor(realm: string, generation: number)
	local kernel = {
		kernelApi = 1,
		kernelVersion = "0.3.7",
		artifact = { id = `art-{generation}` },
		generation = generation,
		branch = "dev",
		channel = "dev",
		serverType = "reserved",
		persist = function(_, _key, init)
			return init()
		end,
		onMessage = function() end,
		send = function(_, ...)
			if realm == "client" then
				table.insert(clientSent, { ... })
			else
				table.insert(serverSent, { ... })
			end
		end,
		broadcast = function(_, ...)
			table.insert(serverSent, { "*all*", ... })
		end,
		sendUnreliable = function() end,
		broadcastUnreliable = function() end,
		isDev = function()
			return false
		end,
		devInfo = function()
			return { dev = false, reason = "none" }
		end,
		devStatus = function()
			return { dev = false, reason = "none" }
		end,
		logs = function()
			return {}
		end,
	}
	return kernel
end

local function start(gen, generation: number)
	local entry = if gen.realm == "server" then gen.fw.startServer else gen.fw.startClient
	local ok, result = pcall(entry, kernelFor(gen.realm, generation), { modules = { gen.modules }, devtools = false })
	if ok then
		gen.stop = result
	end
	realTask.wait()
	return ok, result
end

local function catch(fn, ...)
	local ok, err = pcall(fn, ...)
	return if ok then nil else tostring(err)
end

local function sentTo(list, from: number, player)
	local out = {}
	for index = from + 1, #list do
		if list[index][1] == player then
			table.insert(out, list[index])
		end
	end
	return out
end

-- Guard tables as @typetorch/transformer emits them for these interfaces:
--   ClientToServerEvents   { Vault: { startCrack(id: string) }, requestArrest(target: Player) }
--   ServerToClientEvents   { notifyError(message: string, warning?: boolean), Spin: { result(reward: string) } }
--   ClientToServerFunctions{ Spin: { requestSpin(): ProperReturns<number> }, Shop: { buy(item: string), slow() } }
local function isString(args)
	return type(args[1]) == "string"
end
local function anyArgs()
	return true
end
local c2sEvents = { Vault = { startCrack = isString }, requestArrest = anyArgs }
local s2cEvents = { notifyError = anyArgs, Spin = { result = anyArgs } }
local c2sFunctions = { Spin = { requestSpin = anyArgs }, Shop = { buy = isString, slow = anyArgs, broken = anyArgs } }

local alice = newPlayer("Alice")
local bob = newPlayer("Bob")
local carol = newPlayer("Carol")
for _, player in { alice, bob, carol } do
	table.insert(Players.list, player)
end

-- Server generation 1 -------------------------------------------------------------------------------------------------

local gen1 = newGeneration("server")
local ok1, err1 = start(gen1, 1)
check("server generation 1 starts", ok1, err1)
local compat = gen1.fw.createFlameworkCompat(c2sEvents, s2cEvents, c2sFunctions)
local dispatcher1 = gen1.netRuntime.maybeServerDispatcher()
for _, player in { alice, bob, carol } do
	dispatcher1.dispatch(player, gen1.netRuntime.HELLO)
end
local ServerEvents, ServerFunctions = compat.ServerEvents, compat.ServerFunctions

check("namespaces from both event trees merge (Spin has an S2C leaf; Vault a C2S one)", ServerEvents.Spin.result ~= nil and ServerEvents.Vault.startCrack ~= nil)
check("functions get their own tree", ServerFunctions.Spin.requestSpin ~= nil and ServerEvents.Spin.requestSpin == nil)
check("GlobalEvents:createServer returns ServerEvents", compat.GlobalEvents:createServer({}) == ServerEvents)
check("GlobalFunctions:createServer returns ServerFunctions", compat.GlobalFunctions:createServer() == ServerFunctions)
local warnCount = #warnings
compat.GlobalEvents:createServer({ middleware = { requestArrest = { function() end } } })
compat.GlobalEvents:createClient({ middleware = { x = {} } })
check("middleware in a config is warned once (ignored)", #warnings == warnCount + 1 and has(warnings[#warnings], "middleware"), warnings[#warnings])

-- Path collisions.
local both = catch(gen1.fw.createFlameworkCompat, { Spin2 = { request = anyArgs } }, {}, { Spin2 = { request = anyArgs } })
check("an event and a function with the same path are refused", has(both, "\"Spin2.request\" is both an event and a function"), both)
local twice = catch(gen1.fw.createFlameworkCompat, { requestArrest = anyArgs }, {}, {})
check("a path another network declared is refused", has(twice, "\"requestArrest\" is already declared by another network"), twice)
local unguarded = catch(gen1.fw.createFlameworkCompat)
check("without generated guards: a clear error", has(unguarded, "guards were not generated"), unguarded)

-- connect: one thread per call, guards, Disconnect, troves.
local heard = {}
local releaseFirst = nil
local first = ServerEvents.Vault.startCrack:connect(function(player, vault)
	table.insert(heard, `first:{player.Name}:{vault}`)
	releaseFirst = coroutine.running()
	coroutine.yield()
	table.insert(heard, "first:resumed")
end)
local second = ServerEvents.Vault.startCrack:connect(function(player, vault)
	table.insert(heard, `second:{player.Name}:{vault}`)
end)
check("connect returns a connection (Connected, Disconnect)", first.Connected == true and type(first.Disconnect) == "function")
dispatcher1.dispatch(alice, "e:Vault.startCrack", "vault-1")
check("a listener that yields doesn't hold up the next one (own thread each)", #heard == 2 and table.find(heard, "first:Alice:vault-1") ~= nil and table.find(heard, "second:Alice:vault-1") ~= nil, table.concat(heard, ","))
task.spawn(releaseFirst)
check("the yielded listener resumes on its own", heard[3] == "first:resumed")
dispatcher1.dispatch(alice, "e:Vault.startCrack", 42)
check("the generated guard still runs first (42 isn't a string)", #heard == 3 and dispatcher1.stats["Vault.startCrack"].rejected == 1)
first:Disconnect()
check("Disconnect: Connected turns false", first.Connected == false)
first:Disconnect()
dispatcher1.dispatch(bob, "e:Vault.startCrack", "vault-2")
check("a disconnected listener doesn't run, the other does", #heard == 4 and heard[4] == "second:Bob:vault-2", table.concat(heard, ","))
local trove = gen1.Trove.new()
trove:add(second)
trove:clean()
dispatcher1.dispatch(bob, "e:Vault.startCrack", "vault-3")
check("a trove disconnects it like an RBXScriptConnection", #heard == 4 and second.Connected == false)

-- A listener that throws is warned and counted; the others still run.
local after = 0
local bad = ServerEvents.requestArrest:connect(function()
	error("listener bug")
end)
local good = ServerEvents.requestArrest:connect(function(_, target)
	after += if target == bob then 1 else 0
end)
warnCount = #warnings
dispatcher1.dispatch(alice, "e:requestArrest", bob)
check("a throwing listener: the next still runs", after == 1)
check("a throwing listener is warned and counted", has(warnings[#warnings], "requestArrest listener threw") and dispatcher1.stats.requestArrest.errors == 1, warnings[#warnings])
bad:Disconnect()
good:Disconnect()

-- predict = emit: no guard, no traffic.
local predicted = {}
local predictConnection = ServerEvents.Vault.startCrack:connect(function(player, vault)
	table.insert(predicted, { player, vault })
end)
ServerEvents.Vault.startCrack:predict(carol, 7)
check("server predict runs the listeners as if the player sent it (no guard)", #predicted == 1 and predicted[1][1] == carol and predicted[1][2] == 7)
predictConnection:Disconnect()

-- Sending: fire(player | players), the call shorthand, except, broadcast.
local before = #serverSent
ServerEvents.notifyError:fire(alice, "No", true)
local toAlice = sentTo(serverSent, before, alice)
check("fire(player) sends to that player", #toAlice == 1 and toAlice[1][2] == "e:notifyError" and toAlice[1][3] == "No" and toAlice[1][4] == true)
before = #serverSent
ServerEvents.notifyError:fire({ alice, bob }, "Both")
check("fire({ players }) sends to each", #sentTo(serverSent, before, alice) == 1 and #sentTo(serverSent, before, bob) == 1 and #sentTo(serverSent, before, carol) == 0)
before = #serverSent
ServerEvents.notifyError(carol, "Called")
local toCarol = sentTo(serverSent, before, carol)
check("calling the leaf is fire (ServerEvents.x(player, ...))", #toCarol == 1 and toCarol[1][3] == "Called")
before = #serverSent
ServerEvents.Spin.result:except(alice, "x")
check("except(player) sends to everyone else", #sentTo(serverSent, before, alice) == 0 and #sentTo(serverSent, before, bob) == 1 and #sentTo(serverSent, before, carol) == 1)
before = #serverSent
ServerEvents.Spin.result:except({ alice, bob }, "y")
check("except({ players })", #sentTo(serverSent, before, alice) == 0 and #sentTo(serverSent, before, bob) == 0 and #sentTo(serverSent, before, carol) == 1)
before = #serverSent
ServerEvents.Spin.result:broadcast("z")
check("broadcast = fireAll (one broadcast when every client is ready)", serverSent[before + 1] and serverSent[before + 1][1] == "*all*" and serverSent[before + 1][2] == "e:Spin.result")

-- setCallback = handle: plain values, Promises (resolved, rejected), errors; predict.
local Promise = gen1.TS.Promise
ServerFunctions.Spin.requestSpin:setCallback(function(player)
	return { player.UserId }
end)
ServerFunctions.Shop.buy:setCallback(function(_, item)
	-- (not Promise.delay: it waits on RunService.Heartbeat, which this harness never fires)
	return Promise.new(function(resolve)
		realTask.delay(0.05, resolve, { `bought {item}` })
	end)
end)
ServerFunctions.Shop.slow:setCallback(function()
	return Promise.reject("out of stock")
end)
ServerFunctions.Shop.broken:setCallback(function()
	error("handler bug")
end)
local function reply(id: number)
	for index = #serverSent, 1, -1 do
		local entry = serverSent[index]
		if entry[2] == gen1.netRuntime.RESPONSE and entry[3] == id then
			return entry
		end
	end
	return nil
end
dispatcher1.dispatch(alice, "r:Spin.requestSpin", 1)
local r1 = reply(1)
check("setCallback answers a request", r1 and r1[1] == alice and r1[4] == true and r1[5][1] == alice.UserId)
task.spawn(dispatcher1.dispatch, alice, "r:Shop.buy", 2, "sword")
check("a callback's Promise: no answer before it resolves", reply(2) == nil)
realTask.wait(0.15)
local r2 = reply(2)
check("a callback's Promise: the answer is its value", r2 and r2[4] == true and r2[5][1] == "bought sword", r2 and tostring(r2[5]))
task.spawn(dispatcher1.dispatch, alice, "r:Shop.slow", 3)
realTask.wait(0.05)
local r3 = reply(3)
check("a rejected Promise answers an error", r3 and r3[4] == false and r3[5] == "Something went wrong, try again.", r3 and tostring(r3[5]))
warnCount = #warnings
dispatcher1.dispatch(alice, "r:Shop.broken", 4)
local r4 = reply(4)
check("a throwing callback answers an error and is warned", r4 and r4[4] == false and has(warnings[#warnings], "Shop.broken handler threw"))
dispatcher1.dispatch(alice, "r:Shop.buy", 5, 99)
local r5 = reply(5)
check("request guards run (99 isn't a string)", r5 and r5[4] == false and r5[5] == "Bad request.")
local predictedSpin = ServerFunctions.Spin.requestSpin:predict(bob)
local okSpin, spinValue = predictedSpin:await()
check("function predict runs the callback here", okSpin and spinValue[1] == bob.UserId)
local okBuy, buyValue = ServerFunctions.Shop.buy:predict(bob, "shield"):await()
check("function predict follows a callback's Promise", okBuy and buyValue[1] == "bought shield")
local compat2Server = gen1.fw.createFlameworkCompat({}, {}, { Other = { ask = anyArgs } }).ServerFunctions
local okNone, noneReason = compat2Server.Other.ask:predict(bob):await()
check("function predict without a callback rejects", not okNone and has(noneReason, "has no callback"), noneReason)

-- Swap: generation 1 stops, generation 2 declares the same network again.
local oldHeard = 0
ServerEvents.requestArrest:connect(function()
	oldHeard += 1
end)
gen1.stop({ reason = "deploy" })
realTask.wait()
local stoppedFire = catch(function()
	ServerEvents.notifyError:fire(alice, "late")
end)
check("after its generation stopped, the old handlers fail clearly", has(stoppedFire, "only available on a running server"), stoppedFire)

local gen2 = newGeneration("server")
local ok2, err2 = start(gen2, 2)
check("server generation 2 starts", ok2, err2)
local compatB = gen2.fw.createFlameworkCompat(c2sEvents, s2cEvents, c2sFunctions)
check("the next generation declares the same paths again (fresh registry)", compatB.ServerEvents.requestArrest ~= nil)
local newHeard = 0
compatB.ServerEvents.requestArrest:connect(function()
	newHeard += 1
end)
local dispatcher2 = gen2.netRuntime.maybeServerDispatcher()
dispatcher2.dispatch(alice, "e:requestArrest", bob)
check("after a swap only the new generation's listeners run (no trove needed)", newHeard == 1 and oldHeard == 0)
gen2.stop()

-- Client generation ---------------------------------------------------------------------------------------------------

local me = newPlayer("Me")
Players.LocalPlayer = me
local cgen = newGeneration("client")
local okC, errC = start(cgen, 1)
check("client generation starts", okC, errC)
local ccompat = cgen.fw.createFlameworkCompat(c2sEvents, s2cEvents, c2sFunctions)
local cdispatcher = cgen.netRuntime.maybeClientDispatcher()
local ClientEvents, ClientFunctions = ccompat.ClientEvents, ccompat.ClientFunctions
check("GlobalEvents:createClient returns ClientEvents", ccompat.GlobalEvents:createClient({}) == ClientEvents)

local sent = #clientSent
ClientEvents.Vault.startCrack:fire("vault-9")
check("client fire sends the event", clientSent[sent + 1][1] == "e:Vault.startCrack" and clientSent[sent + 1][2] == "vault-9")
ClientEvents.requestArrest(alice)
check("calling a client leaf is fire", clientSent[sent + 2][1] == "e:requestArrest" and clientSent[sent + 2][2] == alice)

local toasts = {}
local toast = ClientEvents.notifyError:connect(function(message, warning)
	table.insert(toasts, `{message}:{tostring(warning)}`)
end)
cdispatcher.dispatch("e:notifyError", "From server", false)
check("client connect hears the server", toasts[1] == "From server:false")
sent = #clientSent
ClientEvents.notifyError:predict("Local", true)
check("client predict runs the listeners, no traffic", toasts[2] == "Local:true" and #clientSent == sent)
toast:Disconnect()
cdispatcher.dispatch("e:notifyError", "Ignored")
check("client Disconnect", #toasts == 2)

local function pending(promise)
	promise:catch(function() end)
	return promise
end
sent = #clientSent
local spin = pending(ClientFunctions.Spin.requestSpin:invoke())
local request = clientSent[sent + 1]
check("invoke sends a request", request[1] == "r:Spin.requestSpin" and type(request[2]) == "number")
cdispatcher.dispatch(cgen.netRuntime.RESPONSE, request[2], true, { 3 })
local okS, valueS = spin:await()
check("invoke resolves with the answer", okS and valueS[1] == 3)
local called = pending(ClientFunctions.Shop.buy("sword"))
local callRequest = clientSent[#clientSent]
check("calling a request leaf is invoke", callRequest[1] == "r:Shop.buy" and callRequest[3] == "sword")
cdispatcher.dispatch(cgen.netRuntime.RESPONSE, callRequest[2], true, { "ok" })
check("the call's Promise resolves", called:getStatus() == "Resolved")

-- Without createClient({ defaultTimeout }) a request waits Flamework's client default, 30 s (createNetwork: 15 s).
local delays = {}
local harnessDelay = task.delay
task.delay = function(seconds, ...)
	table.insert(delays, seconds)
	return harnessDelay(seconds, ...)
end
local waiting = pending(ClientFunctions.Spin.requestSpin:invoke())
task.delay = harnessDelay
check("a request without a timeout waits Flamework's 30 s", delays[1] == 30, delays[1])
cdispatcher.dispatch(cgen.netRuntime.RESPONSE, clientSent[#clientSent][2], true, { 1 })
check("(and resolves when answered)", waiting:getStatus() == "Resolved")

ccompat.GlobalFunctions:createClient({ defaultTimeout = 0.6 })
cgen.fw.setNetworkLimits({ ["Shop.slow"] = { timeout = 5 } })
local byDefault = pending(ClientFunctions.Spin.requestSpin:invoke())
local byLeaf = pending(ClientFunctions.Shop.slow:invoke())
local byCall = pending(ClientFunctions.Shop.buy:invokeWithTimeout(0.5, "x"))
realTask.wait(0.55)
check("invokeWithTimeout(seconds) gives up in time", byCall:getStatus() == "Rejected")
check("createClient({ defaultTimeout }) is still waiting before its time", byDefault:getStatus() == "Started")
realTask.wait(0.15)
check("createClient({ defaultTimeout }) applies to leaves without a timeout", byDefault:getStatus() == "Rejected")
check("a leaf's own timeout (setNetworkLimits) wins over defaultTimeout", byLeaf:getStatus() == "Started")
cgen.stop()

check("no errors raised in framework threads", #threadErrors == 0, threadErrors[1])
print(if failed == 0 then `test-flamework-compat: all {passed} checks passed` else `test-flamework-compat: {failed} of {passed + failed} checks failed`)
process.exit(if failed == 0 then 0 else 1)
