--!nocheck
-- Two generations of a game's compiled payload under Lune, each with a fresh Reflect/Modding registry
-- (plans/01 and spike S8: the framework and its runtime ship inside every artifact; nothing is cached across swaps).
--
-- Run after building a game's payload, e.g. the template (Lune is pinned in template/rokit.toml):
--   cd ../template && bun run payload && lune run ../framework/scripts/test-generations.luau build/payload.rbxm
--
-- The payload must carry THIS framework's build (out/, from `bun run build`). The script compares the payload's copy
-- of the framework with out/ file by file before any check, and stops on a stale fixture with the commands that
-- rebuild it (template: `bun run packages`, which builds and packs this checkout, then `bun run payload`).
-- `--any-framework` runs the checks on another game's payload anyway.
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
local serde = require("@lune/serde")
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

local path = "build/payload.rbxm"
local anyFramework = false
for _, arg in process.args do
	if arg == "--any-framework" then
		anyFramework = true
	elseif string.sub(arg, 1, 2) ~= "--" then
		path = arg
	end
end
local bytes = fs.readFile(path)

-- A stale fixture fails these checks for the wrong reason, or passes them by luck (2026-10-06: "LATEST_KERNEL is
-- 0.3.5" failed against a template payload built before framework 0139b44). So first: the payload's framework copy
-- (include/node_modules/@typetorch/framework/out) must equal this checkout's out/, file by file.
do
	local scriptDir = string.match(debug.info(1, "s"), "^(.*)[/\\][^/\\]+$") or "."
	local outDir = `{scriptDir}/../out`
	local copy = roblox.deserializeModel(bytes)[1]
	for _, name in { "include", "node_modules", "@typetorch", "framework", "out" } do
		copy = if copy then copy:FindFirstChild(name) else nil
	end
	local problem, files = nil, 0
	if not fs.isDir(outDir) then
		problem = `{outDir} doesn't exist (run \`bun run build\` in the framework)`
	elseif not copy then
		problem = "it has no include/node_modules/@typetorch/framework/out"
	else
		local function walk(dir: string, node, relative: string)
			for _, name in fs.readDir(dir) do
				local full = `{dir}/{name}`
				if problem then
					return
				elseif fs.isDir(full) then
					walk(full, if node then node:FindFirstChild(name) else nil, `{relative}{name}/`)
				elseif string.sub(name, -5) == ".luau" then
					files += 1
					local module = if node == nil then nil elseif name == "init.luau" then node else node:FindFirstChild(string.sub(name, 1, -6))
					if module == nil or module.ClassName ~= "ModuleScript" then
						problem = `out/{relative}{name} is missing from it`
					elseif module.Source ~= fs.readFile(full) then
						problem = `out/{relative}{name} differs`
					end
				end
			end
		end
		walk(outDir, copy, "")
		local modules = if copy.ClassName == "ModuleScript" then 1 else 0
		for _, descendant in copy:GetDescendants() do
			if descendant.ClassName == "ModuleScript" then
				modules += 1
			end
		end
		if not problem and modules ~= files then
			problem = `it has {modules} framework modules, out/ has {files}`
		end
	end
	if problem then
		local message = `{path} doesn't carry this framework's build: {problem}.\n      Rebuild it: in the template, \`bun run packages\` (builds and packs this checkout), then \`bun run payload\`.`
		if not anyFramework then
			print(`FAIL  stale fixture: {message}\n      (--any-framework runs the checks on another game's payload anyway)`)
			process.exit(1)
		end
		print(`WARN  --any-framework: {message}`)
	end
end

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

-- Health lines (kernel 0.3.2, devtools/health.ts) and the fleet-status feature test (devtools/admin-server.ts).
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
	local base = { kernelApi = 1, kernelVersion = "0.3.7", serverType = "public", generation = { name = "x#1" }, history = {}, memoryMb = 1 }
	local function with(fields)
		local status = table.clone(base)
		for key, value in fields do
			status[key] = value
		end
		return status
	end
	check("health: LATEST_KERNEL is 0.3.7", health.LATEST_KERNEL == "0.3.7")
	local old = titles(with({ kernelVersion = "0.3.1" }))
	check("health: a 0.3.1 server: Kernel update (warn) and No deploy reports (info)", old["Kernel update"] == "warn" and old["No deploy reports"] == "info")
	local studio = titles(with({ kernelVersion = "0.3.1", serverType = "studio" }))
	check("health: no report line in Studio", studio["No deploy reports"] == nil)
	local ok = titles(with({ reports = { total = 1, kept = 1, listeners = 1 }, fleet = { enabled = true, settings = "ok", lastOkAt = 10 }, health = { state = "ok", errors = 0 } }))
	check("health: a healthy 0.3.2 server has no deploy issue", next(ok) == nil, next(ok))
	local missing = titles(with({ reports = { total = 0, kept = 0, listeners = 0 }, fleet = { enabled = false, missing = true } }))
	check("health: the kernel's Fleet module not mapped: warn", missing["No fleet API"] == "warn")
	local invalid = titles(with({ reports = { total = 0, kept = 0, listeners = 0 }, fleet = { enabled = false, settings = "invalid", settingsError = "url must be https://host[/path]" } }))
	check("health: invalid TypeTorchFleet: warn", invalid["Fleet settings"] == "warn")
	local failing = titles(with({ reports = { total = 0, kept = 0, listeners = 0 }, fleet = { enabled = true, settings = "ok", lastOkAt = 5, lastErrorAt = 10, lastError = "HTTP 503" } }))
	local recovered = titles(with({ reports = { total = 0, kept = 0, listeners = 0 }, fleet = { enabled = true, settings = "ok", lastOkAt = 12, lastErrorAt = 10, lastError = "HTTP 503" } }))
	check("health: the fleet API failing (and not after it recovered): warn", failing["Fleet API failing"] == "warn" and recovered["Fleet API failing"] == nil)
	local absent = titles(with({ reports = { total = 0, kept = 0, listeners = 0 }, fleet = { enabled = false, settings = "absent" } }))
	check("health: no TypeTorchFleet setting: no line", next(absent) == nil, next(absent))
	local rolled = titles(with({ reports = { total = 1, kept = 1, listeners = 1 }, health = { state = "degraded", errors = 0, lastRollback = { from = "g-1", why = "3 errors", at = os.time() } } }))
	check("health: a recent health-window rollback: error", rolled["Failed health check"] == "error")
	local degraded = titles(with({ reports = { total = 1, kept = 1, listeners = 1 }, health = { state = "degraded", errors = 4, lastError = "boom" } }))
	check("health: errors after the window: warn", degraded["Errors 4"] == "warn")
	local clients = titles(with({ reports = { total = 1, kept = 1, listeners = 1 }, clients = { players = 3, reported = 3, ok = 2, failed = 1, behind = 1, failures = 1, lastFailure = { userId = 1, generation = "x#1", error = "boom", at = 0 } } }))
	check("health: a client's failed generation: warn", clients["Clients failed 1"] == "warn")
	-- Kernel 0.3.6 (never an empty server): the backup build and the moves are flagged like the boot fail-safe.
	local fallback = { hold = { active = false, spawned = 0 }, backup = { available = true, artifactId = "b-1", at = "2026-10-06T10:00:00Z", runs = 1 }, peers = { asks = 1, answered = 0, replies = 0, refused = 0 }, chain = { runs = 1, result = "backup" }, recovery = { running = true, attempts = 2 }, moving = { active = false, teleported = 0, kicked = 0, failures = 0 }, clients = { resent = 0, moved = 0 } }
	local backup = titles(with({ reports = { total = 1, kept = 1, listeners = 1 }, backup = true, fallback = fallback }))
	check("health: the backup build runs: error", backup["Running the backup build"] == "error")
	local movingFallback = table.clone(fallback)
	movingFallback.moving = { active = true, teleported = 3, kicked = 0, failures = 0 }
	movingFallback.backup = { available = false, runs = 0, failed = { error = "mount: holds a Script", stage = "mount", at = 0 } }
	local moving = titles(with({ reports = { total = 1, kept = 1, listeners = 1 }, fallback = movingFallback, clients = { players = 1, reported = 1, ok = 1, failed = 0, behind = 0, failures = 0, moved = 2 } }))
	check("health: moving players out: error; the backup failed: warn; clients moved: warn", moving["Moving players out"] == "error" and moving["Backup build failed"] == "warn" and moving["Clients moved 2"] == "warn")
	-- Kernel 0.3.7: the live health window (the build's own thresholds) while it is open, and the thresholds line.
	local reports = { total = 1, kept = 1, listeners = 1 }
	local open = health.checkHealth(with({ reports = reports, health = { state = "ok", errors = 0, limit = 5, window = 60, rollback = true, source = "payload", windowLeft = 42 } }))
	check("health: the open window is one info line: errors against the build's limit, time left", #open == 1 and open[1].title == "Health window" and open[1].level == "info" and open[1].detail == "0/5 errors, 42 s left", open[1] and open[1].detail)
	local counting = health.checkHealth(with({ reports = reports, health = { state = "ok", errors = 2, limit = 5, window = 60, rollback = true, windowLeft = 10 } }))
	check("health: an error inside the window turns it into a warning", #counting == 1 and counting[1].level == "warn" and counting[1].detail == "2/5 errors, 10 s left", counting[1] and counting[1].detail)
	local keptStatus = with({ reports = reports, health = { state = "degraded", errors = 4, limit = 3, window = 30, rollback = false, windowLeft = 12, kept = "4 errors" } })
	local kept = titles(keptStatus)
	local keptIssue = health.checkHealth(keptStatus)[1]
	check("health: rollback off: the window line says so, no separate Errors line while it is open", kept["Health window"] == "warn" and kept["Errors 4"] == nil and keptIssue.detail == "4/3 errors, 12 s left, no rollback", keptIssue and keptIssue.detail)
	local olderKernel = health.checkHealth(with({ reports = reports, health = { state = "ok", errors = 1, windowLeft = 20 } }))
	check("health: no thresholds in status (kernels before 0.3.7): their fixed limit of 3", #olderKernel == 1 and olderKernel[1].detail == "1/3 errors, 20 s left", olderKernel[1] and olderKernel[1].detail)
	local closed = titles(with({ reports = reports, health = { state = "ok", errors = 0, limit = 5, window = 60, rollback = true } }))
	check("health: no line once the window closed", next(closed) == nil, next(closed))
	local badSettings = titles(with({ reports = reports, health = { state = "ok", errors = 0, limit = 3, window = 30, rollback = true, source = "default", invalid = { "HealthErrors 500 (a whole number 1-100)" } } }))
	check("health: payload settings out of bounds: warn", badSettings["Health settings"] == "warn")
	local noModule = titles(with({ reports = reports, health = { state = "ok", errors = 0, missing = true } }))
	check("health: the kernel's Health module not mapped: warn", noModule["No health window"] == "warn")
	check(
		"health: the Status block's thresholds line",
		health.healthLimitsText({ state = "ok", errors = 0, limit = 5, window = 60, rollback = true }) == "5 errors / 60 s"
			and health.healthLimitsText({ state = "ok", errors = 0, limit = 3, window = 30, rollback = false }) == "3 errors / 30 s, no rollback"
			and health.healthLimitsText({ state = "ok", errors = 0 }) == "3 errors / 30 s"
	)
	check("admin: kernel 0.3.2 fleetStatus is feature-detected", admin.kernelHasFleetStatus({ fleetStatus = function() end }) == true and admin.kernelHasFleetStatus({}) == false)
	-- Kernel 0.3.4: a switched server is an ordinary server: no Attention line, no "Back" action.
	local switchedIssues = health.checkHealth(with({ reports = { total = 1, kept = 1, listeners = 1 }, switched = { by = 1, name = "Owner", at = 10, branch = "dev" } }))
	check("health: a switched server has no Attention line", #switchedIssues == 0 and health.overrideIssue == nil, switchedIssues[1])
end

-- Branch tab and "Load a build" (framework 0.3.1, devtools/build-actions.ts): the words and the rules both UIs use.
do
	local model = convert(roblox.deserializeModel(bytes)[1], nil)
	inner[model].Name = "payload#build-actions"
	local TS = requireModule(model.include.RuntimeLib)
	local frameworkOut = model.include.node_modules["@typetorch"].framework.out
	local actions = TS.import(model.Server, frameworkOut, "devtools", "build-actions")
	local ab = TS.import(model.Server, frameworkOut, "devtools", "ab")
	local function ctx(fields)
		local value = { serverType = "public", signedOnly = true, isOwner = true, switchKernel = true, experiments = true }
		for key, field in fields do
			value[key] = field
		end
		return value
	end
	-- Branches: owners switch a public (prod) server; everyone else joins; private servers keep their stored switch; the
	-- current branch has no button.
	check("build-actions: an owner on a public prod server: Switch", actions.branchAction(ctx({}), false) == "here" and actions.branchLabel("here") == "Switch")
	check("build-actions: the current branch: no button", actions.branchAction(ctx({}), true) == nil)
	check("build-actions: a non-owner on a public server: Join", actions.branchAction(ctx({ isOwner = false }), false) == "join" and actions.branchLabel("join") == "Join")
	check("build-actions: an older kernel on a public server: Join (moves only you)", actions.branchAction(ctx({ switchKernel = false }), false) == "join")
	check("build-actions: a reserved server keeps its stored switch", actions.branchAction(ctx({ serverType = "reserved", signedOnly = false }), false) == "stored")
	-- Builds: Load here on public and prod servers (0.3.4, the owner's own pin); the CLI note only on older kernels.
	local build = { running = false, channel = "dev" }
	check("build-actions: an owner on a prod server: Load here", actions.buildAction(ctx({}), build) == "here" and actions.buildLabel("here") == "Load here")
	check("build-actions: a signed-only private server: Load here too", actions.buildAction(ctx({ serverType = "private" }), build) == "here")
	check("build-actions: the running build: no button", actions.buildAction(ctx({}), { running = true, channel = "prod" }) == nil)
	check("build-actions: a non-owner on a public server: Join", actions.buildAction(ctx({ isOwner = false }), build) == "join" and actions.buildLabel("join") == "Join")
	check("build-actions: no 'Use the CLI' note on kernel 0.3.4", actions.showCliNote(ctx({})) == false and actions.showCliNote(ctx({ isOwner = false, serverType = "private" })) == false)
	check("build-actions: an older kernel on a prod server: no button, the CLI note", actions.buildAction(ctx({ switchKernel = false }), build) == nil and actions.showCliNote(ctx({ switchKernel = false })) == true)
	check("build-actions: an older kernel on a dev private server: the kernel pin", actions.buildAction(ctx({ serverType = "private", signedOnly = false, switchKernel = false }), build) == "pin")
	-- Names and lines.
	local entry = { seq = 36, commit = "4363e8c", assetId = 1, branch = "dev", live = true, running = false }
	check("build-actions: '#36  4363e8c' and 'dev · 3h ago'", actions.buildTitle(entry) == "#36  4363e8c" and actions.buildDetail(entry, 3 * 3600 + 5) == "dev · 3h ago" and actions.buildName(entry) == "#36")
	check("build-actions: one badge, Running here over Live", actions.buildBadge(entry) == "Live" and actions.buildBadge({ assetId = 1, branch = "dev", live = true, running = true }) == "Running here" and actions.buildBadge({ assetId = 1, branch = "dev" }) == nil)
	check("build-actions: the button says the action", actions.loadButtonLabel({ where = "here" }) == "Load here" and actions.loadButtonLabel({ where = "selected", selected = 2 }) == "Load on 2 servers" and actions.loadButtonLabel({ where = "selected", selected = 1 }) == "Load on 1 server" and actions.loadButtonLabel({ where = "share", pct = 10 }) == "Load on 10%")
	local jobs = {}
	for i = 1, 40 do
		table.insert(jobs, `job-{i}`)
	end
	local reached = 0
	for _, jobId in jobs do
		if ab.jobBucket(jobId) < 25 then
			reached += 1
		end
	end
	local summary = actions.loadSummary(entry, { where = "share", pct = 25, branch = "dev", branchJobs = jobs })
	check("build-actions: the share summary counts the servers the percent reaches (jobBucket)", summary == `Load #36 on 25% of dev servers (about {reached} of 40)` and actions.shareCount(25, jobs) == reached, summary)
	check("build-actions: the here summary", actions.loadSummary(entry, { where = "here", players = 1 }) == "Load #36 here (1 player)")
	-- (roblox-ts returns a tuple type as one array.)
	local loading = actions.loadProgress("#36", 1, 0, false)
	local finished = actions.loadProgress("#36", 1, 1, false)
	local partial = actions.loadProgress("#36", 2, 1, true)
	check("build-actions: the status line: Loading, Done, and failures", loading[1] == "Loading #36 on 1 server" and not loading[2] and not loading[3] and finished[1] == "Done: 1 switched" and finished[2] and not finished[3] and partial[1] == "1 of 2 switched" and partial[2] and partial[3])
	-- Owners only, and no admins: an older kernel's "admin" is a dev. The switch is feature-detected (kernel 0.3.4).
	local function client(role, withSwitch)
		return {
			requestSwitch = if withSwitch then function() end else nil,
			devStatus = function()
				return { dev = true, role = role }
			end,
		}
	end
	local asOwner = actions.switchOffered(client("owner", true))
	local asLegacy = actions.switchOffered(client("admin", true))
	local asOld = actions.switchOffered(client("owner", false))
	check("build-actions: owners only; a legacy admin is a dev; requestSwitch is feature-detected", asOwner[1] and asOwner[2] and asLegacy[1] and not asLegacy[2] and not asOld[1] and asOld[2] and actions.viewerIsOwner(client("dev", true)) == false)
	local kernelModule = TS.import(model.Server, frameworkOut, "kernel")
	check("roles: normalRole maps owner, dev, and the old admin (to dev)", kernelModule.normalRole("owner") == "owner" and kernelModule.normalRole("admin") == "dev" and kernelModule.normalRole("dev") == "dev" and kernelModule.normalRole(nil) == nil)
	local reply = actions.requestSwitch({
		requestSwitch = function()
			error("boom")
		end,
	}, { branch = "dev" })
	check("build-actions: a failing requestSwitch is an error reply", reply.ok == false and string.find(reply.error, "boom", 1, true) ~= nil)
	local now = 1000000
	check("build-actions: 'switched by Owner 3m ago'", actions.switchedText({ name = "Owner", at = now - 185 }, now) == "switched by Owner 3m ago" and actions.switchedText({ name = "Owner", at = now - 5 }, now) == "switched by Owner just now" and actions.switchedText(nil, now) == nil)
end

-- Networking across a swap (0.2.1, plans/12 P-N1): the server queues reliable sends per player until that client's
-- generation says hello; a resync fails the client's pending requests at once.
do
	local alice = { Name = "Alice", Parent = "Players" }
	local bob = { Name = "Bob", Parent = "Players" }
	local fakePlayers = { alice, bob }
	services.Players = setmetatable({
		GetPlayers = function()
			return table.clone(fakePlayers)
		end,
	}, {
		__index = function(_, key)
			return inert(`Players.{key}`)
		end,
	})
	local model = convert(roblox.deserializeModel(bytes)[1], nil)
	inner[model].Name = "payload#net"
	local TS = requireModule(model.include.RuntimeLib)
	local frameworkOut = model.include.node_modules["@typetorch"].framework.out
	local runtime = TS.import(model.Server, frameworkOut, "net", "runtime")
	local sent, broadcasts = {}, {}
	local serverKernel = {
		send = function(_, player, channel, ...)
			table.insert(sent, { player, channel, ... })
		end,
		sendUnreliable = function(_, player, channel, ...)
			table.insert(sent, { player, channel, ... })
		end,
		broadcast = function(_, channel, ...)
			table.insert(broadcasts, { channel, ... })
		end,
		broadcastUnreliable = function(_, channel, ...)
			table.insert(broadcasts, { channel, ... })
		end,
	}
	local server = runtime.ServerDispatcher.new(serverKernel)
	server:send(alice, "coins.changed", { 5 })
	server:send(alice, "fx.puff", { 1 }, true)
	check("net: before hello a reliable send is queued and an unreliable one dropped", #sent == 0 and not server:isReady(alice))
	server.dispatch(alice, runtime.HELLO)
	check("net: hello flushes the queue in order", #sent == 1 and sent[1][1] == alice and sent[1][2] == "e:coins.changed" and sent[1][3] == 5 and server:isReady(alice))
	server:sendAll("round.start", { 3 })
	check("net: sendAll with a client not ready: per player (ready now, the other queued)", #broadcasts == 0 and #sent == 2 and sent[2][1] == alice and sent[2][2] == "e:round.start")
	server.dispatch(bob, runtime.HELLO)
	check("net: the late client gets what it missed", #sent == 3 and sent[3][1] == bob and sent[3][2] == "e:round.start" and sent[3][3] == 3)
	server:sendAll("round.end", {})
	check("net: every client ready: one broadcast", #broadcasts == 1 and broadcasts[1][1] == "e:round.end" and #sent == 3)
	server:forget(bob)
	server:send(bob, "coins.changed", { 1 })
	check("net: a player who left and came back waits for a new hello", #sent == 3 and not server:isReady(bob))

	local clientSent = {}
	local clientKernel = {
		send = function(_, channel, ...)
			table.insert(clientSent, { channel, ... })
		end,
		sendUnreliable = function() end,
	}
	local client = runtime.ClientDispatcher.new(clientKernel)
	client:hello()
	check("net: the client says hello", clientSent[1] ~= nil and clientSent[1][1] == runtime.HELLO)
	local pending = client:invoke("shop.buy", { "sword" })
	pending:catch(function() end) -- handled: the checks read its status
	check("net: a request is pending", pending:getStatus() == "Started" and clientSent[2][1] == "r:shop.buy")
	client:resync()
	check("net: a resync rejects the pending request at once", pending:getStatus() == "Rejected")
	local later = client:invoke("shop.buy", { "axe" })
	later:catch(function() end)
	check("net: and every new request until the swap", later:getStatus() == "Rejected" and #clientSent == 2)
end

-- Admin > Servers' roll call (0.2.1, devtools/roll-call.ts) over a fake MessagingService: three servers, an injected
-- clock, waits 20x shorter.
do
	local model = convert(roblox.deserializeModel(bytes)[1], nil)
	inner[model].Name = "payload#rollcall"
	local TS = requireModule(model.include.RuntimeLib)
	local frameworkOut = model.include.node_modules["@typetorch"].framework.out
	local module = TS.import(model.Server, frameworkOut, "devtools", "roll-call")
	local topics, published = {}, {}
	local clock = 100
	local function bus(jobId: string, entry)
		return {
			jobId = jobId,
			subscribe = function(topic, handler)
				topics[topic] = topics[topic] or {}
				local holder = { handler = handler }
				table.insert(topics[topic], holder)
				return {
					Disconnect = function()
						local index = table.find(topics[topic], holder)
						if index then
							table.remove(topics[topic], index)
						end
					end,
				}
			end,
			publish = function(topic, data)
				table.insert(published, { topic = topic, data = data, from = jobId })
				for _, holder in table.clone(topics[topic] or {}) do
					task.defer(holder.handler, data)
				end
			end,
			entry = entry,
			encode = function(value)
				return serde.encode("json", value)
			end,
			decode = function(text)
				return serde.decode("json", text)
			end,
			clock = function()
				return clock
			end,
			unixMs = function()
				return 1759580000000 + clock * 1000
			end,
			wait = function(seconds)
				task.wait(seconds / 20)
			end,
			spawn = function(callback)
				task.spawn(callback)
			end,
			random = math.random,
			warn = function() end,
		}
	end
	local silent = false
	local servers = {
		a = module.RollCall.new(bus("job-a", function()
			return { t = "public", b = "prod", a = "art-a", n = 1, m = 10, h = "ok", sv = 2 }
		end)),
		b = module.RollCall.new(bus("job-b", function()
			return { t = "reserved", b = "dev", a = "art-b", n = 2, m = 10, h = "degraded", k = "access-code-b", sv = 2 }
		end)),
		c = module.RollCall.new(bus("job-c", function()
			if silent then
				return nil
			end
			return { t = "public", b = "prod", a = "art-c", n = 3, m = 10, h = "failed", e = string.rep("x", 2000), k = string.rep("k", 40), sv = 2 }
		end)),
	}
	for _, server in servers do
		server:listen()
	end
	task.wait(0.05)
	local list = servers.a:ask()
	local byKey = {}
	for _, row in list.rows do
		byKey[row.key] = row.value
	end
	check("roll call: every other server answers with its row", #list.rows == 2 and byKey["job-b"] ~= nil and byKey["job-c"] ~= nil and byKey["job-a"] == nil and list.error == nil, #list.rows)
	check("roll call: rows carry the fleet status (h, k)", byKey["job-b"].h == "degraded" and byKey["job-b"].k == "access-code-b" and byKey["job-c"].h == "failed")
	check("roll call: a row too big for one message drops e (and keeps what fits)", byKey["job-c"].e == nil and byKey["job-c"].k ~= nil and byKey["job-c"].a == "art-c")
	local replyTopicsOk = true
	for _, message in published do
		if message.topic ~= module.ROLL_CALL_TOPIC then
			replyTopicsOk = replyTopicsOk and message.topic == module.replyTopic("job-a") and #message.data <= module.MAX_REPLY_BYTES
		end
	end
	check("roll call: replies go to the asker's own topic, each under 1 KiB", replyTopicsOk)
	local count = #published
	local again = servers.a:ask()
	check("roll call: cached for 15 s (no new messages)", #published == count and #again.rows == 2)
	clock += module.CACHE_SECONDS + 1
	silent = true
	local third = servers.a:ask()
	check("roll call: a silent server (shutting down) doesn't show; a new roll after the cache", #third.rows == 1 and third.rows[1].key == "job-b" and #published > count)
	-- Rate limits and stale asks: B answers A at most once per REPLY_GAP seconds, and never to an old ask.
	local before = servers.b.counters.answered
	servers.b:onAsk(serde.encode("json", { q = 1, j = "job-a", t = 1759580000000 + clock * 1000 }))
	local limited = servers.b.counters.limited
	servers.b:onAsk(serde.encode("json", { q = 2, j = "job-z", t = 1759580000000 + (clock - 120) * 1000 }))
	servers.b:onAsk("not json")
	task.wait(0.1)
	check("roll call: one reply per asker per 5 s; stale and malformed asks are ignored", servers.b.counters.answered == before and limited >= 1 and servers.b.counters.ignored >= 2)
	local studio = module.RollCall.new(bus("", function()
		return {}
	end))
	local count2 = #published
	local studioList = studio:ask()
	check("roll call: Studio (no JobId) asks nobody", #studioList.rows == 0 and #published == count2)
	for _, server in servers do
		server:stop()
	end
end

print(if failed == 0 then `test-generations: all {passed} checks passed` else `test-generations: {failed} of {passed + failed} checks failed`)
process.exit(if failed == 0 then 0 else 1)
