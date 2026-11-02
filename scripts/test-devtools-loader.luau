--!nocheck
-- runtime/devtools-loader under Lune, with a small Instance stub: who gets the devtools and when a client starts them.
-- Run after `bun run build`, from framework/: lune run scripts/test-devtools-loader.luau
-- Not Roblox: replication, PlayerGui visibility and the real require cache need a live test.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local task = require("@lune/task")

local passed, failed = 0, 0
local function check(name, ok)
	if ok then
		passed += 1
	else
		failed += 1
		print("FAIL " .. name)
	end
end

local function signal()
	local handlers = {}
	return {
		Connect = function(_, fn)
			table.insert(handlers, fn)
			return { Disconnect = function() table.remove(handlers, table.find(handlers, fn)) end }
		end,
		fire = function(...)
			for _, fn in table.clone(handlers) do task.spawn(fn, select(2, ...)) end
		end,
	}
end

local Inst = {}
Inst.__index = Inst
local function new(name, parent)
	local self = setmetatable({ Name = name, kids = {}, attrs = {}, ChildAdded = signal() }, Inst)
	if parent then self:setParent(parent) end
	return self
end
function Inst:setParent(parent)
	if self.parent then table.remove(self.parent.kids, table.find(self.parent.kids, self)) end
	self.parent = parent
	if parent then
		table.insert(parent.kids, self)
		parent.ChildAdded.fire(parent.ChildAdded, self)
	end
end
function Inst:FindFirstChild(name)
	for _, kid in self.kids do
		if kid.Name == name then return kid end
	end
end
function Inst:WaitForChild(name) return self:FindFirstChild(name) end
function Inst:FindFirstChildOfClass(name) return self:FindFirstChild(name) end
function Inst:GetChildren() return table.clone(self.kids) end
function Inst:GetDescendants()
	local all = {}
	for _, kid in self.kids do
		table.insert(all, kid)
		for _, deep in kid:GetDescendants() do table.insert(all, deep) end
	end
	return all
end
function Inst:FindFirstAncestor(name)
	local at = self.parent
	while at do
		if at.Name == name then return at end
		at = at.parent
	end
end
function Inst:SetAttribute(k, v) self.attrs[k] = v end
function Inst:GetAttribute(k) return self.attrs[k] end
function Inst:Destroy() self:setParent(nil) self.destroyed = true end
function Inst:Clone()
	local copy = new(self.Name)
	copy.attrs = table.clone(self.attrs)
	for _, kid in self.kids do kid:Clone():setParent(copy) end
	return copy
end
Inst.__newindex = function(self, k, v)
	if k == "Parent" then self:setParent(v) else rawset(self, k, v) end
end
local baseIndex = Inst
Inst.__index = function(self, k)
	if k == "Parent" then return rawget(self, "parent") end
	return baseIndex[k]
end

local function newTrove()
	local trove = { items = {} }
	function trove:add(item) table.insert(self.items, item) return item end
	function trove:connect(sig, fn) return self:add(sig:Connect(fn)) end
	function trove:extend() return newTrove() end
	function trove:remove(item)
		table.remove(self.items, table.find(self.items, item))
		item:Destroy()
	end
	function trove:clean()
		for _, item in self.items do
			if type(item) == "function" then item()
			elseif type(item) == "table" and item.Destroy then item:Destroy() end
		end
		self.items = {}
	end
	return trove
end

local SERVER_ONLY_SAMPLE = { "server", "admin-server", "claude" }

-- One world: a generation tree, the loader in it, the stubs it imports.
local function world(opts)
	local tree = new("art#1")
	if opts.onDemand then tree:SetAttribute("DevtoolsOnDemand", true) end
	local include = new("include", tree)
	local out = new("out", new("framework", new("@typetorch", new("node_modules", include))))
	local runtime = new("runtime", out)
	local scriptInst = new("devtools-loader", runtime)
	if opts.folder then
		local folder = new("devtools", out)
		new("client", folder)
		new("widgets", folder)
		for _, name in SERVER_ONLY_SAMPLE do new(name, folder) end
	end
	local w = { tree = tree, out = out, warnings = {}, serverStarts = 0, clientStarts = 0, started = 0, swept = 0, devs = opts.devs or {}, devHandlers = {} }
	local localGui = new("PlayerGui")
	local localPlayer = new("Me")
	localGui:setParent(localPlayer)
	w.localGui = localGui
	local players = { list = {}, PlayerAdded = signal(), PlayerRemoving = signal(), LocalPlayer = localPlayer }
	function players:GetPlayers() return table.clone(self.list) end
	w.players = players
	local TS
	local devtoolsModules = {
		server = { startDevtoolsServer = function() w.serverStarts += 1 if opts.serverThrows then error("boom") end end },
		client = {
			startDevtoolsClient = function()
				w.clientStarts += 1
				if opts.clientThrows then error("boom") end
				return { started = function() w.started += 1 end }
			end,
		},
	}
	TS = {
		getModule = function() return "services" end,
		Promise = {
			new = function(executor)
				local ok, value = pcall(function()
					local result
					executor(function(v) result = v end)
					return result
				end)
				return { expect = function() if not ok then error(value) end return value end }
			end,
		},
		import = function(_, from, ...)
			if from == "services" then return { Players = players } end
			local parts = { ... }
			local last = parts[#parts]
			if last == "typetorch" then
				return {
					TypeTorch = {
						isDev = function(_, player) return w.devs[player.Name] == true end,
						onPlayerDevChanged = function(_, fn) table.insert(w.devHandlers, fn) return function() end end,
					},
				}
			elseif last == "dev-gui" then
				return { sweepStaleMenus = function() w.swept += 1 end }
			end
			assert(parts[1] == "devtools", "unexpected import " .. last)
			-- TS.import waits forever on a missing child: a test failure here, not a hang.
			assert(out:FindFirstChild("devtools"), "imported devtools with no folder")
			return devtoolsModules[last]
		end,
	}
	local env = setmetatable({
		script = scriptInst,
		task = task,
		os = os,
		_G = { [scriptInst] = TS },
		warn = function(...) table.insert(w.warnings, table.concat({ ... }, " ")) end,
	}, { __index = _G })
	w.loader = luau.load(fs.readFile("out/runtime/devtools-loader.luau"), { debugName = "loader", environment = env })()
	return w
end

local function player(w, name)
	local p = new(name)
	new("PlayerGui", p)
	p.Parent = new("Players")
	table.insert(w.players.list, p)
	return p
end

-- Old kernel: no attribute, nothing is copied to anyone, and the client starts from its tree.
do
	local w = world({ folder = true, devs = { Dev = true } })
	local dev = player(w, "Dev")
	local trove = newTrove()
	w.loader.loadDevtoolsServer({}, {}, trove)
	task.wait()
	check("old kernel: server starts", w.serverStarts == 1)
	check("old kernel: no copy", dev:FindFirstChild("PlayerGui"):FindFirstChild("TypeTorchDevtools") == nil)
	local c = world({ folder = true })
	local started = c.loader.loadDevtoolsClient({ generation = 1 }, {}, newTrove())
	check("old kernel: client starts at once", c.clientStarts == 1)
	check("sweep runs", c.swept == 1)
	started()
	check("old kernel: started hook", c.started == 1)
end

-- New kernel: only devs get a copy, without the server-only modules.
do
	local w = world({ onDemand = true, folder = true, devs = { Dev = true } })
	local dev, normal = player(w, "Dev"), player(w, "Normal")
	local trove = newTrove()
	w.loader.loadDevtoolsServer({}, {}, trove)
	task.wait()
	local copy = dev:FindFirstChild("PlayerGui"):FindFirstChild("TypeTorchDevtools")
	check("dev gets a copy", copy ~= nil)
	check("non-dev gets none", normal:FindFirstChild("PlayerGui"):FindFirstChild("TypeTorchDevtools") == nil)
	check("copy names its generation", copy and copy:GetAttribute("Generation") == "art#1")
	check("copy keeps client modules", copy and copy:FindFirstChild("client") ~= nil and copy:FindFirstChild("widgets") ~= nil)
	for _, name in SERVER_ONLY_SAMPLE do
		check("copy has no " .. name, copy and copy:FindFirstChild(name) == nil)
	end
	check("the server's own folder stays whole", w.out:FindFirstChild("devtools"):FindFirstChild("server") ~= nil)
	-- Revoked, then granted again mid-session.
	w.devs.Dev = false
	w.devHandlers[1](dev, { dev = false })
	check("revoked: copy gone", copy.destroyed == true)
	w.devs.Normal = true
	w.devHandlers[1](normal, { dev = true })
	check("granted: copy arrives", normal:FindFirstChild("PlayerGui"):FindFirstChild("TypeTorchDevtools") ~= nil)
	-- A join.
	w.devs.Late = true
	local late = player(w, "Late")
	w.players.PlayerAdded.fire(w.players.PlayerAdded, late)
	check("join: dev gets a copy", late:FindFirstChild("PlayerGui"):FindFirstChild("TypeTorchDevtools") ~= nil)
	-- The generation ends.
	local kept = normal:FindFirstChild("PlayerGui"):FindFirstChild("TypeTorchDevtools")
	trove:clean()
	check("swap out: copies destroyed", kept.destroyed == true)
end

-- New kernel, client: a non-dev never imports; a dev starts when the right generation's copy arrives.
do
	local w = world({ onDemand = true })
	local started = w.loader.loadDevtoolsClient({ generation = 1 }, {}, newTrove())
	task.wait()
	started()
	check("non-dev client: no import, game goes on", w.clientStarts == 0 and #w.warnings == 0)

	local stale = new("TypeTorchDevtools")
	stale:SetAttribute("Generation", "art#0")
	stale:SetAttribute("Instances", 1)
	new("client", stale)
	stale.Parent = w.localGui
	task.wait()
	check("another generation's copy is ignored", w.clientStarts == 0)

	local copy = new("TypeTorchDevtools")
	copy:SetAttribute("Generation", "art#1")
	copy:SetAttribute("Instances", 2)
	new("client", copy)
	copy.Parent = w.localGui
	task.wait(0.3)
	check("waits for the copy to finish replicating", w.clientStarts == 0)
	new("widgets", copy)
	task.wait(0.3)
	check("complete copy starts the devtools", w.clientStarts == 1)
	check("copy placed in the tree", w.out:FindFirstChild("devtools") ~= nil and w.out:FindFirstChild("devtools"):FindFirstChild("widgets") ~= nil)
	check("original stays for a retry", copy.Parent == w.localGui)
	check("late start still runs the started hook", w.started == 1)
end

-- A generation stopped while waiting: no start.
do
	local w = world({ onDemand = true })
	local trove = newTrove()
	w.loader.loadDevtoolsClient({ generation = 1 }, {}, trove)
	task.wait()
	local copy = new("TypeTorchDevtools")
	copy:SetAttribute("Generation", "art#1")
	copy:SetAttribute("Instances", 2)
	new("client", copy)
	copy.Parent = w.localGui
	trove:clean()
	new("widgets", copy)
	task.wait(0.3)
	check("stopped generation starts nothing", w.clientStarts == 0)
end

-- Failures warn and never throw.
do
	local w = world({ folder = true, serverThrows = true })
	local ok = pcall(function() w.loader.loadDevtoolsServer({}, {}, newTrove()) end)
	check("server failure doesn't throw", ok and #w.warnings == 1)
	local c = world({ folder = true, clientThrows = true })
	local ok2 = pcall(function() c.loader.loadDevtoolsClient({ generation = 1 }, {}, newTrove())() end)
	check("client failure doesn't throw", ok2 and #c.warnings == 1)
end

print(`{passed} passed, {failed} failed (test-devtools-loader)`)
if failed > 0 then
	require("@lune/process").exit(1)
end
