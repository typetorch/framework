--!nocheck
-- Two generations of a game's compiled payload under Lune, each with a fresh Reflect/Modding registry
-- (plans/01 and spike S8: the framework and its runtime ship inside every artifact; nothing is cached across swaps).
--
-- Run after building a game's payload, e.g. the template (Lune is pinned in template/rokit.toml):
--   cd ../template && bun run payload && lune run ../framework/scripts/test-generations.luau build/payload.rbxm
--
-- What it does, for each generation: mounts a fresh copy of the payload into ONE emulated VM (one require cache keyed
-- by ModuleScript and one shared _G, as on a Roblox server, where each swap mounts a new copy), imports the framework
-- through roblox-ts' RuntimeLib, requires every ModuleScript under Server/services and Client/controllers (as
-- startServer/startClient do), then checks the code @typetorch/transformer generated against that generation's
-- runtime:
--   - @Service / @Controller registered every decorated class (counted from the emitted Reflect.decorate calls);
--   - every class has its identifier in Reflect.idToObj, and its typetorch:parameters resolve to registered modules of
--     the same realm, in a dependency order without cycles (the order startServer uses);
--   - constructing the modules in that order injects each dependency instance;
--   - createNetwork registered a generated guard per client -> server leaf, and the guards accept and reject;
--   - generation 2's Reflect, registry and classes are new, and generation 1's are untouched.
-- It doesn't run onInit/onStart (that needs a real place: Studio or a live server). This is not Roblox: a small
-- Instance emulator for the payload tree, and inert stand-ins for services and datatypes Lune lacks.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local task = require("@lune/task")

local passed, failed = 0, 0
local function check(label: string, condition: any, detail: any?)
	if condition then
		passed += 1
	else
		failed += 1
		print(`FAIL  {label}{if detail ~= nil then ": " .. tostring(detail) else ""}`)
	end
end

-- Payload tree emulator ----------------------------------------------------------------------------------------------

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
function Node.GetAttribute(self, name: string)
	return inner[self].attributes[name]
end

local function convert(instance, parent)
	local isSource = instance:IsA("LuaSourceContainer")
	local node = setmetatable({}, nodeMeta)
	inner[node] = {
		ClassName = instance.ClassName,
		Name = instance.Name,
		Source = if isSource then instance.Source else nil,
		Parent = parent,
		children = {},
		attributes = instance:GetAttributes(),
	}
	if parent then
		table.insert(inner[parent].children, node)
	end
	for _, child in instance:GetChildren() do
		convert(child, node)
	end
	return node
end

-- Inert stand-ins --------------------------------------------------------------------------------------------------
-- Module top-level code reads services and builds constants; anything Lune lacks becomes an inert value that can be
-- indexed, called and assigned to. Nothing here runs game logic.

local function inert(name: string)
	local value = {}
	return setmetatable(value, {
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

local function signal(name: string)
	return {
		Connect = function()
			return { Disconnect = function() end, Connected = true }
		end,
		Once = function()
			return { Disconnect = function() end, Connected = true }
		end,
		Wait = function() end,
		_name = name,
	}
end

local services = {
	RunService = setmetatable({
		IsRunning = function() return false end,
		IsStudio = function() return false end,
		IsServer = function() return true end,
		IsClient = function() return false end,
		IsEdit = function() return false end,
		Heartbeat = signal("Heartbeat"),
		Stepped = signal("Stepped"),
		PreSimulation = signal("PreSimulation"),
		RenderStepped = signal("RenderStepped"),
	}, { __index = function(_, key) return inert(`RunService.{key}`) end }),
}
local game = setmetatable({
	GetService = function(_, name: string)
		services[name] = services[name] or inert(name)
		return services[name]
	end,
	IsLoaded = function() return true end,
	Loaded = signal("Loaded"),
}, { __index = function(_, key) return inert(`game.{key}`) end })

local function inertClass(name: string)
	return { new = function() return inert(`{name}.new()`) end }
end

local G = {} -- the VM's shared _G: roblox-ts keeps per-ModuleScript runtime pointers in it
local cache = {} -- ModuleScript -> { value }: require caches per instance for the VM's lifetime, as on Roblox
local loading = {}
local globals = {
	game = game,
	workspace = game:GetService("Workspace"),
	Workspace = game:GetService("Workspace"),
	_G = G,
	shared = {},
	task = task,
	tick = os.clock,
	time = os.clock,
	elapsedTime = os.clock,
	wait = task.wait,
	delay = task.delay,
	spawn = task.spawn,
	settings = function() return inert("settings()") end,
	UserSettings = function() return inert("UserSettings()") end,
	version = function() return "0.0.0" end,
	Enum = roblox.Enum,
	Instance = inertClass("Instance"),
	Random = { new = function() return { NextNumber = function(_, a, b) return (a or 0) + math.random() * ((b or 1) - (a or 0)) end, NextInteger = function(_, a, b) return math.random(a, b) end } end },
	TweenInfo = inertClass("TweenInfo"),
	RaycastParams = inertClass("RaycastParams"),
	OverlapParams = inertClass("OverlapParams"),
	DateTime = { now = function() return { UnixTimestamp = os.time(), UnixTimestampMillis = os.time() * 1000 } end, fromUnixTimestamp = function(seconds) return { UnixTimestamp = seconds } end },
	SharedTable = inertClass("SharedTable"),
	PathWaypoint = inertClass("PathWaypoint"),
	CatalogSearchParams = inertClass("CatalogSearchParams"),
	DockWidgetPluginGuiInfo = inertClass("DockWidgetPluginGuiInfo"),
}
for _, name in {
	"Axes", "BrickColor", "CFrame", "Color3", "ColorSequence", "ColorSequenceKeypoint", "Content", "Faces", "Font",
	"NumberRange", "NumberSequence", "NumberSequenceKeypoint", "PhysicalProperties", "Ray", "Rect", "Region3",
	"Region3int16", "UDim", "UDim2", "Vector2", "Vector2int16", "Vector3", "Vector3int16",
} do
	globals[name] = roblox[name] or inertClass(name)
end

--- Luau require-by-string (packages such as @rbxts/charm use it): "@self/x" is relative to the script, "./x" to its
--- parent, "../x" to its grandparent.
local function resolvePath(script, path: string)
	local segments = string.split(path, "/")
	local base
	if segments[1] == "@self" then
		base = script
	elseif segments[1] == "." then
		base = inner[script].Parent
	elseif segments[1] == ".." then
		base = inner[inner[script].Parent].Parent
	else
		error(`unsupported require path "{path}" in {script:GetFullName()}`)
	end
	for index = 2, #segments do
		local segment = string.gsub(segments[index], "%.luau?$", "")
		base = if segment == ".." then inner[base].Parent else base:WaitForChild(segment)
	end
	return base
end

local requireModule
local function requireFrom(script)
	return function(target)
		if type(target) == "string" then
			target = resolvePath(script, target)
		end
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
	local environment = table.clone(globals)
	environment.script = module
	environment.require = requireFrom(module)
	local chunk = luau.load(module.Source, { debugName = module:GetFullName(), environment = environment })
	local value = chunk()
	loading[module] = nil
	cache[module] = { value = value }
	return value
end

-- One generation -----------------------------------------------------------------------------------------------------

local path = process.args[1] or "build/payload.rbxm"
local bytes = fs.readFile(path)

--- Decorated classes in the emitted code of a realm's folder, by decorator.
local function countDecorated(folder, decorator: string)
	local count = 0
	for _, module in folder:GetDescendants() do
		if module.ClassName == "ModuleScript" then
			for _ in string.gmatch(module.Source, `Reflect%.decorate%(%w+, "@typetorch/framework:decorators@{decorator}"`) do
				count += 1
			end
		end
	end
	return count
end

local function requireAll(folder)
	for _, module in folder:GetDescendants() do
		if module.ClassName == "ModuleScript" then
			requireModule(module)
		end
	end
end

--- The order startServer/startClient use: dependencies first, loadOrder then name break ties; errors on a cycle.
local function order(Reflect, modules)
	local byCtor = {}
	for _, mod in modules do
		byCtor[mod.ctor] = mod
	end
	local sorted = table.clone(modules)
	table.sort(sorted, function(a, b)
		local orderA, orderB = a.config.loadOrder or 0, b.config.loadOrder or 0
		if orderA ~= orderB then
			return orderA < orderB
		end
		return tostring(a.ctor) < tostring(b.ctor)
	end)
	local result, state = {}, {}
	local function visit(mod, trail)
		if state[mod.ctor] == "done" then
			return
		end
		if state[mod.ctor] == "visiting" then
			error(`dependency cycle: {table.concat(trail, " -> ")} -> {tostring(mod.ctor)}`)
		end
		state[mod.ctor] = "visiting"
		local ids = Reflect.getOwnMetadata(mod.ctor, "typetorch:parameters") or {}
		mod.dependencies = {}
		for _, id in ids do
			local dependency = Reflect.idToObj[id]
			assert(dependency, `{tostring(mod.ctor)} needs {id}, which is not a loaded @Service/@Controller`)
			local dependencyModule = byCtor[dependency]
			assert(dependencyModule, `{tostring(mod.ctor)} needs {tostring(dependency)}, which runs on the other realm`)
			table.insert(mod.dependencies, dependency)
			local nextTrail = table.clone(trail)
			table.insert(nextTrail, tostring(mod.ctor))
			visit(dependencyModule, nextTrail)
		end
		state[mod.ctor] = "done"
		table.insert(result, mod)
	end
	for _, mod in sorted do
		visit(mod, {})
	end
	return result
end

local function boot(index: number)
	local model = convert(roblox.deserializeModel(bytes)[1], nil)
	inner[model].Name = `payload#{index}`
	local TS = requireModule(model.include.RuntimeLib)
	local frameworkOut = model.include.node_modules["@typetorch"].framework.out
	local framework = TS.import(model.Server, frameworkOut)
	local Reflect = TS.import(model.Server, frameworkOut, "reflection", "reflect").Reflect
	local registry = TS.import(model.Server, frameworkOut, "runtime", "registry")
	local netRuntime = TS.import(model.Server, frameworkOut, "net", "runtime")

	local label = `generation {index}`
	for _, name in { "Reflect", "Modding", "t", "Service", "Controller", "createNetwork", "startServer", "startClient" } do
		check(`{label}: @typetorch/framework exports {name}`, framework[name] ~= nil)
	end
	check(`{label}: the root's Reflect is reflection/reflect's`, framework.Reflect == Reflect)
	check(`{label}: the registry starts empty`, #registry.registered == 0 and next(Reflect.idToObj) == nil)

	requireAll(model.Server.services)
	requireAll(model.Client.controllers)

	local generation = { Reflect = Reflect, registered = registry.registered, ids = {}, instances = {} }
	local summary = {}
	for _, realm in { "server", "client" } do
		local folder = if realm == "server" then model.Server.services else model.Client.controllers
		local decorator = if realm == "server" then "Service" else "Controller"
		local expected = countDecorated(folder, decorator)
		local modules = {}
		for _, mod in registry.registered do
			if mod.realm == realm then
				table.insert(modules, mod)
			end
		end
		check(`{label}: {expected} @{decorator} classes in the emitted code`, expected > 0)
		check(`{label}: every @{decorator} class registered`, #modules == expected, `{#modules} of {expected}`)
		for _, mod in modules do
			local id = Reflect.getIdFromObject(mod.ctor)
			check(`{label}: {tostring(mod.ctor)} has an identifier`, id ~= nil and Reflect.getObjectFromId(id) == mod.ctor)
			if id then
				generation.ids[id] = mod.ctor
			end
		end

		local ok, ordered = pcall(order, Reflect, modules)
		check(`{label}: {realm} dependencies resolve, no cycles`, ok, ordered)
		if ok then
			local instances, wired, edges = {}, 0, 0
			for _, mod in ordered do
				local dependencies = {}
				for _, dependency in mod.dependencies do
					table.insert(dependencies, instances[dependency])
				end
				local built, instance = pcall(function()
					return mod.ctor.new(table.unpack(dependencies))
				end)
				check(`{label}: {tostring(mod.ctor)} constructs`, built, instance)
				if built then
					instances[mod.ctor] = instance
					generation.instances[mod.ctor] = instance
					for _, dependency in dependencies do
						edges += 1
						for _, value in instance do
							if value == dependency then
								wired += 1
								break
							end
						end
					end
				end
			end
			check(`{label}: {realm} constructor injection wired {edges} dependencies`, wired == edges and edges > 0, `{wired} of {edges}`)
			table.insert(summary, `{#modules} {realm} modules ({edges} injected)`)
		end
	end

	local guards = netRuntime.registeredGuards
	local count = 0
	for _ in guards do
		count += 1
	end
	check(`{label}: createNetwork registered generated guards`, count > 0, `{count} guards`)
	print(`{label}: {table.concat(summary, ", ")}, {count} client -> server guards`)
	local collect, hit = guards["coins.collect"], guards["rush.hit"]
	if collect and hit then
		check(`{label}: coins.collect guard accepts ("coin-3") and rejects (3)`, collect({ "coin-3" }) and not collect({ 3 }))
		check(`{label}: rush.hit guard accepts (1, "click") and rejects (1, "kick")`, hit({ 1, "click" }) and not hit({ 1, "kick" }))
	end
	return generation
end

-- Two generations in one VM ---------------------------------------------------------------------------------------------

local generations = {}
for index = 1, 2 do
	local ok, result = pcall(boot, index)
	check(`generation {index} boots`, ok, result)
	if not ok then
		break
	end
	generations[index] = result
end

local first, second = generations[1], generations[2]
if first and second then
	check("generation 2 has its own Reflect", first.Reflect ~= second.Reflect and first.Reflect.idToObj ~= second.Reflect.idToObj)
	check("generation 2 has its own module registry", first.registered ~= second.registered)
	local sameIds, sharedClasses, firstCount = true, 0, 0
	for id, ctor in first.ids do
		firstCount += 1
		if second.ids[id] == nil then
			sameIds = false
		elseif second.ids[id] == ctor then
			sharedClasses += 1
		end
	end
	check("both generations register the same ids", sameIds and firstCount > 0)
	check("no class object is shared between generations", sharedClasses == 0, `{sharedClasses} shared`)
	local stillFirst = 0
	for id, ctor in first.Reflect.idToObj do
		if first.ids[id] == ctor then
			stillFirst += 1
		end
	end
	check("generation 1's registry is untouched by generation 2", stillFirst == firstCount and #first.registered == #second.registered, `{stillFirst} of {firstCount}`)
end

-- Lifecycle under startServer (kernel 0.3.2, plans/12 P-F1) ---------------------------------------------------------
-- A third copy of the payload runs the real startServer with stub kernels and one injected module whose onStart
-- throws: a 0.3.2 kernel gets reportError (the kernel rolls the server back inside its health window; nothing is raised
-- in the module's thread), an older kernel (no reportError, or one that refuses it) gets the error raised as before, and
-- onClose runs every module's onStop on a real shutdown.

local threadErrors = {}
-- The payload's task library: errors in spawned threads are recorded instead of printed.
local recordingTask = table.clone(task)
recordingTask.spawn = function(fn, ...)
	if type(fn) == "thread" then
		return task.spawn(fn, ...)
	end
	return task.spawn(function(...)
		local ok, err = pcall(fn, ...)
		if not ok then
			table.insert(threadErrors, tostring(err))
		end
	end, ...)
end

local function lifecycle(label: string, extras)
	local savedTask = globals.task
	globals.task = recordingTask
	table.clear(threadErrors)
	local model = convert(roblox.deserializeModel(bytes)[1], nil)
	inner[model].Name = `payload#{label}`
	local TS = requireModule(model.include.RuntimeLib)
	local frameworkOut = model.include.node_modules["@typetorch"].framework.out
	local framework = TS.import(model.Server, frameworkOut)
	local registry = TS.import(model.Server, frameworkOut, "runtime", "registry")
	local calls = { onStart = 0, onStop = 0, fineStarted = 0, reports = {} }
	local Broken = setmetatable({}, {
		__tostring = function()
			return "BrokenService"
		end,
	})
	Broken.__index = Broken
	function Broken.new()
		return setmetatable({}, Broken)
	end
	function Broken:onStart()
		calls.onStart += 1
		error("attempt to index nil with 'price'")
	end
	function Broken:onStop()
		calls.onStop += 1
	end
	local Fine = setmetatable({}, {
		__tostring = function()
			return "FineService"
		end,
	})
	Fine.__index = Fine
	function Fine.new()
		return setmetatable({}, Fine)
	end
	function Fine:onStart()
		calls.fineStarted += 1
	end
	table.insert(registry.registered, { ctor = Broken, realm = "server", config = {} })
	table.insert(registry.registered, { ctor = Fine, realm = "server", config = {} })
	local store = {}
	local kernel = {
		kernelApi = 1,
		kernelVersion = "0.3.2",
		artifact = { id = `lifecycle-{label}` },
		generation = 3,
		branch = "dev",
		channel = "dev",
		serverType = "reserved",
		persist = function(_, key, init)
			store[key] = store[key] or init()
			return store[key]
		end,
		onMessage = function() end,
		send = function() end,
		broadcast = function() end,
		sendUnreliable = function() end,
		broadcastUnreliable = function() end,
		isDev = function()
			return false
		end,
		devInfo = function()
			return { dev = false, reason = "none" }
		end,
		logs = function()
			return {}
		end,
	}
	for key, value in extras(calls) do
		kernel[key] = value
	end
	local ok, stop = pcall(framework.startServer, kernel, { modules = {}, devtools = false })
	task.wait(0.1)
	globals.task = savedTask
	return ok, stop, calls, table.clone(threadErrors), kernel
end

do
	local closeHandler = nil
	local ok, stop, calls, errors = lifecycle("report", function(calls)
		return {
			reportError = function(_, info)
				table.insert(calls.reports, info)
				return true
			end,
			onClose = function(_, fn)
				closeHandler = fn
			end,
		}
	end)
	check("lifecycle: startServer runs with a 0.3.2 stub kernel", ok, stop)
	local report = calls.reports[1]
	check("lifecycle: a throwing onStart is reported to the kernel (kind onStart, module, traceback)", #calls.reports == 1 and report.kind == "onStart" and report.module == "BrokenService" and string.find(report.message, "index nil with 'price'", 1, true) ~= nil, report and report.message)
	check("lifecycle: nothing is raised in the module's thread when the kernel took it", #errors == 0, errors[1])
	check("lifecycle: the other modules start", calls.onStart == 1 and calls.fineStarted == 1)
	check("lifecycle: onClose is registered and runs every module's onStop", typeof(closeHandler) == "function" and pcall(closeHandler) and calls.onStop == 1)
	if ok then
		pcall(stop)
		check("lifecycle: the stop after a close doesn't run onStop twice", calls.onStop == 1)
	end
end

do
	local ok, stop, calls, errors = lifecycle("old-kernel", function()
		return {}
	end)
	check("lifecycle: an older kernel (no reportError) gets the error raised as before", ok and #errors == 1 and string.find(errors[1], "BrokenService.onStart failed", 1, true) ~= nil and string.find(errors[1], "index nil with 'price'", 1, true) ~= nil, errors[1] or stop)
	check("lifecycle: no onClose on older kernels, and nothing breaks", ok and calls.fineStarted == 1)
end

do
	local ok, _, _, errors = lifecycle("refused", function()
		return {
			reportError = function()
				return false -- the generation is stopping
			end,
		}
	end)
	check("lifecycle: a report the kernel refuses is raised in the module's thread", ok and #errors == 1, errors[1])
end

-- Health lines (kernel 0.3.2, devtools/health.ts) and the single heartbeat writer (devtools/admin-server.ts).
do
	local model = convert(roblox.deserializeModel(bytes)[1], nil)
	inner[model].Name = "payload#health"
	local TS = requireModule(model.include.RuntimeLib)
	local frameworkOut = model.include.node_modules["@typetorch"].framework.out
	local health = TS.import(model.Server, frameworkOut, "devtools", "health")
	local admin = TS.import(model.Server, frameworkOut, "devtools", "admin-server")
	local function titles(status)
		local list = {}
		for _, issue in health.checkHealth(status) do
			list[issue.title] = issue.level
		end
		return list
	end
	local base = { kernelApi = 1, kernelVersion = "0.3.2", serverType = "public", generation = { name = "x#1" }, history = {}, memoryMb = 1 }
	local function with(fields)
		local status = table.clone(base)
		for key, value in fields do
			status[key] = value
		end
		return status
	end
	check("health: LATEST_KERNEL is 0.3.2", health.LATEST_KERNEL == "0.3.2")
	local old = titles(with({ kernelVersion = "0.3.1" }))
	check("health: a 0.3.1 server: Kernel update (warn) and No deploy reports (info)", old["Kernel update"] == "warn" and old["No deploy reports"] == "info")
	local studio = titles(with({ kernelVersion = "0.3.1", serverType = "studio" }))
	check("health: no report line in Studio", studio["No deploy reports"] == nil)
	local ok = titles(with({ heartbeat = { enabled = true, heartbeat = { failing = false }, reports = { failing = false } }, health = { state = "ok", errors = 0 } }))
	check("health: a healthy 0.3.2 server has no deploy issue", next(ok) == nil, next(ok))
	local missing = titles(with({ heartbeat = { enabled = false, missing = true } }))
	check("health: Reports module not mapped: warn", missing["No deploy reports"] == "warn")
	local failing = titles(with({ heartbeat = { enabled = true, heartbeat = { failing = true, lastError = "throttled" }, reports = { failing = true, lastError = "throttled" } } }))
	check("health: failing heartbeat and report writes: warn", failing["Heartbeat failing"] == "warn" and failing["Reports failing"] == "warn")
	local rolled = titles(with({ heartbeat = { enabled = true }, health = { state = "degraded", errors = 0, lastRollback = { from = "g-1", why = "3 errors", at = os.time() } } }))
	check("health: a recent health-window rollback: error", rolled["Failed health check"] == "error")
	local degraded = titles(with({ heartbeat = { enabled = true }, health = { state = "degraded", errors = 4, lastError = "boom" } }))
	check("health: errors after the window: warn", degraded["Errors 4"] == "warn")
	local clients = titles(with({ heartbeat = { enabled = true }, clients = { players = 3, reported = 3, ok = 2, failed = 1, behind = 1, failures = 1, lastFailure = { userId = 1, generation = "x#1", error = "boom", at = 0 } } }))
	check("health: a client's failed generation: warn", clients["Clients failed 1"] == "warn")
	check("admin: kernel 0.3.2 owns the heartbeat (feature-detected)", admin.kernelOwnsHeartbeat({ heartbeat = function() end }) == true and admin.kernelOwnsHeartbeat({}) == false)
end

print(if failed == 0 then `test-generations: all {passed} checks passed` else `test-generations: {failed} of {passed + failed} checks failed`)
process.exit(if failed == 0 then 0 else 1)
