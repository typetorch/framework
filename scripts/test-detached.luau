--!nocheck
-- Offline test of the compiled TypeTorch.runDetached (out/detached.luau with out/runtime/relay.luau and roblox-ts's
-- Promise) and its dev menu lines (out/devtools/health.luau) under Lune, against stub kernels: the Promise resolves or
-- rejects through the kernel's done callback, a dropped result leaves it pending, edit mode runs in place, the client,
-- older kernels ("needs kernel 0.3.8; use the DataHost job queue") and the kernel's cap throw at once.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-detached.luau ../framework/
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
local function has(text, needle)
	return string.find(tostring(text), needle, 1, true) ~= nil
end

local function signal()
	local handlers = {}
	return {
		Connect = function(_, fn)
			table.insert(handlers, fn)
			return { Disconnect = function() end }
		end,
		Fire = function(_, ...)
			for _, fn in table.clone(handlers) do
				task.spawn(fn, ...)
			end
		end,
	}
end
local Instance = {
	new = function()
		local event = signal()
		return { Event = event, Fire = function(_, ...) event:Fire(...) end, Destroy = function() end }
	end,
}
local heartbeat = signal()
heartbeat.Wait = function()
	return task.wait()
end
local game = {
	GetService = function()
		return { Heartbeat = heartbeat }
	end,
}
local warnings = {}
local baseEnv = {
	Instance = Instance,
	task = task,
	game = game,
	warn = function(...)
		table.insert(warnings, table.concat({ ... }, " "))
	end,
}
local Promise = luau.load(fs.readFile(`{root}node_modules/roblox-ts/include/Promise.lua`), {
	debugName = "Promise",
	environment = setmetatable(table.clone(baseEnv), { __index = _G }),
})()

local env
local modules = {}
local PATHS = { relay = "out/runtime/relay.luau", detached = "out/detached.luau", health = "out/devtools/health.luau" }
local function loadModule(name)
	if modules[name] then
		return modules[name]
	end
	modules[name] = luau.load(fs.readFile(root .. PATHS[name]), { debugName = name, environment = env })()
	return modules[name]
end
local script = {}
local TS = {
	Promise = Promise,
	import = function(_, _from, ...)
		local parts = { ... }
		return loadModule(parts[#parts])
	end,
}
env = setmetatable(table.clone(baseEnv), { __index = _G })
env.script = script
env._G = { [script] = TS }

local D = loadModule("detached")
local H = loadModule("health")

local function trove()
	return {
		add = function(_, value)
			return value
		end,
		connect = function(_, event, fn)
			return event:Connect(fn)
		end,
	}
end
local function settle()
	for _ = 1, 5 do
		task.wait()
	end
end
local function throws(fn, fragment)
	local ok, err = pcall(fn)
	return not ok and has(err, fragment), err
end

-- Edit mode (no kernel): runs in place.
local edit = D.runDetached(function()
	return 7
end)
check("edit mode: runs in place and resolves", edit:getStatus() == "Resolved" and select(2, edit:await()) == 7)

-- A client: server only.
D.bindDetached("client", {}, trove(), "0.3.8")
local okClient, clientError = throws(function()
	D.runDetached(function() end)
end, "server-only")
check("client: throws server-only", okClient, clientError)
check("client: not supported", D.detachedSupported() == false)

-- An older kernel: throws, pointing at the DataHost job queue.
D.bindDetached("server", { kernelVersion = "0.3.7" }, trove(), "0.3.7")
local okOld, oldError = throws(function()
	D.runDetached(function() end)
end, "needs kernel 0.3.8 (this server runs 0.3.7); use the DataHost job queue")
check("kernel 0.3.7: throws 'needs kernel 0.3.8 ... DataHost job queue'", okOld, oldError)
check("kernel 0.3.7: not supported", D.detachedSupported() == false)

-- Kernel 0.3.8 stub: jobs run on their own thread; done(ok, result) unless the test drops it (a stopped generation).
local kernel = { kernelVersion = "0.3.8", jobs = {}, max = 3, running = 0, dropDone = false }
function kernel:runDetached(fn, done)
	if self.running >= self.max then
		error(`runDetached: {self.running} detached jobs already run on this server (the cap is {self.max}); wait for some to finish`, 3)
	end
	self.running += 1
	table.insert(self.jobs, fn)
	task.spawn(function()
		local ok, result = pcall(fn)
		self.running -= 1
		if done and not self.dropDone then
			done(ok, result)
		end
	end)
	return #self.jobs
end
D.bindDetached("server", kernel, trove(), "0.3.8")
check("kernel 0.3.8: supported", D.detachedSupported() == true)

local plain = D.runDetached(function()
	return "profile"
end)
settle()
check("the kernel ran the function itself (it owns the thread)", #kernel.jobs == 1)
check("the Promise resolves with the job's result (through the relay)", plain:getStatus() == "Resolved" and select(2, plain:await()) == "profile")

local slowJob = D.runDetached(function()
	task.wait(0.05)
	return 1
end)
check("a yielding job: pending until it ends, then resolved", slowJob:getStatus() == "Started")
task.wait(0.1)
settle()
check("...resolved", slowJob:getStatus() == "Resolved")

local failing = D.runDetached(function()
	error("profile store down", 0)
end)
failing:catch(function() end)
settle()
local _, rejection = failing:await()
check("an error rejects the Promise with it", failing:getStatus() == "Rejected" and has(rejection, "profile store down"), rejection)

kernel.dropDone = true
local dropped = D.runDetached(function()
	return "late"
end)
settle()
check("a result the kernel drops (a stopped generation) leaves the Promise pending", dropped:getStatus() == "Started")
kernel.dropDone = false

-- The kernel's cap: throws at once.
kernel.running = 3
local okCap, capError = throws(function()
	D.runDetached(function() end)
end, "the cap is 3")
check("past the kernel's cap: throws at once", okCap, capError)
kernel.running = 0
local okArg, argError = throws(function()
	D.runDetached("not a function")
end, "pass a function")
check("a non-function: throws", okArg, argError)

D.unbindDetached()
check("after unbind: not supported (edit mode again)", D.detachedSupported() == false)

-- Dev menu: Server > Status and Attention.
check("detachedText: running, oldest, failed", H.detachedText({ running = 2, started = 5, finished = 3, failed = 1, slow = 0, max = 256, oldest = 4 }) == "2 running (oldest 4 s), 1 failed")
check("detachedText: idle", H.detachedText({ running = 0, started = 0, finished = 0, failed = 0, slow = 0, max = 256 }) == "0 running")
local function titles(detached)
	local list = {}
	for _, issue in H.detachedIssues({ detached = detached }) do
		list[issue.title] = issue.level
	end
	return list
end
check("detachedIssues: quiet: none", next(titles({ running = 1, started = 1, finished = 0, failed = 0, slow = 0, max = 256, oldest = 3 })) == nil)
check("detachedIssues: a job past 60 s: warn", titles({ running = 1, started = 1, finished = 0, failed = 0, slow = 1, max = 256, oldest = 75 })["Detached job slow"] == "warn")
check("detachedIssues: near the cap: warn", titles({ running = 210, started = 210, finished = 0, failed = 0, slow = 0, max = 256, oldest = 2 })["Detached jobs near the cap"] == "warn")
check("detachedIssues: older kernels (no status): none", next(H.detachedIssues({})) == nil)

print(`test-detached: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
