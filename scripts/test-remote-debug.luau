--!nocheck
-- Offline test of the framework's remote debug hook (framework 0.5.0, plans/25: out/devtools/remote-debug.luau) under
-- Lune: registerRemoteDebug installs the handler only on kernels with onRemoteDebug (0.5.0+); the handler answers the
-- six read-only ops (modules, state, assets, network, dex.children, dex.props) with the dev menu's own readers (the real
-- compiled state inspector, state roots and explorer core over Lune's DataModel); it refuses anything else, callers that
-- aren't owners, and any edit (set / attr / rename / destroy are not ops; the explorer runs with canEdit false); Dex is
-- bounded (8 nodes, 200 rows) and its ids are kept per caller; state reads are rate limited per caller.
-- Run after `bun run build`:
--   cd ../kernel && lune run ../framework/scripts/test-remote-debug.luau ../framework/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-remote-debug.luau
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local task = require("@lune/task")
local Instance = roblox.Instance
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
local function throws(label, fn, needle)
	local ok, err = pcall(fn)
	check(label, not ok and (needle == nil or string.find(tostring(err), needle, 1, true) ~= nil), if ok then "no error" else err)
end

-- A DataModel with a few instances.
local game = Instance.new("DataModel")
local workspace = game:GetService("Workspace")
game:GetService("ReplicatedStorage")
local coins = Instance.new("Folder")
coins.Name = "Coins"
coins.Parent = workspace
for i = 1, 450 do
	local part = Instance.new("Part")
	part.Name = "Coin" .. i
	part.Parent = coins
end
local target = Instance.new("Part")
target.Name = "Target"
target.Parent = workspace
target:SetAttribute("Hp", 5)

local reflection = {}
function reflection:GetClass(className)
	return { Name = className }
end
function reflection:GetPropertiesOfClass()
	return {
		{ Name = "Name", Type = { ScriptType = "string" }, Display = { Category = "Data", LayoutOrder = 1 }, Permits = { Read = {}, Write = {} } },
		{ Name = "ClassName", Type = { ScriptType = "string" }, Display = { Category = "Data", LayoutOrder = 2 }, Permits = { Read = {} } },
	}
end

-- The running generation (the registry the dev menu reads): two modules, one persist store.
local registry = {
	registered = {},
	runningModules = {
		{ name = "CoinService", dependencies = {}, loadOrder = 1, initSeconds = 0.012, instance = { coins = 42, players = { Rider = { coins = 7 } }, onStart = function() end } },
		{ name = "RoundService", dependencies = { "CoinService" }, loadOrder = 2, instance = { round = 3 } },
	},
	persistKeys = { ["game/rounds"] = { last = 3 }, remoteClaude = { refresh = "should-never-show" } },
}
local assetsReport = { at = 1, adopted = 2, loaded = 1, kept = 0 }
local PATHS = {
	["remote-debug"] = "out/devtools/remote-debug.luau",
	core = "out/devtools/explorer/core.luau",
	icons = "out/devtools/explorer/icons.luau",
	state = "out/devtools/state.luau",
	["state-inspect"] = "out/devtools/state-inspect.luau",
}
local stubs = {
	registry = registry,
	sync = { assetReport = function()
		return assetsReport
	end },
}
local env
local modules = {}
local function loadModule(name)
	if stubs[name] then
		return stubs[name]
	end
	if not modules[name] then
		local source = fs.readFile(root .. PATHS[name])
		source = string.gsub(source, 'game:GetService%("ReflectionService"%)', "__reflection")
		modules[name] = luau.load(source, { debugName = name, environment = env })()
	end
	return modules[name]
end
local script = { Parent = { Parent = {} } }
local TS = {
	import = function(_, _, ...)
		local parts = { ... }
		return loadModule(parts[#parts])
	end,
}
local clock = 100
env = setmetatable({
	game = game,
	script = script,
	_G = { [script] = TS },
	Instance = Instance,
	Vector2 = roblox.Vector2,
	Vector3 = roblox.Vector3,
	UDim = roblox.UDim,
	UDim2 = roblox.UDim2,
	Color3 = roblox.Color3,
	Enum = roblox.Enum,
	task = task,
	__reflection = reflection,
	os = setmetatable({ clock = function()
		return clock
	end }, { __index = os }),
}, { __index = _G })

local RD = loadModule("remote-debug")
local OWNER = { kind = "roblox", userId = 1001, owner = true, via = "roblox" }
local TOKEN = { kind = "token", owner = true, via = "admin token" }

-- 1. Install only where the kernel has the hook --------------------------------------------------------------------------
do
	local installed = nil
	local newKernel = { onRemoteDebug = function(_, fn)
		installed = fn
	end }
	check("registerRemoteDebug installs the handler on kernel 0.5.0+", RD.registerRemoteDebug(newKernel, {}) == true and type(installed) == "function")
	check("registerRemoteDebug leaves older kernels alone", RD.registerRemoteDebug({ kernelVersion = "0.4.0" }, {}) == false)
	check("the ops are the kernel's RD_FRAMEWORK_OPS", table.concat(RD.REMOTE_DEBUG_OPS, ",") == "modules,state,assets,network,dex.children,dex.props")
end

local stats = {}
stats["e:coins.collect"] = { inbound = 50, outbound = 2, rejected = 1, errors = 0 }
stats["r:shop.buy"] = { inbound = 3, outbound = 3, rejected = 0, errors = 1 }
local handle = RD.remoteDebugHandler({ netStats = function()
	return stats
end, clock = function()
	return clock
end })

-- 2. Owners only, read-only ops only ----------------------------------------------------------------------------------------
throws("a caller that isn't an owner is refused", function()
	handle("modules", {}, { kind = "roblox", userId = 5, owner = false })
end, "owners_only")
throws("no caller is refused", function()
	handle("modules", {}, nil)
end, "owners_only")
for _, op in { "dex.set", "dex.attr", "dex.rename", "dex.destroy", "explorer.set", "kick", "run", "state.set" } do
	throws(`no write op ({op})`, function()
		handle(op, {}, OWNER)
	end, "unknown op")
end

-- 3. modules, assets, network ---------------------------------------------------------------------------------------------
do
	local answer = handle("modules", {}, OWNER)
	check("modules: the running modules with deps, load order and init time", #answer.modules == 2 and answer.modules[1].name == "CoinService" and answer.modules[1].initMs == 12 and answer.modules[2].dependencies[1] == "CoinService")
	local persist = {}
	for _, entry in answer.state.persist do
		persist[entry.key] = true
	end
	check("modules: the persist summary hides internal stores (remote-claude tokens)", persist["game/rounds"] == true and persist.remoteClaude == nil)
	check("assets: the last hot-asset sync", handle("assets", {}, TOKEN) == assetsReport)
	local network = handle("network", {}, OWNER)
	check("network: per-remote counters, busiest first", network.supported == true and #network.remotes == 2 and network.remotes[1].path == "e:coins.collect" and network.remotes[1].rejected == 1)
end

-- 4. State: the dev menu's reader, its limits ------------------------------------------------------------------------------
do
	local list = handle("state", { queries = { { side = "server", root = "", path = {}, page = 0 } } }, OWNER)
	local tokens = {}
	for _, entry in list[1].entries do
		tokens[entry.seg] = entry
	end
	check("state: the roots are the live modules and the persist store", tokens.CoinService ~= nil and tokens.RoundService ~= nil and tokens["~persist"] ~= nil)
	local coinsState = handle("state", { queries = { { side = "server", root = "CoinService", path = {}, page = 0 } } }, OWNER)[1]
	local keys = {}
	for _, entry in coinsState.entries do
		keys[entry.key] = entry
	end
	check("state: a module's own fields (functions named, never called)", keys.coins ~= nil and keys.coins.preview == "42" and keys.onStart ~= nil and keys.onStart.preview == "function" and keys.players.expandable == true)
	local nested = handle("state", { queries = { { side = "server", root = "CoinService", path = { "splayers", "sRider" }, page = 0 } } }, OWNER)[1]
	check("state: open nested tables by path", nested.entries[1] ~= nil and nested.entries[1].key == "coins" and nested.entries[1].preview == "7")
	local persistRoot = handle("state", { queries = { { side = "server", root = "~persist", path = {}, page = 0 } } }, OWNER)[1]
	local hidden = false
	for _, entry in persistRoot.entries do
		hidden = hidden or entry.key == "remoteClaude"
	end
	check("state: internal persist stores never show", not hidden)
	throws("state: client-side queries are refused", function()
		handle("state", { queries = { { side = "client", root = "", path = {}, page = 0 } } }, OWNER)
	end, "bad_side")
	throws("state: more than 12 queries are refused", function()
		local many = {}
		for i = 1, 13 do
			many[i] = { side = "server", root = "", path = {}, page = 0 }
		end
		handle("state", { queries = many }, OWNER)
	end, "too_many")
	-- The per-caller bucket: 36, then 12 a second.
	local limited = false
	for _ = 1, 4 do
		local ok, err = pcall(handle, "state", { queries = { { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 }, { side = "server", root = "", path = {}, page = 0 } } }, OWNER)
		limited = limited or (not ok and string.find(tostring(err), "rate_limited", 1, true) ~= nil)
	end
	check("state: reads are rate limited per caller", limited)
	local other = pcall(handle, "state", { queries = { { side = "server", root = "", path = {}, page = 0 } } }, TOKEN)
	check("state: another caller has its own bucket", other == true)
	clock += 10
	check("state: the bucket refills", pcall(handle, "state", { queries = { { side = "server", root = "", path = {}, page = 0 } } }, OWNER) == true)
end

-- 5. Dex: read-only, bounded, ids per caller ------------------------------------------------------------------------------
do
	local top = handle("dex.children", { nodes = { { id = 0 } } }, OWNER)[1]
	local ws = nil
	for _, row in top.rows do
		if row.name == "Workspace" then
			ws = row
		end
	end
	check("dex.children: the root lists the services", ws ~= nil and ws.className == "Workspace" and ws.parent == 0)
	local wsPage = handle("dex.children", { nodes = { { id = ws.id } } }, OWNER)[1]
	local coinsRow = nil
	for _, row in wsPage.rows do
		if row.name == "Coins" then
			coinsRow = row
		end
	end
	local page = handle("dex.children", { nodes = { { id = coinsRow.id, limit = 5000 } } }, OWNER)[1]
	check("dex.children: at most 200 rows a node, the total says how many", #page.rows == 200 and page.total == 450)
	local second = handle("dex.children", { nodes = { { id = coinsRow.id, offset = 200 } } }, OWNER)[1]
	check("dex.children: paging with offset", #second.rows == 200 and second.offset == 200)
	throws("dex.children: at most 8 nodes a call", function()
		local nodes = {}
		for i = 1, 9 do
			nodes[i] = { id = 0 }
		end
		handle("dex.children", { nodes = nodes }, OWNER)
	end, "at most 8 nodes")
	local targetRow = nil
	for _, row in wsPage.rows do
		if row.name == "Target" then
			targetRow = row
		end
	end
	local props = handle("dex.props", { id = targetRow.id }, OWNER)
	local allReadOnly = true
	for _, row in props.props do
		allReadOnly = allReadOnly and row.readOnly == true
	end
	for _, row in props.attrs do
		allReadOnly = allReadOnly and row.readOnly == true
	end
	check("dex.props: properties and attributes, every one read-only", props.name == "Target" and props.className == "Part" and #props.attrs == 1 and props.attrs[1].name == "Hp" and allReadOnly)
	local ok, err = pcall(handle, "dex.props", { id = targetRow.id }, TOKEN)
	check("dex: ids are per caller (an id another caller saw is gone here)", ok == false and string.find(tostring(err), "gone", 1, true) ~= nil)
	check("dex: the instance is untouched", target.Name == "Target" and target:GetAttribute("Hp") == 5 and target.Parent == workspace)
end

print(`remote debug (framework): {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
