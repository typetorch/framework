--!nocheck
-- Offline test of the compiled signed-settings API (out/settings.luau with out/runtime/relay.luau) and its dev menu lines
-- (out/devtools/health.luau) under Lune, against stub kernels: liveConfig's default, value, parse (and its refusal),
-- onChanged only on real changes, generation scope, server only, the "needs kernel 0.3.8" default on older kernels;
-- settingsText and settingsIssues (missing, refused, unreadable, a recent refusal while a good copy is held).
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-settings.luau ../framework/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-settings.luau
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

local warnings = {}
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
local services = {
	HttpService = {
		JSONEncode = function(_, value)
			return serde.encode("json", value)
		end,
	},
}
local Instance = {
	new = function()
		local event = signal()
		return { Event = event, Fire = function(_, ...) event:Fire(...) end, Destroy = function() end }
	end,
}
local env
local modules = {}
local PATHS = { relay = "out/runtime/relay.luau", settings = "out/settings.luau", health = "out/devtools/health.luau", hints = "out/analytics/hints.luau" }
local function loadModule(name)
	if modules[name] then
		return modules[name]
	end
	modules[name] = luau.load(fs.readFile(root .. PATHS[name]), { debugName = name, environment = env })()
	return modules[name]
end
local script = { Parent = { Parent = {} } } -- health.luau reads script.Parent.Parent for its import of analytics/hints
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
env = setmetatable({
	script = script,
	_G = { [script] = TS },
	Instance = Instance,
	task = task,
	warn = function(...)
		table.insert(warnings, table.concat({ ... }, " "))
	end,
}, { __index = _G })

local S = loadModule("settings")
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
local function warned(fragment)
	for _, line in warnings do
		if has(line, fragment) then
			return true
		end
	end
	return false
end

-- Edit mode (no kernel): the default.
local price = S.liveConfig("shop.price", { default = 50 })
check("edit mode: the default", price:get() == 50 and price.key == "shop.price")

-- An older kernel: the default, warned once.
S.bindSettings("server", { kernelVersion = "0.3.7" }, trove(), "0.3.7")
check("kernel 0.3.7: the default", price:get() == 50 and price:get() == 50)
local count = 0
for _, line in warnings do
	if has(line, "needs kernel 0.3.8") then
		count += 1
	end
end
check("kernel 0.3.7: 'needs kernel 0.3.8' warned once", count == 1, count)
check("kernel 0.3.7: not supported", S.settingsSupported() == false)

-- Kernel 0.3.8.
local handler
local copy = { seq = 1, at = "2026-10-06T12:00:00.000Z", game = { ["shop.price"] = 75, flags = { pvp = true }, bad = "x" } }
local kernel = {
	kernelVersion = "0.3.8",
	settings = function()
		return copy
	end,
	onSettingsChanged = function(_, fn)
		handler = fn
	end,
}
S.bindSettings("server", kernel, trove(), "0.3.8")
check("0.3.8: supported, this generation's copy", S.settingsSupported() == true and S.currentSettings().seq == 1)
local live = S.liveConfig("shop.price", { default = 50 })
check("0.3.8: the record's value", live:get() == 75)
local flags = S.liveConfig("flags", { default = { pvp = false } })
check("0.3.8: a table value", flags:get().pvp == true)
local missing = S.liveConfig("nope", { default = "fallback" })
check("0.3.8: a missing key gives the default", missing:get() == "fallback")
local parsed = S.liveConfig("bad", {
	default = 0,
	parse = function(raw)
		local value = tonumber(raw)
		if value == nil then
			error("not a number")
		end
		return value
	end,
})
check("0.3.8: parse refusing a value gives the default, warned", parsed:get() == 0 and warned("parse refused the value"))
local changes = {}
local stop = live:onChanged(function(value, previous)
	table.insert(changes, { value, previous })
end)
local flagChanges = 0
flags:onChanged(function()
	flagChanges += 1
end)
handler({ seq = 2, at = "x", game = { ["shop.price"] = 80, flags = { pvp = true } } })
task.wait(0.05)
check("onChanged: fires with (value, previous) on a change", #changes == 1 and changes[1][1] == 80 and changes[1][2] == 75 and live:get() == 80)
check("onChanged: an unchanged key doesn't fire", flagChanges == 0)
handler({ seq = 3, at = "y", game = { flags = { pvp = false } } })
task.wait(0.05)
check("onChanged: a removed key gives the default", #changes == 2 and changes[2][1] == 50 and flagChanges == 1)
stop()
handler({ seq = 4, at = "z", game = { ["shop.price"] = 90 } })
task.wait(0.05)
check("onChanged: a disconnected listener hears nothing", #changes == 2)
S.unbindSettings()
handler({ seq = 5, at = "w", game = { flags = { pvp = true } } })
task.wait(0.05)
check("generation stopped: nothing fires (2 changes before it)", flagChanges == 2)
check("generation stopped: no copy", S.currentSettings() == nil)
S.bindSettings("client", kernel, trove(), "0.3.8")
local ok, err = pcall(function()
	return live:get()
end)
check("client: server-only", not ok and has(err, "server-only"), err)
S.unbindSettings()

-- Dev menu lines.
check("settingsText: ok", H.settingsText({ state = "ok", seq = 12, age = 180, verifiedBy = "sig", fields = {}, reads = 1 }) == "#12, 3m old (sig)")
check("settingsText: missing", has(H.settingsText({ state = "missing", fields = {}, reads = 1 }), "typetorch settings push"))
local function titles(status)
	local list = {}
	for _, issue in H.settingsIssues(status) do
		list[issue.title] = issue.level
	end
	return list
end
check("issues: missing: warn", titles({ settings = { state = "missing", fields = {}, reads = 1 } })["No settings"] == "warn")
check("issues: invalid with nothing held: error", titles({ settings = { state = "invalid", error = "signature", fields = {}, reads = 1 } })["Settings refused"] == "error")
check("issues: unreadable: warn", titles({ settings = { state = "error", error = "HTTP 500", fields = {}, reads = 1 } })["Settings unreadable"] == "warn")
check("issues: a recent refusal while a good copy is held: warn", titles({ settings = { state = "ok", seq = 3, fields = {}, reads = 2, refused = { why = "signature", at = os.time() } } })["Settings copy refused"] == "warn")
check("issues: ok: nothing", next(titles({ settings = { state = "ok", seq = 3, fields = {}, reads = 2 } })) == nil)
check("issues: an older kernel (no settings): nothing", next(titles({})) == nil)

print(`settings: {passed} passed, {failed} failed`)
process.exit(if failed == 0 then 0 else 1)
