--!nocheck
-- Offline test of the compiled live debug API (out/live-debug.luau: remoteDebug.command / stream, fleet.column /
-- columnsChanged; plans/34) under Lune, against stub kernels: names and options are checked (bad ones, duplicates and
-- ones past the limits throw), a client throws, older kernels and edit mode accept and send nothing, a 0.5.7 kernel
-- gets one declaration per frame (in order, with labels, kinds and types), its handlers reach the game's functions,
-- removing an entry re-declares, columnsChanged reaches the kernel (declarations first), unbind stops everything.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-live-debug.luau ../framework/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
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
local function throws(fn, fragment)
	local ok, err = pcall(fn)
	return not ok and string.find(tostring(err), fragment, 1, true) ~= nil, err
end
local function settle()
	for _ = 1, 3 do
		task.wait()
	end
end

local env = setmetatable({ task = task, script = {} }, { __index = _G })
local L = luau.load(fs.readFile(`{root}out/live-debug.luau`), { debugName = "live-debug", environment = env })()
local remoteDebug, fleet = L.remoteDebug, L.fleet

-- Names ---------------------------------------------------------------------------------------------------------------
check("names: valid", L.validDebugName("a") and L.validDebugName("round_state") and L.validDebugName("a" .. string.rep("9", 31)))
check("names: invalid", not L.validDebugName("") and not L.validDebugName("A") and not L.validDebugName("_x") and not L.validDebugName("1x") and not L.validDebugName("a-b") and not L.validDebugName("a.b") and not L.validDebugName(string.rep("a", 33)) and not L.validDebugName(5))

-- Edit mode (no kernel): accepted and checked ------------------------------------------------------------------------------
local removeEdit = remoteDebug:command("edit_cmd", function() end)
check("edit mode: a command is accepted (returns a remover); not supported", typeof(removeEdit) == "function" and remoteDebug:supported() == false)
check("edit mode: columnsChanged does nothing", pcall(function()
	fleet:columnsChanged()
end))
removeEdit()
check("bad name throws", throws(function()
	remoteDebug:command("Bad", function() end)
end, "^[a-z][a-z0-9_]{0,31}$"))
check("no function throws", throws(function()
	remoteDebug:command("x", nil)
end, "pass a function"))
check("a label over 40 characters throws", throws(function()
	fleet:column("x", function() end, { label = string.rep("l", 41) })
end, "at most 40"))
check("a description over 200 characters throws", throws(function()
	remoteDebug:command("x", function() end, { description = string.rep("d", 201) })
end, "at most 200"))
check("labels count characters, not bytes (40 x é is fine)", pcall(function()
	fleet:column("accents", function() end, { label = string.rep("é", 40) })()
end))
check("stream: no hz throws", throws(function()
	remoteDebug:stream("s", function() end, {})
end, "hz must be"))
check("stream: hz past 4 or under 0.2 throws", throws(function()
	remoteDebug:stream("s", function() end, { hz = 5 })
end, "hz must be") and throws(function()
	remoteDebug:stream("s", function() end, { hz = 0.1 })
end, "hz must be"))
check("stream: a bad kind throws", throws(function()
	remoteDebug:stream("s", function() end, { hz = 1, kind = "dots" })
end, "kind must be"))
check("column: a bad type throws", throws(function()
	fleet:column("c", function() end, { type = "date" })
end, "type must be"))

-- Limits and duplicates
do
	local removers = {}
	for index = 1, 16 do
		table.insert(removers, fleet:column(`c{index}`, function() end))
	end
	check("limit: a 17th column throws", throws(function()
		fleet:column("c17", function() end)
	end, "at most 16 columns"))
	check("duplicate: throws", throws(function()
		fleet:column("c1", function() end)
	end, "already registered"))
	for _, remove in removers do
		remove()
	end
	for index = 1, 32 do
		table.insert(removers, remoteDebug:command(`m{index}`, function() end))
	end
	check("limit: a 33rd command throws", throws(function()
		remoteDebug:command("m33", function() end)
	end, "at most 32 commands"))
	for index = 1, 8 do
		table.insert(removers, remoteDebug:stream(`s{index}`, function() end, { hz = 1 }))
	end
	check("limit: a 9th stream throws", throws(function()
		remoteDebug:stream("s9", function() end, { hz = 1 })
	end, "at most 8 streams"))
	for _, remove in removers do
		remove()
	end
	check("removed entries free their names", pcall(function()
		fleet:column("c1", function() end)()
	end))
end

-- A client: server only --------------------------------------------------------------------------------------------------
L.bindLiveDebug("client", {})
check("client: command, stream, column and columnsChanged throw server-only", throws(function()
	remoteDebug:command("x", function() end)
end, "server-only") and throws(function()
	remoteDebug:stream("x", function() end, { hz = 1 })
end, "server-only") and throws(function()
	fleet:column("x", function() end)
end, "server-only") and throws(function()
	fleet:columnsChanged()
end, "server-only"))
L.unbindLiveDebug()

-- An older kernel (no debugDeclare): silent ---------------------------------------------------------------------------------
local oldKernel = { kernelVersion = "0.5.6" }
L.bindLiveDebug("server", oldKernel)
local removeOld = remoteDebug:command("old_cmd", function() end)
settle()
check("kernel 0.5.6: accepted, not supported, nothing called", typeof(removeOld) == "function" and remoteDebug:supported() == false)
check("kernel 0.5.6: columnsChanged is a no-op", pcall(function()
	fleet:columnsChanged()
end))
removeOld()
L.unbindLiveDebug()

-- Kernel 0.5.7 -------------------------------------------------------------------------------------------------------------
local kernel = { kernelVersion = "0.5.7", declared = {}, changed = 0 }
function kernel:debugDeclare(declarations)
	table.insert(self.declared, declarations)
	return { ok = true, hash = "h", columns = #declarations.columns, commands = #declarations.commands, streams = #declarations.streams, dropped = 0 }
end
function kernel:onDebugCommand(fn)
	self.command = fn
end
function kernel:onDebugColumn(fn)
	self.column = fn
end
function kernel:onDebugStream(fn)
	self.stream = fn
end
function kernel:debugColumnsChanged()
	self.changed += 1
	return true
end

-- Registered before the bind (module top level): sent at bind.
local mapName = "Lobby"
fleet:column("current_map", function()
	return mapName
end, { label = "Map", type = "string" })
L.bindLiveDebug("server", kernel)
check("bind: handlers installed and the early registration declared at once", typeof(kernel.command) == "function" and typeof(kernel.column) == "function" and typeof(kernel.stream) == "function" and #kernel.declared == 1 and kernel.declared[1].columns[1].name == "current_map")
check("supported on 0.5.7", remoteDebug:supported() == true)

local calls = {}
remoteDebug:command("round_state", function(args, caller)
	table.insert(calls, { args = args, caller = caller })
	return { kind = "kv", items = { round = 3, n = args.n } }
end, { label = "Round", description = "The current round" })
fleet:column("in_round", function()
	return true
end, { type = "bool" })
local removeLoot = remoteDebug:stream("loot", function()
	return { points = { { x = 1, y = 2, z = 3 } } }
end, { hz = 2, kind = "points", label = "Loot" })
remoteDebug:stream("state", function()
	return { phase = "intermission" }
end, { hz = 0.5 })
check("registrations in one frame are declared once, deferred", #kernel.declared == 1)
settle()
check("...then one declaration", #kernel.declared == 2, #kernel.declared)
local decl = kernel.declared[2]
check("declaration: columns in order with label and type", #decl.columns == 2 and decl.columns[1].name == "current_map" and decl.columns[1].label == "Map" and decl.columns[1].type == "string" and decl.columns[2].name == "in_round" and decl.columns[2].type == "bool")
check("declaration: commands with label and description", #decl.commands == 1 and decl.commands[1].name == "round_state" and decl.commands[1].label == "Round" and decl.commands[1].description == "The current round")
check("declaration: streams with hz, kind (json by default) and label", #decl.streams == 2 and decl.streams[1].hz == 2 and decl.streams[1].kind == "points" and decl.streams[1].label == "Loot" and decl.streams[2].kind == "json")

-- The kernel's handlers reach the game's functions.
local caller = { kind = "roblox", userId = 1, owner = true, via = "roblox" }
local answer = kernel.command("round_state", { n = 7 }, caller)
check("command handler: fn(args, caller), its answer returned", answer.items.round == 3 and answer.items.n == 7 and calls[1].caller == caller)
check("command handler: non-table args become {}", kernel.command("round_state", "junk", caller).items.n == nil)
check("command handler: an unknown name throws", throws(function()
	kernel.command("nope", {}, caller)
end, "unknown command"))
check("column handler: the getter's value", kernel.column("current_map") == "Lobby" and kernel.column("in_round") == true and kernel.column("nope") == nil)
mapName = "HedgeMaze"
check("column handler: read live", kernel.column("current_map") == "HedgeMaze")
check("stream handler: the sampler's value", kernel.stream("loot").points[1].x == 1 and kernel.stream("state").phase == "intermission" and kernel.stream("nope") == nil)

-- columnsChanged
fleet:columnsChanged()
check("columnsChanged reaches the kernel", kernel.changed == 1)
local before = #kernel.declared
fleet:column("score", function()
	return 5
end)
fleet:columnsChanged()
check("columnsChanged: pending declarations go first", #kernel.declared == before + 1 and kernel.changed == 2 and #kernel.declared[#kernel.declared].columns == 3)
settle()
check("...and not twice", #kernel.declared == before + 1)

-- Removing re-declares.
removeLoot()
settle()
local last = kernel.declared[#kernel.declared]
check("removing a stream re-declares without it", #last.streams == 1 and last.streams[1].name == "state" and kernel.stream("loot") == nil)
removeLoot()
settle()
check("a remover is idempotent", #kernel.declared[#kernel.declared].streams == 1)

-- A throwing kernel never breaks the game.
local angry = { debugDeclare = function()
	error("kernel down")
end, debugColumnsChanged = function()
	error("kernel down")
end }
L.unbindLiveDebug()
L.bindLiveDebug("server", angry)
check("a kernel that throws: bind, register and columnsChanged don't", pcall(function()
	remoteDebug:command("extra", function() end)
	settle()
	fleet:columnsChanged()
end))

-- Unbind: nothing reaches the kernel any more.
L.unbindLiveDebug()
local count = #kernel.declared
remoteDebug:command("after", function() end)
settle()
fleet:columnsChanged()
check("after unbind: nothing is sent", #kernel.declared == count and kernel.changed == 2 and remoteDebug:supported() == false)

print(`test-live-debug: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
