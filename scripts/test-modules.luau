--!nocheck
-- Module lookup and the per-player / per-character helpers, end to end under Lune (plans/19 stream A):
--   - Dependency<T>(), TypeTorch.module<T>() / tryModule<T>(): from onInit/onStart and plain classes; the clear errors
--     (not constructed yet: constructor, field initializer, module top level; the other realm; not a module; no id;
--     stopped; edit mode); after a swap they return the new generation's instance;
--   - Lazy<T>: constructor parameters (`lazy:<id>` from @typetorch/transformer 0.2.1+) and fields; two modules that take
--     each other lazily start; onInit order ignores lazy edges; .get() in a constructor throws; the old transformer's
--     Lazy id and a lazy parameter to a missing module fail at start; the cycle error names only the cycle and says how
--     to break it;
--   - network emit (client: Flamework's predict; server: for tests), invokeWithTimeout and the per-leaf `timeout`, with
--     bounds;
--   - ctx.playerState / TypeTorch.playerState: persisted across swaps, removed on a real leave (never on a swap), pruned
--     when a player left between generations;
-- It runs the real startServer/startClient of out/ (with real RuntimeLib, Promise, trove and t from node_modules) in an
-- emulated tree, one fresh copy per generation (one require cache, as on Roblox), with stub kernels that share a
-- persist store across generations. Not Roblox: mocked Players, characters and signals, inert stand-ins for the rest.
--
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml and template/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-modules.luau ../framework/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-modules.luau
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
		record = { initOrder = {} },
	}
end

--- A roblox-ts class: `Name.new(...)` runs `constructor`, methods live on the class, tostring(class) is its name.
local function class(name: string, methods)
	local C = setmetatable({}, {
		__tostring = function()
			return name
		end,
	})
	C.__index = C
	function C.new(...)
		local self = setmetatable({}, C)
		return self:constructor(...) or self
	end
	function C:constructor(...)
		if methods.constructor then
			methods.constructor(self, ...)
		end
	end
	for key, value in methods do
		if key ~= "constructor" then
			C[key] = value
		end
	end
	return C
end

--- What @typetorch/transformer emits for a decorated class, run when its ModuleScript loads (in startServer's
--- requireAll): the identifier, the constructor parameter ids, then the decorator (which registers the module).
local function addModule(gen, name: string, id: string, params, methods, realm: string?, topLevel: any?)
	newNode("ModuleScript", name, gen.modules, nil, function()
		if topLevel then
			topLevel(gen)
		end
		local C = class(name, methods(gen))
		gen.Reflect.defineMetadata(C, "identifier", id)
		if params and #params > 0 then
			gen.Reflect.defineMetadata(C, "typetorch:parameters", params)
		end
		local kind = if (realm or gen.realm) == "client" then "Controller" else "Service"
		gen.Reflect.decorate(C, `@typetorch/framework:decorators@{kind}`, gen.fw[kind], {})
		return { [name] = C }
	end)
end

local serverStore = {}
local clientStore = {}
local clientSent = {}
local clientHandler = nil
local function kernelFor(realm: string, generation: number)
	local store = if realm == "server" then serverStore else clientStore
	local kernel = {
		kernelApi = 1,
		kernelVersion = "0.3.7",
		artifact = { id = `art-{generation}` },
		generation = generation,
		branch = "dev",
		channel = "dev",
		serverType = "reserved",
		persist = function(_, key, init)
			if store[key] == nil then
				store[key] = init()
			end
			return store[key]
		end,
		onMessage = function(_, handler)
			if realm == "client" then
				clientHandler = handler
			end
		end,
		send = function(_, ...)
			if realm == "client" then
				table.insert(clientSent, { ... })
			end
		end,
		broadcast = function() end,
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

local function running(gen, name: string)
	for _, mod in gen.registry.runningModules do
		if mod.name == name then
			return mod
		end
	end
	return nil
end

local function catch(fn, ...)
	local ok, err = pcall(fn, ...)
	return if ok then nil else tostring(err)
end

-- Players in the server ------------------------------------------------------------------------------------------------

local alice = newPlayer("Alice", true)
local bob = newPlayer("Bob", false)
local carol = newPlayer("Carol", true)
for _, player in { alice, bob, carol } do
	table.insert(Players.list, player)
end

-- The server game: the modules of one build ----------------------------------------------------------------------------

local ids = {
	data = "server/services/data@DataService",
	shop = "server/services/shop@ShopService",
	item = "server/services/item@ItemService",
	team = "server/services/team@TeamService",
	pvp = "server/services/pvp@PvpService",
	cooldown = "server/services/cooldown@CooldownService",
	hud = "client/controllers/hud@HudController",
	missingClient = "client/controllers/menu@MenuController",
	missingServer = "server/services/vault@VaultService",
}

local function serverGame(gen)
	local rec = gen.record
	local fw = gen.fw
	addModule(gen, "DataService", ids.data, {}, function()
		return {
			onInit = function(self)
				table.insert(rec.initOrder, "DataService")
				-- onInit: every module is constructed (ShopService's onInit hasn't run yet).
				rec.dataSeesShop = fw.Dependency(ids.shop)
			end,
		}
	end)
	addModule(gen, "ShopService", ids.shop, { ids.data }, function()
		local Helper = class("Helper", {
			constructor = function(self)
				self.data = fw.Dependency(ids.data)
			end,
		})
		return {
			constructor = function(self, data)
				self.data = data
			end,
			onInit = function(self)
				table.insert(rec.initOrder, "ShopService")
			end,
			onStart = function(self)
				-- A plain class built by a module, outside constructor injection.
				rec.helperData = Helper.new().data
				rec.moduleData = fw.TypeTorch:module(ids.data)
				rec.tryData = fw.TypeTorch:tryModule(ids.data)
				rec.tryNothing = fw.TypeTorch:tryModule("shared/nothing@Nothing")
				rec.tryHud = fw.TypeTorch:tryModule(ids.hud)
				rec.hudError = catch(fw.Dependency, ids.hud)
				rec.menuError = catch(fw.Dependency, ids.missingClient)
				rec.unknownError = catch(fw.Dependency, "shared/util@Util")
				rec.noIdError = catch(fw.Dependency, nil)
				rec.noIdTry = catch(function()
					return fw.TypeTorch:tryModule(nil)
				end)
			end,
			onStop = function(self)
				rec.stopSeesData = catch(fw.Dependency, ids.data) == nil
			end,
		}
	end)
	-- ItemService and TeamService take each other lazily (constructor parameters, transformer 0.2.1+).
	addModule(gen, "ItemService", ids.item, { "lazy:" .. ids.team }, function()
		return {
			constructor = function(self, team)
				self.team = team
				rec.itemLazyInConstructor = catch(function()
					return team:get()
				end)
			end,
			onInit = function(self)
				table.insert(rec.initOrder, "ItemService")
				rec.itemTeam = self.team:get()
				rec.itemTeamAgain = self.team:get()
			end,
		}
	end)
	addModule(gen, "TeamService", ids.team, { "lazy:" .. ids.item, ids.data }, function()
		return {
			constructor = function(self, item, data)
				self.item = item
				self.data = data
			end,
			onInit = function(self)
				table.insert(rec.initOrder, "TeamService")
				rec.teamItem = self.item:get()
			end,
		}
	end)
	-- A Lazy field (any transformer): `private readonly box = Lazy<ItemService>()`.
	addModule(gen, "PvpService", ids.pvp, {}, function()
		return {
			constructor = function(self)
				self.box = fw.Lazy(ids.item)
			end,
			onStart = function(self)
				rec.pvpBox = self.box:get()
				rec.pvpLazy = self.box
			end,
		}
	end)
	addModule(gen, "CooldownService", ids.cooldown, {}, function()
		return {
			onInit = function(self)
				self.cooldowns = self.ctx:playerState("cooldowns.v1", function(player)
					return { n = 0, who = player.Name }
				end)
				rec.cooldowns = self.cooldowns
			end,
			onStart = function(self)
				rec.sameHandle = fw.TypeTorch:playerState("cooldowns.v1", function()
					return {}
				end) == self.cooldowns
			end,
		}
	end)
	-- A client controller that shared code loaded on the server (registered, but for the client).
	addModule(gen, "HudController", ids.hud, {}, function()
		return {}
	end, "client")
end

-- Generation 1 ---------------------------------------------------------------------------------------------------------

local gen1 = newGeneration("server")
serverGame(gen1)
local ok1, err1 = start(gen1, 1)
check("gen 1: starts with two modules taking each other as Lazy<T> (no cycle error)", ok1, err1)
local rec1 = gen1.record
local data1 = running(gen1, "DataService")
local item1 = running(gen1, "ItemService")
local team1 = running(gen1, "TeamService")
if ok1 then
	check("Dependency<T>() in a plain class built in onStart returns the running module", rec1.helperData == data1.instance)
	check("TypeTorch.module<T>() returns the same instance", rec1.moduleData == data1.instance)
	check("Dependency<T>() works in onInit (every module is constructed)", rec1.dataSeesShop == running(gen1, "ShopService").instance)
	check("TypeTorch.tryModule<T>(): the module, else undefined (not a module, other realm)", rec1.tryData == data1.instance and rec1.tryNothing == nil and rec1.tryHud == nil)
	check("other realm (a registered @Controller on the server): a clear error", has(rec1.hudError, "Dependency<HudController>(): HudController is a @Controller: it runs on the client, not on the server"), rec1.hudError)
	check("other realm (not loaded here, by its id): the same error", has(rec1.menuError, "MenuController is a @Controller: it runs on the client"), rec1.menuError)
	check("not a module: names it and asks about the folders", has(rec1.unknownError, "Util (shared/util@Util) isn't a loaded @Service or @Controller"), rec1.unknownError)
	check("no id (the macro wasn't expanded): asks for @typetorch/transformer", has(rec1.noIdError, "@typetorch/transformer must be in the tsconfig plugins"), rec1.noIdError)
	check("tryModule without an id is still an error (the build is wrong)", has(rec1.noIdTry, "@typetorch/transformer"), rec1.noIdTry)
	-- Lazy<T>.
	check("Lazy<T> constructor parameter: .get() in the constructor throws a clear error", has(rec1.itemLazyInConstructor, "TeamService isn't constructed yet: call Lazy<TeamService>.get() from onInit/onStart or later"), rec1.itemLazyInConstructor)
	check("Lazy<T> constructor parameters resolve both ways in onInit", rec1.itemTeam == team1.instance and rec1.teamItem == item1.instance)
	check("Lazy<T>.get() keeps the instance", rec1.itemTeamAgain == rec1.itemTeam)
	check("Lazy<T> field (`= Lazy<ItemService>()`) resolves in onStart", rec1.pvpBox == item1.instance)
	local order = table.concat(rec1.initOrder, ",")
	check("onInit order ignores lazy edges (ItemService before TeamService by name) and keeps real ones (DataService first)", order == "DataService,ItemService,ShopService,TeamService", order)
	check("dev menu: lazy dependencies are listed as '(lazy)'", item1.dependencies[1] == "TeamService (lazy)" and team1.dependencies[1] == "ItemService (lazy)" and team1.dependencies[2] == "DataService", table.concat(team1.dependencies, ", "))
	check("the client controller isn't constructed on the server", running(gen1, "HudController") == nil)
	-- playerState.
	check("ctx.playerState and TypeTorch.playerState: the same key is the same handle", rec1.sameHandle == true)
	local cooldowns = rec1.cooldowns
	local first = cooldowns:get(alice)
	first.n += 1
	cooldowns:set(bob, { n = 5, who = "Bob" })
	cooldowns:get(carol)
	check("playerState: get() stores init(player) the first time, then returns the same value", cooldowns:get(alice) == first and first.who == "Alice" and cooldowns:has(bob))
	local stores = serverStore.__playerState
	check("playerState: kept in the persist store under __playerState, by store and UserId", stores ~= nil and stores["cooldowns.v1"][alice.UserId] == first)
	check("playerState: the dev menu's State explorer sees it (persist keys)", gen1.registry.persistKeys.__playerState == stores)
end
check("gen 1: nothing raised in module threads", #threadErrors == 0, threadErrors[1])

-- Generations that fail to start, each with the error a game would see -------------------------------------------------

local function failing(label: string, build)
	local gen = newGeneration("server")
	build(gen)
	local ok, err = start(gen, 99)
	return ok, tostring(err), gen
end

do
	local ok, err = failing("constructor", function(gen)
		addModule(gen, "DataService", ids.data, {}, function()
			return {}
		end)
		addModule(gen, "BadService", "server/services/bad@BadService", {}, function()
			return {
				constructor = function(self)
					self.data = gen.fw.Dependency(ids.data)
				end,
			}
		end)
	end)
	check("Dependency<T>() in a constructor: start fails, naming the class and where to call it", not ok and has(err, "DataService isn't constructed yet: call Dependency<DataService>() from onInit/onStart or later, not from a constructor or field initializer"), err)
end
do
	local ok, err = failing("constructor-module", function(gen)
		addModule(gen, "DataService", ids.data, {}, function()
			return {}
		end)
		addModule(gen, "ZedService", "server/services/zed@ZedService", {}, function()
			return {
				constructor = function(self)
					self.data = gen.fw.TypeTorch:module(ids.data)
				end,
			}
		end)
	end)
	-- ZedService constructs after DataService: still refused (no dependence on construction order).
	check("TypeTorch.module<T>() in a constructor is refused even when the module is already constructed", not ok and has(err, "call TypeTorch.module<DataService>() from onInit/onStart or later"), err)
end
do
	local ok, err = failing("field-lazy-get", function(gen)
		addModule(gen, "DataService", ids.data, {}, function()
			return {}
		end)
		addModule(gen, "EagerService", "server/services/eager@EagerService", {}, function()
			return {
				constructor = function(self)
					self.data = gen.fw.Lazy(ids.data)
					self.value = self.data:get()
				end,
			}
		end)
	end)
	check("Lazy<T> field: .get() in the constructor fails the start with a clear error", not ok and has(err, "DataService isn't constructed yet: call Lazy<DataService>.get() from onInit/onStart or later"), err)
end
do
	local ok, err = failing("top-level", function(gen)
		addModule(gen, "DataService", ids.data, {}, function()
			return {}
		end)
		addModule(gen, "Commands", "server/commands/bounty@Commands", {}, function()
			return {}
		end, nil, function(g)
			-- `const BountyService = Dependency<BountyService>()` at the top level of a module.
			g.fw.Dependency(ids.data)
		end)
	end)
	check("Dependency<T>() at module top level: fails while loading, and says so", not ok and has(err, "DataService isn't constructed yet: Dependency<DataService>() ran while the modules were loading (module top-level code)"), err)
end
do
	local ok, err = failing("cycle", function(gen)
		addModule(gen, "Alpha", "server/services/alpha@Alpha", { "server/services/beta@Beta" }, function()
			return {}
		end)
		addModule(gen, "Beta", "server/services/beta@Beta", { "server/services/gamma@Gamma" }, function()
			return {}
		end)
		addModule(gen, "Gamma", "server/services/gamma@Gamma", { "server/services/beta@Beta" }, function()
			return {}
		end)
	end)
	check("a cycle: the error names only the cycle", not ok and has(err, "dependency cycle: Beta -> Gamma -> Beta.") and not has(err, "Alpha"), err)
	check("a cycle: the error suggests Lazy<T> and Dependency<T>()", has(err, "Gamma can take Beta as Lazy<Beta>") and has(err, "Dependency<Beta>() inside a method"), err)
end
do
	local ok, err = failing("old-transformer", function(gen)
		addModule(gen, "DataService", ids.data, {}, function()
			return {}
		end)
		addModule(gen, "OldService", "server/services/old@OldService", { ids.data, "@typetorch/framework:runtime/dependency@Lazy" }, function()
			return {}
		end)
	end)
	check("Lazy<T> parameter compiled by transformer 0.2.0 (T dropped): start fails, suggesting the field", not ok and has(err, "OldService: constructor parameter 2 is a Lazy<T>") and has(err, "0.2.1") and has(err, "Lazy<TeamService>()"), err)
end
do
	local ok, err = failing("lazy-missing", function(gen)
		addModule(gen, "LostService", "server/services/lost@LostService", { "lazy:" .. ids.missingServer }, function()
			return {}
		end)
	end)
	check("Lazy<T> to something that isn't a loaded module fails at start", not ok and has(err, "LostService takes Lazy<VaultService>"), err)
end
do
	local ok, err = failing("lazy-realm", function(gen)
		addModule(gen, "HudController", ids.hud, {}, function()
			return {}
		end, "client")
		addModule(gen, "ViewService", "server/services/view@ViewService", { "lazy:" .. ids.hud }, function()
			return {}
		end)
	end)
	check("Lazy<T> to the other realm's module fails at start", not ok and has(err, "ViewService needs Lazy<HudController>, which runs on the other realm"), err)
end

-- Edit mode: a framework copy that never started ----------------------------------------------------------------------

do
	local gen = newGeneration("server")
	local idle = catch(gen.fw.Dependency, ids.data)
	check("edit mode: Dependency<T>() says no generation runs", has(idle, "Dependency<DataService>(): no TypeTorch generation is running here"), idle)
	check("edit mode: tryModule<T>() is undefined", gen.fw.TypeTorch:tryModule(ids.data) == nil)
	local noId = catch(gen.fw.Lazy, nil)
	check("Lazy<T>() without an id asks for the transformer", has(noId, "Lazy<T>() got no type id"), noId)
	local state = gen.fw.TypeTorch:playerState("edit.v1", function()
		return 1
	end)
	check("edit mode: playerState works locally (no persist store)", state:get(alice) == 1 and serverStore["__playerState"]["edit.v1"] == nil)
end

-- Network: client emit, invokeWithTimeout, server emit -----------------------------------------------------------------

local stringArgs = function(args)
	return type(args[1]) == "string"
end
local anyArgs = function()
	return true
end
local function declare(gen)
	return gen.fw.createNetwork(
		{ vc = { spawn = anyArgs, status = anyArgs }, shop = { buy = stringArgs } },
		{ notify = { error = anyArgs } }
	)
end

do -- server emit, in generation 1
	local network = declare(gen1)
	local heard = {}
	local disconnect = network.server.shop.buy:on(function(player, item)
		table.insert(heard, { player, item })
	end)
	network.server.shop.buy:emit(alice, 42)
	check("server emit: runs the leaf's on handlers now, as if the player sent it (no guard: 42 isn't a string)", #heard == 1 and heard[1][1] == alice and heard[1][2] == 42)
	local dispatcher = gen1.netRuntime.maybeServerDispatcher()
	local stats = dispatcher.stats["shop.buy"]
	check("server emit: not counted as network traffic", stats == nil or stats.inbound == 0)
	disconnect()
	network.server.shop.buy:emit(alice, "sword")
	check("server emit: a disconnected handler doesn't run", #heard == 1)
end

-- Generation 1 stops (a swap) ------------------------------------------------------------------------------------------

do
	gen1.stop({ reason = "deploy" })
	realTask.wait()
	check("swap: onStop can still use Dependency<T>()", rec1.stopSeesData == true)
	local stopped = catch(gen1.fw.Dependency, ids.data)
	check("after its generation stopped, Dependency<T>() fails clearly", has(stopped, "the generation that ran DataService has stopped"), stopped)
	local stoppedLazy = catch(function()
		return rec1.pvpLazy:get()
	end)
	check("after its generation stopped, a kept Lazy<T>.get() fails clearly", has(stoppedLazy, "Lazy<ItemService>.get(): the generation that ran ItemService has stopped"), stoppedLazy)
	local store = serverStore.__playerState["cooldowns.v1"]
	check("swap: playerState entries stay (no one left)", store[alice.UserId] ~= nil and store[bob.UserId] ~= nil and store[carol.UserId] ~= nil)
end

-- Generation 2 (the next build after the swap) -------------------------------------------------------------------------

local gen2 = newGeneration("server")
serverGame(gen2)
local ok2, err2 = start(gen2, 2)
check("gen 2: starts", ok2, err2)
local rec2 = gen2.record
if ok2 then
	local data2 = running(gen2, "DataService")
	check("after a swap Dependency<T>() returns the new generation's instance", rec2.helperData == data2.instance and data2.instance ~= data1.instance)
	check("after a swap TypeTorch.module<T>() too", rec2.moduleData == data2.instance)
	check("gen 1's framework still refuses (never the new generation's module)", catch(gen1.fw.Dependency, ids.data) ~= nil)
	local cooldowns = rec2.cooldowns
	check("after a swap playerState has the same values", cooldowns:get(alice).n == 1 and cooldowns:get(bob).n == 5)

	-- A real leave removes the player from every store (deferred: the game's own PlayerRemoving handlers still read it).
	local readDuringLeave = nil
	local connection = Players.PlayerRemoving:Connect(function(player)
		if player == alice then
			readDuringLeave = cooldowns:get(alice).n
		end
	end)
	leave(alice)
	connection:Disconnect()
	realTask.wait()
	local store = serverStore.__playerState["cooldowns.v1"]
	check("a real leave removes the player's entry, after PlayerRemoving handlers ran", readDuringLeave == 1 and store[alice.UserId] == nil and store[bob.UserId] ~= nil)
	local fresh = cooldowns:get(alice)
	cooldowns:set(alice, { n = 9 })
	check("a player who left gets no new entry (get returns init, set is ignored)", fresh.n == 0 and store[alice.UserId] == nil)
	cooldowns:delete(bob)
	check("delete and has", not cooldowns:has(bob) and store[bob.UserId] == nil)
	cooldowns:set(bob, { n = 7, who = "Bob" })
end

-- Generation 3: a player left between generations (no one listened) ---------------------------------------------------

do
	gen2.stop({ reason = "deploy" })
	realTask.wait()
	-- Carol leaves while no generation runs: her entry can't be removed by a PlayerRemoving handler.
	local index = table.find(Players.list, carol)
	table.remove(Players.list, index)
	carol.Parent = nil
	check("between generations Carol's entry is still there", serverStore.__playerState["cooldowns.v1"][carol.UserId] ~= nil)
	local gen3 = newGeneration("server")
	local opened = nil
	addModule(gen3, "CooldownService", ids.cooldown, {}, function()
		return {
			onInit = function(self)
				opened = self.ctx:playerState("cooldowns.v1", function()
					return { n = 0 }
				end)
			end,
		}
	end)
	local ok3, err3 = start(gen3, 3)
	check("gen 3: starts", ok3, err3)
	local store = serverStore.__playerState["cooldowns.v1"]
	check("the next generation's first store drops players who left in between, keeps the others", opened ~= nil and store[carol.UserId] == nil and store[bob.UserId] ~= nil)
	if gen3.stop then
		gen3.stop()
	end
end

-- A cleanup that throws doesn't cut the generation stop short ---------------------------------------------------------
-- `trove.remove(x)` inside a cleanup throws ("Cannot call trove.remove() while cleaning"); before framework 0.5.2 that
-- aborted the stop: later troves, the network, unbind and the root trove never ran (a dead generation stayed alive).

do
	local gen4 = newGeneration("server")
	local cleaned = {}
	local swappedOut = false
	addModule(gen4, "DataService", ids.data, {}, function()
		return {
			onInit = function(self)
				self.trove:add(function()
					table.insert(cleaned, "data")
				end)
			end,
		}
	end)
	addModule(gen4, "FlightService", ids.shop, {}, function()
		return {
			onInit = function(self)
				self.flight = self.trove:extend()
				self.flight:add(function()
					table.insert(cleaned, "flight")
				end)
				self.trove:add(function()
					self.trove:remove(self.flight)
				end)
				self.trove:add(function()
					table.insert(cleaned, "after the throw")
				end)
				gen4.fw.TypeTorch:onSwapOut(function()
					swappedOut = true
				end)
			end,
		}
	end)
	local ok4, err4 = start(gen4, 4)
	check("gen 4: starts", ok4, err4)
	local warningsBefore = #warnings
	local stopErr = catch(gen4.stop, { reason = "deploy" })
	realTask.wait()
	check("a throwing cleanup: the stop doesn't throw", stopErr == nil, stopErr)
	check("a throwing cleanup: onSwapOut ran first", swappedOut)
	check("a throwing cleanup: the rest of that module's trove is cleaned", table.find(cleaned, "flight") ~= nil and table.find(cleaned, "after the throw") ~= nil, table.concat(cleaned, ", "))
	check("a throwing cleanup: the modules before it in the stop order are cleaned too", table.find(cleaned, "data") ~= nil, table.concat(cleaned, ", "))
	local warned = false
	for index = warningsBefore + 1, #warnings do
		warned = warned or (has(warnings[index], "FlightService cleanup threw") and has(warnings[index], "while cleaning"))
	end
	check("a throwing cleanup: one warning names the module and the error", warned, warnings[#warnings])
	check("a throwing cleanup: the generation still unbinds (no module is running)", #gen4.registry.runningModules == 0)
	check("a throwing cleanup: TypeTorch.module<T>() after the stop says stopped", has(catch(function()
		return gen4.fw.TypeTorch:module(ids.data)
	end), "stopped"))
end

-- Client generation: Dependency on the client, emit, invokeWithTimeout ------------------------------------------------

local me = newPlayer("Me", true)
Players.LocalPlayer = me
local cgen = newGeneration("client")
addModule(cgen, "HudController", ids.hud, {}, function()
	return {
		onStart = function(self)
			cgen.record.hud = cgen.fw.Dependency(ids.hud)
			cgen.record.dataError = catch(cgen.fw.Dependency, ids.data)
			cgen.record.vaultError = catch(cgen.fw.Dependency, ids.missingServer)
		end,
	}
end)
addModule(cgen, "DataService", ids.data, {}, function()
	return {}
end, "server")
local okC, errC = start(cgen, 1)
check("client generation: starts", okC, errC)
if okC then
	local crec = cgen.record
	check("client: Dependency<T>() returns a controller", crec.hud == running(cgen, "HudController").instance)
	check("client: a @Service is the other realm", has(crec.dataError, "DataService is a @Service: it runs on the server, not on the client"), crec.dataError)
	check("client: a server id that isn't loaded is the other realm too", has(crec.vaultError, "VaultService is a @Service: it runs on the server"), crec.vaultError)

	local network = declare(cgen)
	local heard = {}
	network.client.notify.error:on(function(text)
		table.insert(heard, "first:" .. text)
	end)
	network.client.notify.error:on(function()
		error("listener bug")
	end)
	local disconnect = network.client.notify.error:on(function(text)
		table.insert(heard, "third:" .. text)
	end)
	local sentBefore = #clientSent
	local warningsBefore = #warnings
	network.client.notify.error:emit("Not enough coins")
	check("client emit: every local on handler ran before emit returned", #heard == 2 and table.find(heard, "first:Not enough coins") ~= nil and table.find(heard, "third:Not enough coins") ~= nil, table.concat(heard, ","))
	check("client emit: no network traffic", #clientSent == sentBefore)
	local warned = false
	for index = warningsBefore + 1, #warnings do
		warned = warned or has(warnings[index], "notify.error listener threw (emit)")
	end
	check("client emit: a throwing handler is warned and the others still run", warned)
	disconnect()
	network.client.notify.error:emit("again")
	check("client emit: disconnected handlers don't run", #heard == 3)

	-- Timeouts: the per-leaf default (setNetworkLimits, read on the client) and the per-call override.
	cgen.fw.setNetworkLimits({ ["vc.spawn"] = { timeout = 0.6 } })
	local function pending(promise)
		promise:catch(function() end)
		return promise
	end
	local leafDefault = pending(network.client.vc.spawn:invoke())
	local perCallLonger = pending(network.client.vc.spawn:invokeWithTimeout(5))
	local perCallShort = pending(network.client.vc.status:invokeWithTimeout(0.5))
	local globalDefault = pending(network.client.vc.status:invoke())
	local answered = pending(network.client.vc.status:invokeWithTimeout(2, "ping"))
	local last = clientSent[#clientSent]
	check("invokeWithTimeout sends a normal request with the arguments", last[1] == "r:vc.status" and last[3] == "ping", last[1])
	clientHandler(cgen.netRuntime.RESPONSE, last[2], true, "ready")
	realTask.wait(0.3)
	local answeredOk, answeredValue = answered:await()
	check("invokeWithTimeout: an answer in time resolves", answeredOk and answeredValue == "ready", answeredValue)
	check("before any timeout every other request is pending", leafDefault:getStatus() == "Started" and perCallShort:getStatus() == "Started")
	realTask.wait(0.5)
	local _, reason = leafDefault:await()
	check("the leaf's timeout (0.6 s) applies to invoke", leafDefault:getStatus() == "Rejected" and reason == "The server didn't answer in time.", reason)
	check("invokeWithTimeout(0.5) gives up after 0.5 s", perCallShort:getStatus() == "Rejected")
	check("invokeWithTimeout(5) overrides the leaf's shorter timeout", perCallLonger:getStatus() == "Started")
	check("without a timeout a request waits the default 15 s", globalDefault:getStatus() == "Started")
	-- Bounds.
	local requestTimeout = cgen.netRuntime.requestTimeout
	local warnCount = #warnings
	check("timeout bounds: 10000 (milliseconds by mistake) is clamped to 120 s", requestTimeout("lb.update", 10000) == 120)
	check("timeout bounds: one warning per value", #warnings == warnCount + 1 and has(warnings[#warnings], "outside 0.5 to 120 s (seconds, not ms)"), warnings[#warnings])
	requestTimeout("lb.update", 10000)
	check("timeout bounds: no second warning for the same value", #warnings == warnCount + 1)
	check("timeout bounds: 0.01 is raised to 0.5 s", requestTimeout("lb.update", 0.01) == 0.5)
	check("timeout bounds: NaN is the default 15 s", requestTimeout("lb.update", 0 / 0) == 15)
	check("timeout: no setting is 15 s; a leaf's setting is used", requestTimeout("lb.update") == 15 and requestTimeout("vc.spawn") == 0.6)
	check("DEFAULT_LIMITS.timeout is 15 s", cgen.limits.DEFAULT_LIMITS.timeout == 15)

	cgen.stop()
	local stoppedClient = catch(network.client.notify.error.emit, network.client.notify.error, "x")
	check("client emit after the generation stopped: networking is gone (clear assert)", has(stoppedClient, "only available on a running client"), stoppedClient)
end

check("no errors raised in framework threads", #threadErrors == 0, threadErrors[1])
print(if failed == 0 then `test-modules: all {passed} checks passed` else `test-modules: {failed} of {passed + failed} checks failed`)
process.exit(if failed == 0 then 0 else 1)
