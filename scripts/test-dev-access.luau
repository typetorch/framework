--!nocheck
-- Offline test of who may use the dev-only devtools (framework 0.4.1): the rule in out/devtools/access.luau, every gate
-- of out/devtools/claude.luau (+ toolbox-server.luau) that goes through it, the devtools server's own gates
-- (out/devtools/server.luau: op "access", status facts.access, state.inspect, explorer edits through
-- explorer-server.luau, one shared rule handed to Claude, Dex and Manage) and the run_luau hint (health.luau), against
-- stub kernels under Lune. The rule: dev RULES (private/reserved/Studio as before) for every dev; or a PUBLIC server on a
-- dev-channel branch that an OWNER switched to (status().switched names the branch, the kernel follows it by dev rules:
-- signedOnly false) for owners only; nothing else. Cases: private dev server (allowed), public prod branch (refused),
-- public dev branch switched by an owner + owner (allowed), same + non-owner (refused), public dev branch not switched
-- by an owner (refused), older kernels without the new fields (as before), plus Claude's session keeping and polls.
-- Run after `bun run build`:
--   cd ../kernel && lune run ../framework/scripts/test-dev-access.luau ../framework/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-dev-access.luau
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

-- Stubs -----------------------------------------------------------------------------------------------------------------
local players = {} -- userId -> stub Player
local subscriptions = {} -- topic -> { callback }
local requests = {} -- { method, url, auth } of every HTTP request
local warnings = {}

local function decodeJson(text)
	local ok, value = pcall(serde.decode, "json", text)
	return if ok then value else nil
end

local services = {
	Players = {
		GetPlayerByUserId = function(_, userId)
			return players[userId]
		end,
	},
	MessagingService = {
		SubscribeAsync = function(_, topic, callback)
			subscriptions[topic] = subscriptions[topic] or {}
			table.insert(subscriptions[topic], callback)
			return { Disconnect = function() end }
		end,
		PublishAsync = function() end,
	},
	MemoryStoreService = {
		GetHashMap = function()
			return {
				GetAsync = function()
					return nil
				end,
				SetAsync = function() end,
			}
		end,
	},
	DataStoreService = {
		GetDataStore = function()
			return { SetAsync = function() end, GetAsync = function() end }
		end,
	},
	HttpService = {
		JSONEncode = function(_, value)
			return serde.encode("json", value)
		end,
		JSONDecode = function(_, text)
			return serde.decode("json", text)
		end,
		GenerateGUID = function()
			return string.format("%08x%08x%08x%08x", math.random(0, 2 ^ 31), math.random(0, 2 ^ 31), math.random(0, 2 ^ 31), math.random(0, 2 ^ 31))
		end,
		RequestAsync = function(_, request)
			local path = string.match(request.Url, "^https://[^/]+(.*)$") or request.Url
			local auth = request.Headers and request.Headers.Authorization
			table.insert(requests, { method = request.Method, path = path, auth = auth })
			if path == "/v1/token" then
				local body = decodeJson(request.Body) or {}
				return { StatusCode = 200, Body = serde.encode("json", { access_token = `tok-{body.user}`, expires_in = 3600 }) }
			end
			if string.find(path, "^/v1/game/poll") then
				task.wait(0.2)
				return { StatusCode = 200, Body = serde.encode("json", { cursor = 1, items = {} }) }
			end
			return { StatusCode = 404, Body = "" }
		end,
	},
	CollectionService = {
		GetTagged = function()
			return {}
		end,
	},
	AssetService = {},
	Workspace = {},
}

-- Modules that claude.luau imports but this test doesn't exercise.
local stubs = {
	budget = { countBudget = function() end },
	version = { FRAMEWORK_VERSION = "test" },
	["claude-tools"] = {
		CLAUDE_TOOL_REQUEST = "tt.claude.tool",
		CLAUDE_TOOL_RESPONSE = "tt.claude.tool.reply",
		capLogText = function(text)
			return text
		end,
		findTool = function() end,
		formatLogHistory = function()
			return ""
		end,
		inspectTool = function() end,
		loadstringAvailable = function()
			return false
		end,
		playerList = function()
			return {}
		end,
		runLuau = function() end,
		toJson = function()
			return "{}"
		end,
		resolveGamePath = function() end,
	},
	["claude-images"] = {
		CLAUDE_IMAGE_CHUNK = "tt.claude.image",
		MAX_STROKES_JSON = 1000,
		cleanAttachmentIds = function()
			return {}
		end,
		cleanCrop = function() end,
		cleanImageMeta = function() end,
		cleanStrokes = function()
			return {}
		end,
		decodeImageChunk = function() end,
	},
	["toolbox-sanitize"] = {
		leftovers = function()
			return 0
		end,
		sanitizeAsset = function() end,
		scanAsset = function() end,
	},
}
local PATHS = {
	kernel = "out/kernel.luau",
	access = "out/devtools/access.luau",
	claude = "out/devtools/claude.luau",
	["toolbox-server"] = "out/devtools/toolbox-server.luau",
	sha256 = "out/devtools/sha256.luau",
}
local env
local modules = {}
local function loadModule(name)
	if stubs[name] then
		return stubs[name]
	end
	if not modules[name] then
		modules[name] = luau.load(fs.readFile(root .. PATHS[name]), { debugName = name, environment = env })()
	end
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
	game = { JobId = "job-1", PlaceId = 1 },
	task = task,
	warn = function(...)
		table.insert(warnings, table.concat({ ... }, " "))
	end,
	print = function() end,
}, { __index = _G })

local A = loadModule("access")
local C = loadModule("claude")

-- Players and kernels ---------------------------------------------------------------------------------------------------
local OWNER, DEV, OTHER_OWNER = 101, 202, 303
local function player(userId, name)
	return { UserId = userId, Name = name, Parent = {} }
end
local owner = player(OWNER, "Owner")
local dev = player(DEV, "Dev")
local otherOwner = player(OTHER_OWNER, "OtherOwner")
local roles = { [OWNER] = "owner", [DEV] = "dev", [OTHER_OWNER] = "owner" }

-- A stub ServerKernel. `fields` overrides channel/rules/branchChannel/serverType/branch; `status` is what status() returns
-- (a function: called each time; "throw": errors); `persist`: a shared persist table (a later generation of the server).
local function makeKernel(fields, status, persist)
	local kernel = {
		kernelApi = 1,
		kernelVersion = "0.4.0",
		artifact = { id = "dev-abc" },
		generation = 1,
		branch = fields.branch,
		channel = fields.channel,
		rules = fields.rules,
		branchChannel = fields.branchChannel,
		serverType = fields.serverType,
		statusCalls = 0,
	}
	local store = persist or {}
	function kernel:persist(key, init)
		if store[key] == nil then
			store[key] = init()
		end
		return store[key]
	end
	function kernel:isDev(target)
		return roles[target.UserId] ~= nil
	end
	function kernel:devInfo(target)
		if fields.devInfoThrows then
			error("devInfo failed")
		end
		local role = roles[target.UserId]
		return { dev = role ~= nil, reason = "member", role = role }
	end
	function kernel:status()
		self.statusCalls += 1
		if status == "throw" then
			error("status failed")
		end
		local value = if type(status) == "function" then status() else status
		return value or { branch = fields.branch }
	end
	function kernel:logs()
		return {}
	end
	function kernel:send() end
	return kernel, store
end

local SWITCH = { by = OWNER, name = "Owner", at = 1, branch = "dev" }
local KERNELS = {
	-- Kernel 0.4.0 shapes.
	privateDev = { fields = { serverType = "private", channel = "dev", rules = "dev", branchChannel = "dev", branch = "feature" }, status = "throw" },
	reservedDev = { fields = { serverType = "reserved", channel = "dev", rules = "dev", branchChannel = "dev", branch = "feature" }, status = "throw" },
	studioDev = { fields = { serverType = "studio", channel = "dev", rules = "dev", branchChannel = "dev", branch = "feature" }, status = "throw" },
	studioProd = { fields = { serverType = "studio", channel = "prod", rules = "prod", branchChannel = "prod", branch = "main" } },
	privateProdBuild = { fields = { serverType = "private", channel = "prod", rules = "prod", branchChannel = "dev", branch = "feature" } },
	publicProd = {
		fields = { serverType = "public", channel = "prod", rules = "prod", branchChannel = "prod", branch = "main" },
		status = { branch = "main", signedOnly = true },
	},
	-- The owner's report: a public server switched to dev by an owner (Branch page "switched by <owner>").
	publicOwnerSwitched = {
		fields = { serverType = "public", channel = "prod", rules = "prod", branchChannel = "dev", branch = "dev" },
		status = { branch = "dev", signedOnly = false, switched = SWITCH },
	},
	-- Then the owner loaded a build on it (the switch record names the build; the branch is still the owner's).
	publicOwnerSwitchedBuild = {
		fields = { serverType = "public", channel = "prod", rules = "prod", branchChannel = "dev", branch = "dev" },
		status = { branch = "dev", signedOnly = false, switched = { by = OWNER, name = "Owner", at = 2, branch = "dev", artifact = "dev-def" } },
	},
	-- A dev-channel default branch (settings `channels`) that no owner switched to: still signed rules.
	publicDevNotSwitched = {
		fields = { serverType = "public", channel = "prod", rules = "prod", branchChannel = "dev", branch = "dev" },
		status = { branch = "dev", signedOnly = true },
	},
	-- An owner switched, but the kernel keeps signed rules for that branch (it trusts it as prod): not the owner's dev branch.
	publicSwitchedSigned = {
		fields = { serverType = "public", channel = "prod", rules = "prod", branchChannel = "dev", branch = "dev" },
		status = { branch = "dev", signedOnly = true, switched = SWITCH },
	},
	-- The owner switched this server again (queued): the record and the kernel's branch name another branch.
	publicSwitchedElsewhere = {
		fields = { serverType = "public", channel = "prod", rules = "prod", branchChannel = "dev", branch = "dev" },
		status = { branch = "other", signedOnly = false, switched = { by = OWNER, name = "Owner", at = 3, branch = "other" } },
	},
	-- A switch record without a user (never written by an owner switch).
	publicSwitchedNoUser = {
		fields = { serverType = "public", channel = "prod", rules = "prod", branchChannel = "dev", branch = "dev" },
		status = { branch = "dev", signedOnly = false, switched = { name = "?", at = 4, branch = "dev" } },
	},
	publicStatusThrows = {
		fields = { serverType = "public", channel = "prod", rules = "prod", branchChannel = "dev", branch = "dev" },
		status = "throw",
	},
	publicDevInfoThrows = {
		fields = { serverType = "public", channel = "prod", rules = "prod", branchChannel = "dev", branch = "dev", devInfoThrows = true },
		status = { branch = "dev", signedOnly = false, switched = SWITCH },
	},
	-- Older kernels: 0.3.4-0.3.8 (switched and signedOnly, no rules/branchChannel: `channel` = the rules).
	oldPublicSwitched = {
		fields = { serverType = "public", channel = "prod", branch = "dev" },
		status = { branch = "dev", channel = "prod", signedOnly = false, switched = SWITCH },
	},
	oldPrivateDev = { fields = { serverType = "private", channel = "dev", branch = "feature" }, status = "throw" },
	-- Before 0.3.4: no switch record at all (and 0.3.9's branchChannel can't be there either).
	ancientPublic = {
		fields = { serverType = "public", channel = "prod", branch = "dev" },
		status = { branch = "dev", signedOnly = true },
	},
}

-- 1. The rule (access.luau) ----------------------------------------------------------------------------------------
local EXPECT = {
	-- name = { server half, owner, non-owner dev }
	privateDev = { "dev", nil, nil },
	reservedDev = { "dev", nil, nil },
	studioDev = { "dev", nil, nil },
	studioProd = { "dev_branch_only", "dev_branch_only", "dev_branch_only" },
	privateProdBuild = { "dev_branch_only", "dev_branch_only", "dev_branch_only" },
	publicProd = { "dev_branch_only", "dev_branch_only", "dev_branch_only" },
	publicOwnerSwitched = { "owners", nil, "owners_only" },
	publicOwnerSwitchedBuild = { "owners", nil, "owners_only" },
	publicDevNotSwitched = { "owner_switch_only", "owner_switch_only", "owner_switch_only" },
	publicSwitchedSigned = { "owner_switch_only", "owner_switch_only", "owner_switch_only" },
	publicSwitchedElsewhere = { "owner_switch_only", "owner_switch_only", "owner_switch_only" },
	publicSwitchedNoUser = { "owner_switch_only", "owner_switch_only", "owner_switch_only" },
	publicStatusThrows = { "owner_switch_only", "owner_switch_only", "owner_switch_only" },
	publicDevInfoThrows = { "owners", "owners_only", "owners_only" },
	oldPublicSwitched = { "dev_branch_only", "dev_branch_only", "dev_branch_only" },
	oldPrivateDev = { "dev", nil, nil },
	ancientPublic = { "dev_branch_only", "dev_branch_only", "dev_branch_only" },
}
for name, spec in KERNELS do
	local expect = EXPECT[name]
	local kernel = makeKernel(spec.fields, spec.status)
	check(`{name}: server half`, A.serverAccess(kernel) == expect[1], A.serverAccess(kernel))
	check(`{name}: owner`, A.devAccess(kernel, owner) == expect[2], A.devAccess(kernel, owner))
	check(`{name}: non-owner dev`, A.devAccess(kernel, dev) == expect[3], A.devAccess(kernel, dev))
	local gate = A.DevAccess.new(kernel)
	check(`{name}: gate owner`, gate:refusal(owner) == expect[2], gate:refusal(owner))
	check(`{name}: gate non-owner`, gate:refusal(dev) == expect[3], gate:refusal(dev))
	check(`{name}: serverOpen`, gate:serverOpen() == (expect[1] == "dev" or expect[1] == "owners"))
	check(`{name}: ownersOnly`, gate:ownersOnly() == (expect[1] == "owners"))
end
-- Dev rules never read status() (it isn't needed, and older kernels may lack fields).
do
	local kernel = makeKernel(KERNELS.privateDev.fields, "throw")
	A.serverAccess(kernel)
	check("dev rules: no status() read", kernel.statusCalls == 0, kernel.statusCalls)
end
-- ownerSwitchedHere on its own.
check("ownerSwitchedHere: owner switch", A.ownerSwitchedHere({ branch = "dev" }, { branch = "dev", signedOnly = false, switched = SWITCH }) == true)
check("ownerSwitchedHere: no record", A.ownerSwitchedHere({ branch = "dev" }, { branch = "dev", signedOnly = false }) == false)
check("ownerSwitchedHere: signed rules", A.ownerSwitchedHere({ branch = "dev" }, { branch = "dev", signedOnly = true, switched = SWITCH }) == false)
check("ownerSwitchedHere: older kernel, no signedOnly", A.ownerSwitchedHere({ branch = "dev" }, { branch = "dev", switched = SWITCH }) == false)
check("ownerSwitchedHere: other generation's branch", A.ownerSwitchedHere({ branch = "main" }, { branch = "dev", signedOnly = false, switched = SWITCH }) == false)
-- The gate keeps the server half for `ttl` seconds (status() is not cheap) and asks the owner check every time.
do
	local kernel = makeKernel(KERNELS.publicOwnerSwitched.fields, KERNELS.publicOwnerSwitched.status)
	local gate = A.DevAccess.new(kernel, 60)
	for _ = 1, 5 do
		gate:refusal(owner)
		gate:refusal(dev)
	end
	check("gate cache: one status() read in the ttl", kernel.statusCalls == 1, kernel.statusCalls)
	local fresh = A.DevAccess.new(kernel, 0)
	fresh:refusal(owner)
	fresh:refusal(owner)
	check("gate ttl 0: status() every time", kernel.statusCalls == 3, kernel.statusCalls)
	-- The server changes under a running generation (the owner switched it again): refused once the cache expires.
	local current = { branch = "dev", signedOnly = false, switched = SWITCH }
	local live = makeKernel(KERNELS.publicOwnerSwitched.fields, function()
		return current
	end)
	local liveGate = A.DevAccess.new(live, 0)
	check("live: owner allowed", liveGate:refusal(owner) == nil)
	current = { branch = "main", signedOnly = true, switched = { by = OWNER, name = "Owner", at = 5, branch = "main" } }
	check("live: after a switch away", liveGate:refusal(owner) == "owner_switch_only", liveGate:refusal(owner))
end

-- 2. Every gate of claude.luau through the rule ---------------------------------------------------------------------------
local SID = "0123456789abcdef0123456789abcdef"
local URL = "https://quiet-river.trycloudflare.com"

local function cleanupOf(items)
	return function()
		for _, item in items do
			if type(item) == "function" then
				pcall(item)
			elseif type(item) == "thread" then
				pcall(task.cancel, item)
			elseif type(item) == "table" and item.Disconnect then
				pcall(item.Disconnect, item)
			end
		end
	end
end

-- Starts one generation of claude.luau on `spec`; returns ops, the stop function and the kernel's persist table.
local function generation(spec, persist)
	subscriptions = {}
	local items = {}
	local trove = {
		add = function(_, item)
			table.insert(items, item)
			return item
		end,
	}
	local kernel, store = makeKernel(spec.fields, spec.status, persist)
	local ops = {}
	local gate = A.DevAccess.new(kernel)
	C.registerRemoteClaude(kernel, trove, ops, nil, gate)
	return ops, cleanupOf(items), store, gate
end

local function announce(users, branch)
	local callbacks = subscriptions["TypeTorch/remote-claude"]
	if not callbacks then
		return false
	end
	for _, callback in callbacks do
		callback({ Data = { v = 1, s = SID, url = URL, b = branch, exp = os.time() + 600, u = users } })
	end
	return true
end

local function errorOf(reply)
	return if type(reply) == "table" then reply.error else reply
end

local GATED = { "claude.prompt", "claude.pair", "claude.status", "claude.cancel", "claude.deploy", "claude.events", "claude.conversations", "claude.conversation", "claude.attach", "claude.image", "logs.upload" }

local function opsCase(name, expectOwner, expectDev, open)
	local spec = KERNELS[name]
	local ops, stop, _, gate = generation(spec)
	task.wait() -- the subscribe threads
	local subscribed = subscriptions["TypeTorch/remote-claude"] ~= nil
	check(`{name}: listens for sessions`, subscribed == open, subscribed)
	check(`{name}: listens for tool wakes`, (subscriptions["TypeTorch/tool"] ~= nil) == open)
	for _, case in { { owner, expectOwner, "owner" }, { dev, expectDev, "non-owner" } } do
		local target, expect, who = case[1], case[2], case[3]
		local access = gate:reply(target) -- op "access" (server.luau below)
		if expect == nil then
			check(`{name}: access {who} ok`, type(access) == "table" and access.ok == true, errorOf(access))
		else
			check(`{name}: access {who}`, errorOf(access) == expect, errorOf(access))
		end
		local session = ops["claude.session"](target)
		check(`{name}: claude.session {who} refused`, session.refused == expect, session.refused)
		for _, op in GATED do
			local reply = ops[op](target, { id = "x", decision = "deploy", kind = "server" })
			if expect ~= nil then
				check(`{name}: {op} {who} refused`, errorOf(reply) == expect, errorOf(reply))
			else
				local code = errorOf(reply)
				check(`{name}: {op} {who} past the gate`, code ~= "dev_branch_only" and code ~= "owner_switch_only" and code ~= "owners_only" and code ~= "prod_channel", code)
			end
		end
		local removed = ops["claude.toolboxRemove"](target, { insertId = "abcdef" })
		check(`{name}: toolboxRemove {who}`, removed.error == (expect or "not_found"), removed.error)
	end
	stop()
end

opsCase("privateDev", nil, nil, true)
opsCase("publicProd", "dev_branch_only", "dev_branch_only", false)
opsCase("publicOwnerSwitched", nil, "owners_only", true)
opsCase("publicDevNotSwitched", "owner_switch_only", "owner_switch_only", false)
opsCase("oldPublicSwitched", "dev_branch_only", "dev_branch_only", false)
opsCase("oldPrivateDev", nil, nil, true)

-- A session on the owner-switched public server: owners see it, others are refused; a private dev server as before.
local function sessionCase(name, expectDev)
	players = { [OWNER] = owner, [DEV] = dev }
	local ops, stop = generation(KERNELS[name])
	task.wait()
	check(`{name}: announcement heard`, announce({ OWNER, DEV }, KERNELS[name].fields.branch))
	local mine = ops["claude.session"](owner)
	check(`{name}: owner sees the session`, mine.available == true and mine.allowed == true, mine.refused)
	local theirs = ops["claude.session"](dev)
	if expectDev == nil then
		check(`{name}: dev sees the session`, theirs.available == true and theirs.allowed == true, theirs.refused)
	else
		check(`{name}: dev refused`, theirs.available == false and theirs.refused == expectDev, theirs.refused)
		check(`{name}: dev prompt refused`, errorOf(ops["claude.prompt"](dev, "hello")) == expectDev)
	end
	-- An unpaired owner gets as far as pairing.
	check(`{name}: owner prompt needs pairing`, errorOf(ops["claude.prompt"](owner, "hello")) == "needs_pairing", errorOf(ops["claude.prompt"](owner, "hello")))
	stop()
end
sessionCase("privateDev", nil)
sessionCase("publicOwnerSwitched", "owners_only")

-- The polls and tool wakes on the owner-switched public server: only for paired owners. Both players are paired (as if
-- the dev paired before losing a role); only the owner's requests go out.
do
	players = { [OWNER] = owner, [DEV] = dev }
	requests = {}
	local ops, stop, store = generation(KERNELS.publicOwnerSwitched)
	task.wait()
	announce({ OWNER, DEV }, "dev")
	local remote = store.remoteClaude
	remote.pairings[OWNER] = { sid = SID, url = URL, token = "refresh-owner", exp = 0 }
	remote.pairings[DEV] = { sid = SID, url = URL, token = "refresh-dev", exp = 0 }
	-- Both open the Claude tab (the dev is refused before it counts); the poll manager runs every second.
	ops["claude.session"](owner)
	ops["claude.session"](dev)
	-- Tool wake messages for both.
	for _, callback in subscriptions["TypeTorch/tool"] or {} do
		callback({ Data = { v = 1, j = "job-1", s = SID, u = OWNER, x = string.rep("a", 32) } })
		callback({ Data = { v = 1, j = "job-1", s = SID, u = DEV, x = string.rep("b", 32) } })
	end
	task.wait(1.6)
	stop()
	local ownerCalls, devCalls, polls, wakes = 0, 0, 0, 0
	for _, request in requests do
		if request.auth == `Bearer tok-{OWNER}` then
			ownerCalls += 1
		elseif request.auth == `Bearer tok-{DEV}` then
			devCalls += 1
		end
		if string.find(request.path, "^/v1/game/poll") then
			polls += 1
		end
		if string.find(request.path, "^/v1/game/requests/") then
			wakes += 1
		end
	end
	check("public owner switch: the owner's long-poll runs", polls >= 1, polls)
	check("public owner switch: the owner's wake is served", wakes == 1, wakes)
	check("public owner switch: requests as the owner", ownerCalls >= 2, ownerCalls)
	check("public owner switch: nothing as the non-owner", devCalls == 0, devCalls)
	task.wait(0.3) -- let a running poll request finish before the next case
end

-- Session keeping across swaps on the owner-switched public server: only while an owner here is paired to it.
do
	local function keep(label, pairedUser, present, expectKept)
		players = present
		local persist = {}
		local ops, stop = generation(KERNELS.publicOwnerSwitched, persist)
		task.wait()
		announce({ OWNER, DEV, OTHER_OWNER }, "dev")
		if pairedUser then
			persist.remoteClaude.pairings[pairedUser] = { sid = SID, url = URL, token = "refresh", exp = 0 }
		end
		stop()
		-- The next generation (a swap, e.g. after Claude's own deploy).
		local ops2, stop2 = generation(KERNELS.publicOwnerSwitched, persist)
		local view = ops2["claude.session"](otherOwner)
		check(`keep: {label}`, (view.available == true) == expectKept, view.available)
		stop2()
	end
	keep("an owner here is paired", OWNER, { [OWNER] = owner, [DEV] = dev, [OTHER_OWNER] = otherOwner }, true)
	keep("only a non-owner is paired", DEV, { [OWNER] = owner, [DEV] = dev, [OTHER_OWNER] = otherOwner }, false)
	keep("the paired owner left", OWNER, { [DEV] = dev, [OTHER_OWNER] = otherOwner }, false)
	keep("nobody is paired", nil, { [OWNER] = owner, [OTHER_OWNER] = otherOwner }, false)
	-- A private dev server keeps it as before (no pairing needed).
	players = { [OWNER] = owner, [DEV] = dev }
	local persist = {}
	local _, stop = generation(KERNELS.privateDev, persist)
	task.wait()
	announce({ OWNER, DEV }, "feature")
	stop()
	local ops2, stop2 = generation(KERNELS.privateDev, persist)
	check("keep: private dev server, unpaired", ops2["claude.session"](dev).available == true)
	stop2()
end

-- A session announced for a public prod server is never kept (no subscription, and a stored one is dropped).
do
	local persist = { remoteClaude = { requests = {}, sent = {}, pairings = {}, session = { sid = SID, branch = "main", users = { OWNER }, url = URL, exp = os.time() + 600 } } }
	local ops, stop = generation(KERNELS.publicProd, persist)
	check("public prod: stored session dropped", persist.remoteClaude.session == nil)
	check("public prod: owner refused", ops["claude.session"](owner).refused == "dev_branch_only")
	stop()
end

-- Without a rule handed in, claude.luau makes its own (same answers).
do
	local items = {}
	local kernel = makeKernel(KERNELS.publicOwnerSwitched.fields, KERNELS.publicOwnerSwitched.status)
	local ops = {}
	C.registerRemoteClaude(kernel, { add = function(_, item) table.insert(items, item) return item end }, ops, nil)
	check("own rule: owner", ops["claude.session"](owner).refused == nil)
	check("own rule: non-owner", ops["claude.session"](dev).refused == "owners_only")
	cleanupOf(items)()
end

-- 3. The devtools server's own gates (server.luau), through its DEV_REQUEST dispatcher ------------------------------------
services.Players.PlayerRemoving = {
	Connect = function()
		return { Disconnect = function() end }
	end,
}
services.HttpService.HttpEnabled = true
services.InsertService = {}
services.MarketplaceService = {}
stubs.registry = { runningModules = {} }
stubs.state = {
	describeState = function()
		return {}
	end,
	stateRoots = function()
		return {}
	end,
}
stubs["state-inspect"] = {
	parseStateRequest = function()
		return { { side = "server" } }
	end,
	inspectState = function()
		return "state"
	end,
}
stubs["artifact-notes"] = {
	notesFromAttribute = function() end,
	parseArtifactNotes = function()
		return { changes = {}, identity = {} }
	end,
}
stubs.ab = {
	kernelHasExperiments = function()
		return false
	end,
	NEEDS_KERNEL_AB = "kernel 0.2.3 needed",
}
stubs.status = { analyticsStatus = function() end } -- analytics/status
stubs.sync = { -- assets/sync
	assetFacts = function() end,
	assetReport = function()
		return {}
	end,
}
stubs["network-server"] = { registerNetworkOps = function() end }
stubs["remote-debug"] = { registerRemoteDebug = function() -- framework 0.5.0 (plans/25): its own test, test-remote-debug.luau
	return false
end }
stubs.hints = { describeFleetError = function() end } -- analytics/hints (health.luau)
-- Dex: the real explorer-server.luau over a stub explorer core whose "set" needs canEdit (as core.ts's edits do).
stubs.core = {
	EXPLORER_OPS = { "set", "props" },
	Registry = {
		new = function()
			return {}
		end,
	},
	explorerHandlers = function(_, canEdit)
		return {
			set = function()
				if not canEdit() then
					error("read-only here", 0)
				end
				return "changed"
			end,
			props = function()
				return { editable = canEdit() }
			end,
		}
	end,
}
PATHS.server = "out/devtools/server.luau"
PATHS.protocol = "out/devtools/protocol.luau"
PATHS["explorer-server"] = "out/devtools/explorer-server.luau"
PATHS.health = "out/devtools/health.luau"
-- Which rule each registration got (server.luau must hand the same one to Claude, Dex and Manage).
local handed = {}
local ES = loadModule("explorer-server")
stubs["explorer-server"] = {
	registerExplorerOps = function(register, kernel, gate)
		handed.explorer = gate
		return ES.registerExplorerOps(register, kernel, gate)
	end,
}
stubs.claude = {
	registerRemoteClaude = function(kernel, trove, ops, deps, gate)
		handed.claude = gate
		return C.registerRemoteClaude(kernel, trove, ops, deps, gate)
	end,
}
stubs["admin-server"] = {
	registerAdminOps = function(_, _, _, gate)
		handed.admin = gate
	end,
}
local S = loadModule("server")

local stranger = player(404, "Stranger")
local function devServer(fields, status)
	handed = {}
	subscriptions = {}
	local raws, sent, items = {}, {}, {}
	local dispatcher = {
		setRaw = function(_, name, fn)
			raws[name] = fn
		end,
		removeRaw = function() end,
		stats = {},
	}
	local trove = {
		add = function(_, item)
			table.insert(items, item)
			return item
		end,
		connect = function(_, signal, fn)
			local connection = signal:Connect(fn)
			table.insert(items, connection)
			return connection
		end,
	}
	local kernel = makeKernel(fields, status)
	function kernel:send(target, channel, id, ok, result)
		table.insert(sent, { channel = channel, id = id, ok = ok, result = result })
	end
	S.startDevtoolsServer(kernel, dispatcher, trove)
	local nextId = 0
	local function request(target, op, payload)
		nextId += 1
		raws["__tt/dev"](target, nextId, op, payload)
		for _, reply in sent do
			if reply.id == nextId and reply.channel == "__tt/devres" then
				return reply.ok, reply.result
			end
		end
		return false, "no reply"
	end
	return request, cleanupOf(items)
end

local SERVER_CASES = {
	-- name, fields, a status() that works, owner's refusal, non-owner's refusal
	{ "private dev server", KERNELS.privateDev.fields, { branch = "feature" }, nil, nil },
	{ "public prod branch", KERNELS.publicProd.fields, KERNELS.publicProd.status, "dev_branch_only", "dev_branch_only" },
	{ "public dev branch, owner switch", KERNELS.publicOwnerSwitched.fields, KERNELS.publicOwnerSwitched.status, nil, "owners_only" },
	{ "public dev branch, no owner switch", KERNELS.publicDevNotSwitched.fields, KERNELS.publicDevNotSwitched.status, "owner_switch_only", "owner_switch_only" },
	{ "older kernel, public, switched", KERNELS.oldPublicSwitched.fields, KERNELS.oldPublicSwitched.status, "dev_branch_only", "dev_branch_only" },
	{ "older kernel, private dev", KERNELS.oldPrivateDev.fields, { branch = "feature" }, nil, nil },
}
for _, case in SERVER_CASES do
	local label, fields, status = case[1], case[2], case[3]
	local request, stop = devServer(fields, status)
	check(`{label}: one rule handed to Claude, Dex and Manage`, handed.claude ~= nil and handed.claude == handed.explorer and handed.explorer == handed.admin)
	for _, who in { { owner, case[4], "owner", true }, { dev, case[5], "non-owner", false } } do
		local target, expect, name, isOwner = who[1], who[2], who[3], who[4]
		local ok, reply = request(target, "access")
		check(`{label}: op access, {name}`, ok and (if expect == nil then reply.ok == true else reply.ok == false and reply.error == expect), if ok then reply.error else reply)
		ok, reply = request(target, "status")
		check(`{label}: status facts.access, {name}`, ok and reply.facts.access == (expect or "ok"), if ok then reply.facts.access else reply)
		-- Modules > State: owners everywhere, other devs where the tools are open to them.
		ok, reply = request(target, "state.inspect", { side = "server" })
		local stateOpen = isOwner or expect == nil
		check(`{label}: state.inspect, {name}`, if stateOpen then ok == true else (ok == false and reply == "owners_only"), reply)
		-- Dex edits through explorer-server.luau.
		ok, reply = request(target, "explorer.set", {})
		check(`{label}: explorer.set, {name}`, if expect == nil then (ok and reply == "changed") else (not ok and reply == "read-only here"), reply)
		ok, reply = request(target, "explorer.props", {})
		check(`{label}: explorer.props editable, {name}`, ok and reply.editable == (expect == nil), if ok then reply.editable else reply)
		-- Claude through the same dispatcher.
		ok, reply = request(target, "claude.session")
		check(`{label}: claude.session, {name}`, ok and reply.refused == expect, if ok then reply.refused else reply)
		ok, reply = request(target, "logs.upload", { kind = "server" })
		local code = if ok then reply.error else reply
		check(`{label}: logs.upload, {name}`, if expect ~= nil then code == expect else code == "not_connected", code)
	end
	local ok, reply = request(stranger, "access")
	check(`{label}: not a dev`, ok == false and reply == "not a dev", reply)
	stop()
end

-- 4. The run_luau hint (Server > Status): where Claude works for this player (facts.access); older frameworks: rules.
do
	local H = loadModule("health")
	local function runLuauOff(status, facts)
		local ok, issues = pcall(H.checkHealth, status, facts)
		if not ok then
			return "error: " .. tostring(issues)
		end
		for _, issue in issues do
			if issue.title == "run_luau off" then
				return true
			end
		end
		return false
	end
	local devStatus = { serverType = "private", branch = "feature", channel = "dev", rules = "dev", kernelVersion = "0.4.0", kernelApi = 1, history = {}, uptime = 100, players = 1, maxPlayers = 10, appliedSeq = 1 }
	local publicStatus = { serverType = "public", branch = "dev", channel = "dev", rules = "prod", kernelVersion = "0.4.0", kernelApi = 1, history = {}, uptime = 100, players = 1, maxPlayers = 10, appliedSeq = 1 }
	check("hint: dev rules, no facts.access (older framework)", runLuauOff(devStatus, { loadstring = false }) == true, runLuauOff(devStatus, { loadstring = false }))
	check("hint: prod rules, no facts.access", runLuauOff(publicStatus, { loadstring = false }) == false)
	check("hint: owner on an owner-switched public server", runLuauOff(publicStatus, { loadstring = false, access = "ok" }) == true)
	check("hint: non-owner there", runLuauOff(publicStatus, { loadstring = false, access = "owners_only" }) == false)
	check("hint: loadstring on", runLuauOff(publicStatus, { loadstring = true, access = "ok" }) == false)
end

print(`dev access: {passed} passed, {failed} failed`)
-- Exit now, like test-messaging / test-settings: the stub kernels' scheduler leftovers must not keep Lune running.
process.exit(if failed == 0 then 0 else 1)
