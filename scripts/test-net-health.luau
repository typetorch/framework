--!nocheck
-- Offline test of the dev menu's fleet / analytics status lines (out/devtools/health.luau with out/analytics/hints.luau)
-- under Lune: the Status page's Fleet API and Analytics fields (last error, failure count, age, retry), the Attention
-- issues with the reason and fix for NetFail / HTTP 530 / 401, and that a recovered sender is quiet. Pure functions only.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-net-health.luau ../framework/out/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-net-health.luau ./out/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local base = process.args[1] or "out/"

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
	return text ~= nil and string.find(text, needle, 1, true) ~= nil
end

-- health.luau imports analytics/hints.luau through roblox-ts's TS.import.
local hints = luau.load(fs.readFile(base .. "analytics/hints.luau"), { debugName = "hints", environment = setmetatable({}, { __index = _G }) })()
local script = { Parent = { Parent = {} } }
local H = luau.load(fs.readFile(base .. "devtools/health.luau"), {
	debugName = "health",
	environment = setmetatable({
		script = script,
		_G = { [script] = {
			import = function()
				return hints
			end,
		} },
	}, { __index = _G }),
})()

local NOW = 1_800_000_000

-- Fleet API: the kernel sender's line ------------------------------------------------------------------------------------
local function fleet(over)
	local info = { enabled = true, settings = "ok", host = "fleet.example.com", sent = 340, failed = 0, queued = 0, dropped = 0, alerts = 0, lastOkAt = NOW - 20 }
	for key, value in over or {} do
		info[key] = value
	end
	return info
end
check("fleetText: healthy", H.fleetText(fleet(), NOW) == "fleet.example.com, 340 sent", H.fleetText(fleet(), NOW))
local down = fleet({ failed = 12, lastError = "HttpError: NetFail", lastErrorAt = NOW - 40, lastOkAt = NOW - 300, queued = 2 })
check("fleetFailing: the error is newer than the last success", H.fleetFailing(down) and not H.fleetFailing(fleet({ failed = 1, lastError = "HTTP 530", lastErrorAt = NOW - 100, lastOkAt = NOW - 20 })))
check("fleetText: failing says what, how many and how long ago", H.fleetText(down, NOW) == "fleet.example.com, 340 sent, 12 failed, 2 queued, FAILING: HttpError: NetFail 40 s ago", H.fleetText(down, NOW))
local recovered = fleet({ failed = 3, lastError = "HTTP 530", lastErrorAt = NOW - 600, lastOkAt = NOW - 20 })
check("fleetText: recovered keeps the history, not an alarm", has(H.fleetText(recovered, NOW), "last error HTTP 530 10m ago") and not has(H.fleetText(recovered, NOW), "FAILING"), H.fleetText(recovered, NOW))
check("fleetText: off cases", has(H.fleetText({ enabled = false, settings = "absent" }, NOW), "typetorch fleet setup") and has(H.fleetText({ enabled = false, settings = "invalid", settingsError = "url must be https" }, NOW), "url must be https") and has(H.fleetText({ enabled = false, missing = true }, NOW), "not mapped"))
check("fleetFix: NetFail", has(H.fleetFix("HttpError: NetFail"), "NetFail") and has(H.fleetFix("HttpError: NetFail"), "bun run local"))
check("fleetFix: HTTP 530 / 401 / 404", has(H.fleetFix("HTTP 530"), "tunnel") and has(H.fleetFix("HTTP 401"), "TT_ANALYTICS_INGEST_TOKENS") and has(H.fleetFix("HTTP 404"), "wrong"))
check("fleetFix: nothing", H.fleetFix(nil) == "-")

-- Analytics engine: the Status line ------------------------------------------------------------------------------------------
local function analytics(over)
	local stats = {
		configured = true, backend = "duckdb", queued = 10, queuedRecordings = 0, queuedFleet = 2, queuedIdentities = 0,
		sent = 3400, dropped = 0, rejected = 0, failures = 0, failed = 0, settingsErrors = {},
	}
	for key, value in over or {} do
		stats[key] = value
	end
	return stats
end
check("analyticsText: healthy", H.analyticsText(analytics(), NOW) == "duckdb, 12 queued, 3400 sent", H.analyticsText(analytics(), NOW))
local netFail = analytics({ failures = 5, failed = 7, lastError = "both: HttpError: NetFail", lastStatus = 0, lastErrorAt = NOW - 20, lastOkAt = NOW - 400, retryIn = 80, reason = "NetFail: the connection broke mid-request", fix = "run typetorch doctor" })
check("analyticsText: failing shows the streak, the message, the age and the next try", H.analyticsText(netFail, NOW) == "duckdb, 12 queued, 3400 sent, FAILING x5: both: HttpError: NetFail 20 s ago, retry in 80 s", H.analyticsText(netFail, NOW))
check("analyticsText: recovered", has(H.analyticsText(analytics({ failed = 4, lastErrorAt = NOW - 120 }), NOW), "4 failed earlier, last 2m ago") and not has(H.analyticsText(analytics({ failed = 4, lastErrorAt = NOW - 120 }), NOW), "FAILING"))
check("analyticsText: dropped and refused rows", has(H.analyticsText(analytics({ dropped = 30, rejected = 5 }), NOW), "30 dropped, 5 refused"))
check("analyticsText: no settings / invalid settings", has(H.analyticsText(analytics({ configured = false }), NOW), "typetorch settings set analytics") and has(H.analyticsText(analytics({ configured = false, settingsErrors = { "events must be an http(s) URL" } }), NOW), "events must be an http(s) URL"))

-- Attention list -------------------------------------------------------------------------------------------------------------
local issues = H.analyticsIssues(netFail)
check("issue: failing is a warning with the streak in the title", #issues == 1 and issues[1].level == "warn" and issues[1].title == "Analytics failing x5", issues[1] and issues[1].title)
check("issue: the reason, the fix and the retry", has(issues[1].detail, "NetFail: the connection broke mid-request") and has(issues[1].detail, "typetorch doctor") and has(issues[1].detail, "retry in 80 s"), issues[1].detail)
check("issue: a recovered engine is quiet", #H.analyticsIssues(analytics({ failed = 4, lastErrorAt = NOW - 120 })) == 0 and #H.analyticsIssues(nil) == 0 and #H.analyticsIssues(analytics()) == 0)
check("issue: bad settings", H.analyticsIssues(analytics({ configured = false, settingsErrors = { "token must be a non-empty string" } }))[1].title == "Analytics settings")
check("issue: dropped rows are info", H.analyticsIssues(analytics({ dropped = 9 }))[1].level == "info")

local status = { kernelApi = 1, kernelVersion = H.LATEST_KERNEL, generation = {}, history = {}, memoryMb = 10 }
local all = H.checkHealth(status, { analytics = netFail })
check("checkHealth lists the analytics issue (and nothing else)", #all == 1 and all[1].title == "Analytics failing x5", #all)
check("checkHealth without an engine", #H.checkHealth(status, {}) == 0 and #H.checkHealth(status) == 0)
local withFleet = H.checkHealth({ kernelApi = 1, kernelVersion = H.LATEST_KERNEL, generation = {}, history = {}, memoryMb = 10, fleet = down }, nil)
check("checkHealth: the fleet issue carries the fix and the counts", #withFleet == 1 and withFleet[1].title == "Fleet API failing" and has(withFleet[1].detail, "bun run local") and has(withFleet[1].detail, "12 failed"), withFleet[1] and withFleet[1].detail)

print(`net health: {passed} passed, {failed} failed`)
process.exit(if failed == 0 then 0 else 1)
