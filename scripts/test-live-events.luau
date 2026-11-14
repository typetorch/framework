--!nocheck
-- Offline test of scheduled live events (out/settings.luau: the signed `game["tt.events"]` schedule, liveConfig's
-- overrides while an event runs, liveEvents()) under Lune, against a stub kernel and a fake clock (os.time): an event
-- before, during and after its window; a server that starts mid-event; the switch at the start and end times with no
-- new settings copy (the backend down); the latest start wins on one key; bad entries skipped; a cancelled event
-- (a new copy without it) ends at once; the generation stop ends the timer; server only.
-- Run after the build:
--   cd ../kernel && lune run ../framework/scripts/test-live-events.luau ../framework/
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

-- The fake clock: unix seconds the module's os.time() returns.
local NOW = 1_763_200_000
local fakeOs = setmetatable({
	time = function()
		return NOW
	end,
}, { __index = os })

local services = {
	HttpService = {
		JSONEncode = function(_, value)
			return serde.encode("json", value)
		end,
	},
}
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
local warnings = {}
local env
local modules = {}
local PATHS = { relay = "out/runtime/relay.luau", settings = "out/settings.luau" }
local function loadModule(name)
	if modules[name] then
		return modules[name]
	end
	modules[name] = luau.load(fs.readFile(root .. PATHS[name]), { debugName = name, environment = env })()
	return modules[name]
end
local script = { Parent = { Parent = {} } }
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
	os = fakeOs,
	warn = function(...)
		table.insert(warnings, table.concat({ ... }, " "))
	end,
}, { __index = _G })

local S = loadModule("settings")

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

local START = NOW + 2
local END_ = NOW + 4
local function schedule(events)
	return { v = 1, events = events }
end
local doubleCash = { id = "ev_cash", name = "Double cash", start = START, ["end"] = END_, set = { ["cash.multiplier"] = 2, banner = "double" } }

local handler
local copy = { seq = 1, at = "a", game = { ["cash.multiplier"] = 1, ["tt.events"] = schedule({ doubleCash }) } }
local kernel = {
	kernelVersion = "0.5.3",
	settings = function()
		return copy
	end,
	onSettingsChanged = function(_, fn)
		handler = fn
	end,
}

-- Before the window.
S.bindSettings("server", kernel, trove(), "0.5.3")
local mult = S.liveConfig("cash.multiplier", { default = 1 })
local banner = S.liveConfig("banner", { default = "none" })
local events = S.liveEvents()
check("before: the record's value", mult:get() == 1)
check("before: an unset key's default", banner:get() == "none")
check("before: nothing active", #events:active() == 0)
local upcoming = events:upcoming()
check("before: one upcoming, its fields", #upcoming == 1 and upcoming[1].id == "ev_cash" and upcoming[1].name == "Double cash" and upcoming[1].startsAt == START and upcoming[1].endsAt == END_, #upcoming)

local changes = {}
mult:onChanged(function(value, previous)
	table.insert(changes, { value, previous })
end)
local activeChanges = {}
events:onChanged(function(active)
	table.insert(activeChanges, #active)
end)

-- The start time passes with no new settings copy: the timer switches it on.
NOW = START
task.wait(2.3)
check("start: switched on by the clock alone", mult:get() == 2 and banner:get() == "double")
check("start: onChanged fired once with (2, 1)", #changes == 1 and changes[1][1] == 2 and changes[1][2] == 1, #changes)
check("start: liveEvents.onChanged fired with one active", #activeChanges == 1 and activeChanges[1] == 1, #activeChanges)
check("start: active() lists it, upcoming() is empty", #events:active() == 1 and #events:upcoming() == 0)

-- A settings copy that doesn't touch the key: no extra change.
copy = { seq = 2, at = "b", game = { ["cash.multiplier"] = 1, other = true, ["tt.events"] = schedule({ doubleCash }) } }
handler(copy)
task.wait(0.05)
check("during: an unrelated copy fires nothing", #changes == 1 and #activeChanges == 1)

-- The end time passes (the backend is down: no copy, no message): the timer switches it off.
NOW = END_
task.wait(2.3)
check("end: switched off by the clock alone", mult:get() == 1 and banner:get() == "none")
check("end: onChanged fired with (1, 2)", #changes == 2 and changes[2][1] == 1 and changes[2][2] == 2, #changes)
check("end: liveEvents.onChanged fired with none active", #activeChanges == 2 and activeChanges[2] == 0, #activeChanges)
S.unbindSettings()

-- A server that starts mid-event picks it up at boot.
NOW = START + 1
copy = { seq = 3, at = "c", game = { ["cash.multiplier"] = 1, ["tt.events"] = schedule({ doubleCash }) } }
S.bindSettings("server", kernel, trove(), "0.5.3")
check("mid-event boot: the event's value at once", mult:get() == 2 and #events:active() == 1)

-- Cancelled: the owner signs a schedule without it; servers drop it with that copy.
local cancelled = {}
mult:onChanged(function(value)
	table.insert(cancelled, value)
end)
copy = { seq = 4, at = "d", game = { ["cash.multiplier"] = 1, ["tt.events"] = schedule({}) } }
handler(copy)
task.wait(0.05)
check("cancel: a copy without the event ends it at once", mult:get() == 1 and #cancelled == 1 and cancelled[1] == 1)

-- Two events on one key: the later start wins; an event with only other keys leaves it alone.
local early = { id = "ev_a", name = "Early", start = NOW - 10, ["end"] = NOW + 100, set = { ["cash.multiplier"] = 3 } }
local late = { id = "ev_b", name = "Late", start = NOW - 5, ["end"] = NOW + 100, set = { ["cash.multiplier"] = 2.5 } }
local other = { id = "ev_c", name = "Other", start = NOW - 20, ["end"] = NOW + 100, set = { banner = "x" } }
copy = { seq = 5, at = "e", game = { ["cash.multiplier"] = 1, ["tt.events"] = schedule({ late, other, early }) } }
handler(copy)
task.wait(0.05)
check("overlap: the later start wins", mult:get() == 2.5, mult:get())
local active = events:active()
check("overlap: active() in start order", #active == 3 and active[1].id == "ev_c" and active[2].id == "ev_a" and active[3].id == "ev_b")

-- Bad entries are skipped, never an error; a wrong version is ignored whole.
copy = {
	seq = 6,
	at = "f",
	game = {
		["cash.multiplier"] = 1,
		["tt.events"] = schedule({
			{ id = "ev_noend", start = NOW - 1, set = { ["cash.multiplier"] = 9 } },
			{ id = "ev_back", start = NOW + 5, ["end"] = NOW - 5, set = { ["cash.multiplier"] = 9 } },
			{ id = 7, start = NOW - 1, ["end"] = NOW + 5, set = { ["cash.multiplier"] = 9 } },
			"junk",
			{ id = "ev_ok", start = NOW - 1, ["end"] = NOW + 5, set = { ["cash.multiplier"] = 4 } },
		}),
	},
}
handler(copy)
task.wait(0.05)
check("bad entries: skipped, the good one applies", mult:get() == 4 and #events:active() == 1 and events:active()[1].name == "ev_ok")
copy = { seq = 7, at = "g", game = { ["cash.multiplier"] = 1, ["tt.events"] = { v = 2, events = { doubleCash } } } }
handler(copy)
task.wait(0.05)
check("unknown schedule version: ignored", mult:get() == 1 and #events:active() == 0 and #events:upcoming() == 0)
copy = { seq = 8, at = "h", game = { ["cash.multiplier"] = 1, ["tt.events"] = "nope" } }
handler(copy)
task.wait(0.05)
check("a schedule that isn't a table: ignored", mult:get() == 1)

-- parse still applies to an event's value (a refused value gives the default).
copy = { seq = 9, at = "i", game = { ["tt.events"] = schedule({ { id = "ev_bad", start = NOW - 1, ["end"] = NOW + 5, set = { ["cash.multiplier"] = "lots" } } }) } }
handler(copy)
task.wait(0.05)
local parsed = S.liveConfig("cash.multiplier", {
	default = 1,
	parse = function(raw)
		assert(type(raw) == "number" and raw >= 1 and raw <= 3, "1 to 3")
		return raw
	end,
})
check("parse: refuses an event's out-of-bounds value -> default", parsed:get() == 1)

-- The generation stops: the timer stops too (no listener runs after unbind).
local stoppedChanges = 0
copy = { seq = 10, at = "j", game = { ["tt.events"] = schedule({ { id = "ev_soon", start = NOW + 1, ["end"] = NOW + 50, set = { banner = "soon" } } }) } }
handler(copy)
task.wait(0.05)
banner:onChanged(function()
	stoppedChanges += 1
end)
S.unbindSettings()
NOW += 1
task.wait(1.3)
check("generation stopped: the timer fired nothing", stoppedChanges == 0)

-- Client: server only.
S.bindSettings("client", kernel, trove(), "0.5.3")
local ok, err = pcall(function()
	return events:active()
end)
check("client: server-only", not ok and has(err, "server-only"), err)
S.unbindSettings()

print(`live events: {passed} passed, {failed} failed`)
process.exit(if failed == 0 then 0 else 1)
