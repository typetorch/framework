--!nocheck
-- Offline test of the dev menu's command palette core (out/devtools/commands.luau) and its server rules
-- (out/devtools/palette-rules.luau over out/devtools/build-actions.luau) under Lune: fuzzy matching and its order,
-- the `when` filter (errors hide), recent commands first on an empty query, searchOnly and fallback commands, grouping,
-- the selection wrap, the recent list, the two-step confirm, the Ctrl+K rule, and which branch / build commands each
-- viewer gets (the Branch tab's own rules: owner vs dev, kernel 0.3.4 switches, server type, signed-only, A/B pins).
-- Run after `bun run build`:
--   cd ../kernel && lune run ../framework/scripts/test-commands.luau ../framework/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-commands.luau
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local root = process.args[1] or "./"

local C = luau.load(fs.readFile(root .. "out/devtools/commands.luau"), { debugName = "commands" })()

-- palette-rules.luau imports build-actions.luau, which imports the kernel module (normalRole) and ab.luau, through
-- roblox-ts's TS.import: stub it by module name.
local function loadWith(path, name, modules)
	local script = { Name = name, Parent = { Parent = {} } }
	return luau.load(fs.readFile(root .. path), {
		debugName = name,
		environment = setmetatable({
			script = script,
			_G = { [script] = {
				import = function(_, _, ...)
					local names = { ... }
					local wanted = names[#names]
					local module = modules[wanted]
					assert(module ~= nil, "unexpected import " .. tostring(wanted))
					return module
				end,
			} },
		}, { __index = _G }),
	})()
end
local kernelStub = {
	normalRole = function(role)
		if role == "admin" then
			return "dev"
		end
		return role
	end,
}
local AB = loadWith("out/devtools/ab.luau", "ab", {})
local BA = loadWith("out/devtools/build-actions.luau", "build-actions", { kernel = kernelStub, ab = AB })
local R = loadWith("out/devtools/palette-rules.luau", "palette-rules", { ["build-actions"] = BA })

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end
local function titles(groups)
	local list = {}
	for _, group in groups do
		for _, command in group.items do
			table.insert(list, command.title)
		end
	end
	return table.concat(list, ",")
end
local function groupNames(groups)
	local list = {}
	for _, group in groups do
		table.insert(list, group.group)
	end
	return table.concat(list, ",")
end
local function noop() end

-- Fuzzy matching ----------------------------------------------------------------------------------------------------------
do
	check("fuzzy: empty query matches with 0", C.fuzzyScore("", "Anything") == 0)
	check("fuzzy: substring matches", C.fuzzyScore("state", "Modules: State") ~= nil)
	check("fuzzy: case-insensitive", C.fuzzyScore("STATE", "modules: state") ~= nil)
	check("fuzzy: scattered letters in order match", C.fuzzyScore("swb", "Switch branch") ~= nil)
	check("fuzzy: letters out of order don't", C.fuzzyScore("bws", "Switch branch") == nil)
	check("fuzzy: longer than the text doesn't", C.fuzzyScore("reloadx", "Reload") == nil)
	check("fuzzy: missing letter doesn't", C.fuzzyScore("xyz", "Reload this server") == nil)
	check("fuzzy: prefix beats the middle", C.fuzzyScore("log", "Logs") > C.fuzzyScore("log", "Catalog"))
	check("fuzzy: word start beats the middle", C.fuzzyScore("state", "Modules: State") > C.fuzzyScore("tate", "Modules: State"))
	check("fuzzy: substring beats scattered", C.fuzzyScore("rel", "Reload") > C.fuzzyScore("rld", "Reload"))
	check("fuzzy: shorter text wins a tie", C.fuzzyScore("dock", "Dock") > C.fuzzyScore("dock", "Dock all windows"))
	check("fuzzy: word starts help scattered matches", C.fuzzyScore("sr", "Split right") > C.fuzzyScore("sr", "Servers"))
	local words = C.queryWords("  switch   dev ")
	check("queryWords: splits on spaces", #words == 2 and words[1] == "switch" and words[2] == "dev")
end

-- Command scoring ---------------------------------------------------------------------------------------------------------
do
	local reload = { id = "server.reload", title = "Reload this server", group = "Server", keywords = { "branch", "head" }, run = noop }
	check("score: title", C.commandScore(reload, "reload") ~= nil)
	check("score: keyword", C.commandScore(reload, "head") ~= nil)
	check("score: group", C.commandScore(reload, "server") ~= nil)
	check("score: every word must match somewhere", C.commandScore(reload, "reload head") ~= nil and C.commandScore(reload, "reload zzz") == nil)
	check("score: title beats keyword", C.commandScore(reload, "reload") > C.commandScore(reload, "branch"))
	local player = { id = "player.open:123", title = "Builder (@builderman)", group = "Players", keywords = { "builderman", "Builder", "156" }, run = noop }
	check("score: a UserId keyword finds the player", C.commandScore(player, "156") ~= nil)
	check("score: empty query", C.commandScore(player, "   ") == 0)
end

-- when filter -------------------------------------------------------------------------------------------------------------
do
	local ctx = { owner = false }
	local always = { id = "a", title = "Always", group = "G", run = noop }
	local owners = { id = "b", title = "Owners", group = "G", when = function(c) return c.owner end, run = noop }
	local broken = { id = "c", title = "Broken", group = "G", when = function() error("boom") end, run = noop }
	local truthy = { id = "d", title = "Truthy", group = "G", when = function() return 1 end, run = noop }
	check("when: none: available", C.isAvailable(always, ctx))
	check("when: false hides", not C.isAvailable(owners, ctx))
	check("when: true shows", C.isAvailable(owners, { owner = true }))
	check("when: an error hides", not C.isAvailable(broken, ctx))
	check("when: only true counts", not C.isAvailable(truthy, ctx))
	local list = C.available({ always, owners, broken, truthy, { id = "a", title = "Dup", group = "G", run = noop } }, ctx)
	check("available: filtered, first id wins", #list == 1 and list[1].title == "Always")
end

-- Registry and sources ------------------------------------------------------------------------------------------------------
do
	local registry = C.CommandRegistry.new()
	registry:add({ id = "s1", title = "Static", group = "G", run = noop })
	registry:addSource(function(ctx, query)
		return { { id = "d:" .. query, title = "Dynamic " .. query, group = "D", run = noop } }
	end)
	registry:addSource(function()
		error("source failed")
	end)
	local list = registry:collect({}, "x")
	check("registry: static then sources, a failing source adds nothing", #list == 2 and list[1].id == "s1" and list[2].id == "d:x")
end

-- Search: empty query (recent first, searchOnly and fallback hidden) ------------------------------------------------------
local function sample()
	return {
		{ id = "page:Artifact", title = "Artifact", group = "Pages", run = noop },
		{ id = "page:Logs", title = "Logs", group = "Pages", run = noop },
		{ id = "page:Modules/State", title = "Modules: State", group = "Pages", keywords = { "Modules/State" }, run = noop },
		{ id = "pane.splitRight", title = "Split right", group = "Panes", run = noop },
		{ id = "pane.close", title = "Close pane", group = "Panes", when = function(c) return c.canClose end, run = noop },
		{ id = "server.reload", title = "Reload this server", group = "Server", confirm = function() return "?" end, run = noop },
		{ id = "build.pin:7", title = "Load here #7  abc1234", group = "Builds", searchOnly = true, run = noop },
		{ id = "player.open:1", title = "Alice (@alice)", group = "Players", keywords = { "alice", "1" }, searchOnly = true, run = noop },
		{ id = "claude.ask", title = "Ask Claude: x", group = "Claude", fallback = true, run = noop },
	}
end
do
	local groups = C.searchCommands(sample(), { canClose = false }, "", {})
	check("empty: registration order, grouped", titles(groups) == "Artifact,Logs,Modules: State,Split right,Reload this server", titles(groups))
	check("empty: groups in order", groupNames(groups) == "Pages,Panes,Server", groupNames(groups))
	local recent = C.searchCommands(sample(), { canClose = false }, "", { "server.reload", "gone", "pane.close", "page:Logs", "server.reload" })
	check("empty: recent first, newest first, unknown and hidden ids dropped", groupNames(recent) == "Recent,Pages,Panes" and recent[1].items[1].id == "server.reload" and recent[1].items[2].id == "page:Logs" and #recent[1].items == 2, titles(recent))
	check("empty: recent ones aren't listed twice", titles(recent) == "Reload this server,Logs,Artifact,Modules: State,Split right", titles(recent))
	local searchOnlyRecent = C.searchCommands(sample(), {}, "", { "build.pin:7", "claude.ask" })
	check("empty: a recent searchOnly command shows, a fallback doesn't", searchOnlyRecent[1].group == "Recent" and #searchOnlyRecent[1].items == 1 and searchOnlyRecent[1].items[1].id == "build.pin:7")
	local limited = C.searchCommands(sample(), {}, "", { "page:Logs" }, 3)
	check("empty: limit", #C.flatten(limited) == 3, titles(limited))
end

-- Search: a query --------------------------------------------------------------------------------------------------------
do
	local groups = C.searchCommands(sample(), { canClose = true }, "state", {})
	check("query: matches only, fallback last", titles(groups) == "Modules: State,Ask Claude: x", titles(groups))
	local players = C.searchCommands(sample(), {}, "alice", {})
	check("query: searchOnly commands appear", titles(players) == "Alice (@alice),Ask Claude: x", titles(players))
	local close = C.searchCommands(sample(), { canClose = false }, "close", {})
	check("query: when still filters", titles(close) == "Ask Claude: x", titles(close))
	local split = C.searchCommands(sample(), {}, "sr", {})
	check("query: best group first", split[1].group == "Panes" and split[1].items[1].title == "Split right", titles(split))
	local many = {}
	for index = 1, 100 do
		table.insert(many, { id = "x" .. index, title = "Item " .. index, group = "G", run = noop })
	end
	check("query: default limit", #C.flatten(C.searchCommands(many, {}, "item", {})) == C.RESULT_LIMIT)
	local ordered = C.searchCommands({
		{ id = "1", title = "Catalog", group = "A", run = noop },
		{ id = "2", title = "Logs", group = "B", run = noop },
		{ id = "3", title = "Log out", group = "A", run = noop },
	}, {}, "log", {})
	check("query: groups by best score, items by score", groupNames(ordered) == "B,A" and titles(ordered) == "Logs,Log out,Catalog", titles(ordered))
end

-- Selection, recent list, confirm, hotkey -----------------------------------------------------------------------------------
do
	check("move: down", C.moveSelection(0, 1, 3) == 1)
	check("move: wraps down", C.moveSelection(2, 1, 3) == 0)
	check("move: wraps up", C.moveSelection(0, -1, 3) == 2)
	check("move: nothing", C.moveSelection(5, 1, 0) == 0)

	local recent = C.pushRecent({ "a", "b", "c" }, "b")
	check("recent: moves to the front", table.concat(recent, ",") == "b,a,c")
	local full = { "1", "2", "3", "4", "5", "6", "7", "8" }
	check("recent: capped", table.concat(C.pushRecent(full, "new"), ",") == "new,1,2,3,4,5,6,7")
	check("sanitizeRecent: garbage", #C.sanitizeRecent("nope") == 0 and #C.sanitizeRecent(nil) == 0)
	local clean = C.sanitizeRecent({ "a", 5, "", "a", "b", false, "c" }, 2)
	check("sanitizeRecent: strings, no duplicates, capped", table.concat(clean, ",") == "a,b")

	local armed = { at = -math.huge }
	check("confirm: first press arms", C.armStep(armed, "x", 10) == "arm" and C.isArmed(armed, "x", 11))
	check("confirm: second press runs and disarms", C.armStep(armed, "x", 12) == "run" and not C.isArmed(armed, "x", 12))
	C.armStep(armed, "x", 20)
	check("confirm: too late arms again", C.armStep(armed, "x", 20 + C.ARM_SECONDS + 0.1) == "arm")
	C.armStep(armed, "x", 30)
	check("confirm: another command arms itself, not runs", C.armStep(armed, "y", 31) == "arm" and C.isArmed(armed, "y", 31) and not C.isArmed(armed, "x", 31))

	check("hotkey: Ctrl+K", C.isPaletteHotkey("K", true, false))
	check("hotkey: not while typing", not C.isPaletteHotkey("K", true, true))
	check("hotkey: K alone", not C.isPaletteHotkey("K", false, false))
	check("hotkey: other keys", not C.isPaletteHotkey("D", true, false))
end

-- Server rules (palette-rules over build-actions) ---------------------------------------------------------------------------
local function ctx(over)
	local base = { serverType = "public", signedOnly = true, isOwner = true, switchKernel = true, experiments = true }
	for key, value in over or {} do
		base[key] = value
	end
	return base
end
local function kinds(offers)
	local list = {}
	for _, offer in offers do
		table.insert(list, offer.kind .. ":" .. (offer.build and tostring(offer.build.assetId) or offer.branch))
	end
	return table.concat(list, ",")
end
local BRANCHES = { { name = "main" }, { name = "dev" }, { name = "feat" } }
local BUILDS = {
	{ seq = 9, commit = "aaa1111", assetId = 900, branch = "main", channel = "prod", running = true },
	{ seq = 8, commit = "bbb2222", assetId = 800, branch = "main", channel = "prod" },
	{ seq = 7, commit = "ccc3333", assetId = 700, branch = "dev", channel = "dev" },
}
do
	-- An owner on a public prod server, kernel 0.3.4: Switch and Load here, both two-step.
	local owner = R.branchOffers(ctx(), "main", BRANCHES)
	check("owner public: switch the other branches, not the current", kinds(owner) == "switch:dev,switch:feat", kinds(owner))
	check("owner public: switch is two-step, Branch tab words", owner[1].confirm and owner[1].title == "Switch to dev" and owner[1].id == "branch.switch:dev")
	local loads = R.buildOffers(ctx(), BUILDS, true)
	check("owner public: load here every build but the running one", kinds(loads) == "loadHere:800,loadHere:700", kinds(loads))
	check("owner public: load here is two-step", loads[1].confirm and loads[1].title == "Load here #8  bbb2222")

	-- A dev (not owner) on a public server: Join only, one step (moves only you).
	local dev = R.branchOffers(ctx({ isOwner = false }), "main", BRANCHES)
	check("dev public: join", kinds(dev) == "joinBranch:dev,joinBranch:feat" and not dev[1].confirm and dev[1].title == "Join a dev server", kinds(dev))
	local devBuilds = R.buildOffers(ctx({ isOwner = false }), BUILDS, true)
	check("dev public: join builds, one step", kinds(devBuilds) == "joinBuild:800,joinBuild:700" and not devBuilds[1].confirm, kinds(devBuilds))

	-- An older kernel (no requestSwitch) on a public server: owners join branches; signed-only builds: nothing.
	local old = R.branchOffers(ctx({ switchKernel = false }), "main", BRANCHES)
	check("old kernel public: owners join", kinds(old) == "joinBranch:dev,joinBranch:feat", kinds(old))
	check("old kernel public signed-only: no build commands", #R.buildOffers(ctx({ switchKernel = false }), BUILDS, true) == 0)

	-- A/B pin before 0.3.4 on an unsigned public server: the experiment payload (build-actions pinPayload).
	local ab = R.buildOffers(ctx({ switchKernel = false, signedOnly = false }), BUILDS, false)
	check("A/B: pin with the experiment payload, two-step", kinds(ab) == "pin:800,pin:700" and ab[1].confirm and type(ab[1].pin) == "table" and ab[1].pin.experiment == true and ab[1].pin.assetId == 800, kinds(ab))

	-- A reserved dev server: the stored switch and dev pins, all two-step; a dev build on prod rules says so.
	local reserved = ctx({ serverType = "reserved", signedOnly = false, isOwner = false })
	local stored = R.branchOffers(reserved, "dev", BRANCHES)
	check("reserved: stored switch, two-step", kinds(stored) == "switchStored:main,switchStored:feat" and stored[1].confirm, kinds(stored))
	local pins = R.buildOffers(reserved, BUILDS, true)
	check("reserved: pin with the plain asset id", kinds(pins) == "pin:800,pin:700" and pins[1].pin == 800, kinds(pins))
	check("reserved: cross channel only for dev builds on prod rules", pins[2].crossChannel == true and pins[1].crossChannel == false)
	check("reserved: no cross channel on dev rules", R.buildOffers(reserved, BUILDS, false)[2].crossChannel == false)

	-- Status unknown: nothing.
	local unknown = ctx()
	unknown.serverType = nil
	check("unknown server type: no offers", #R.branchOffers(unknown, "main", BRANCHES) == 0 and #R.buildOffers(unknown, BUILDS, true) == 0)

	-- The armed lines.
	check("confirm text: switch", R.confirmText(owner[1], 3) == "Switch this server (3 players) to dev?", R.confirmText(owner[1], 3))
	check("confirm text: load", R.confirmText(loads[1], 1) == "Load #8 on this server (1 player)?", R.confirmText(loads[1], 1))
	check("confirm text: cross channel", R.confirmText(pins[2], 2) == "Load dev build #7 on this prod server (2 players)?", R.confirmText(pins[2], 2))
	check("swapsServer: join doesn't", BA.swapsServer("join") == false and BA.swapsServer("here") and BA.swapsServer("stored") and BA.swapsServer("pin"))
end

print(`test-commands: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
