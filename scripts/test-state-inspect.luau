-- Offline test of the compiled state inspector core (out/devtools/state-inspect.luau) under Lune: the roots list,
-- module fields (not methods), previews (strings, numbers, datatypes, Instances, Players, functions, threads, buffers),
-- never calling a function or metamethod, cycles, paging, arrays, Maps (Instance keys, reference segments) and Sets,
-- the depth limit, filters with kept nodes, request validation, and FRAMEWORK_VERSION = package.json's version.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-state-inspect.luau ../framework/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-state-inspect.luau
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local Instance = roblox.Instance
local root = process.args[1] or "./"

local function load(path)
	local source = fs.readFile(root .. path)
	return luau.load(source, { debugName = path })()
end
local core = load("out/devtools/state-inspect.luau")

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end

local function q(rootToken, path, extra)
	local query = { side = "server", root = rootToken, path = path or {}, page = 0 }
	for k, v in extra or {} do
		query[k] = v
	end
	return query
end
local function keys(reply)
	local list = {}
	for _, entry in reply.entries do
		table.insert(list, entry.key)
	end
	return table.concat(list, ",")
end
local function entry(reply, key)
	for _, item in reply.entries do
		if item.key == key then
			return item
		end
	end
	return nil
end

-- Fixture -------------------------------------------------------------------------------------------------------------
local game = Instance.new("DataModel")
local workspace = game:GetService("Workspace")
local map = Instance.new("Folder")
map.Name = "Map"
map.Parent = workspace
local coin = Instance.new("Part")
coin.Name = "Coin"
coin.Parent = map
local twin = Instance.new("Part") -- same full name as `coin`: told apart by occurrence
twin.Name = "Coin"
twin.Parent = map
local okPlayer, player = pcall(Instance.new, "Player")
if okPlayer then
	player.Name = "Alice"
end

-- A roblox-ts class: the instance's metatable is the class, whose own __index is itself; methods live on the class.
local called = {}
local CoinService = setmetatable({}, {
	__tostring = function()
		called.classTostring = true
		return "CoinService"
	end,
})
CoinService.__index = CoinService
function CoinService.grant()
	called.method = true
end
local service = setmetatable({}, CoinService)
service.total = 42
service.name = "coins\n\"main\""
service.ratio = 0.125
service.nan = 0 / 0
service.huge = math.huge
service.flag = true
service.onChanged = function()
	called.field = true
end
service.worker = coroutine.create(function() end)
service.blob = buffer.create(1234)
service.position = roblox.Vector3.new(1, 2, 3)
service.color = roblox.Color3.new(1, 0, 0)
service.size = roblox.UDim2.new(0.5, 10, 1, -4)
service.frame = roblox.CFrame.new(1, 2, 3)
service.coin = coin
service.player = if okPlayer then player else nil
service.long = string.rep("x", 500)
service.bad = "ok\255\254end"
service.empty = {}
service.list = {}
for i = 1, 250 do
	service.list[i] = i * 10
end
service.byName = {}
for i = 1, 250 do
	service.byName[string.format("key%03d", i)] = i
end
service.owners = { [coin] = "first", [twin] = "second" }
if okPlayer then
	service.owners[player] = { coins = 7 }
end
service.tags = { red = true, blue = true }
service.mixed = { [1] = "a", [3] = "c", x = "y" }
service.numbers = { [0.1] = "tenth", [1e300] = "big", [-5] = "neg", [math.huge] = "inf" }
-- Metamethods that would fire if the inspector used anything but raw access.
service.trap = setmetatable({ real = 1 }, {
	__index = function()
		called.index = true
		return "x"
	end,
	__len = function()
		called.len = true
		return 99
	end,
	__iter = function()
		called.iter = true
		return next, {}
	end,
	__tostring = function()
		called.tostring = true
		return "trap"
	end,
	__eq = function()
		called.eq = true
		return true
	end,
})
service.proxy = newproxy(true)
getmetatable(service.proxy).__tostring = function()
	called.proxy = true
	return "proxy"
end
-- Cycles: a self reference, a child pointing back, and a shared (non-cyclic) table.
local shared = { value = 1 }
service.cache = { shared = shared, again = shared }
service.cache.self = service.cache
service.cache.child = { parent = service.cache, root = service }
-- 30 levels deep.
local deep = {}
service.deep = deep
for _ = 1, 30 do
	deep.next = {}
	deep = deep.next
end
deep.bottom = true

local other = setmetatable({ count = 1 }, CoinService)
local stores = { session = { joins = 3 }, settings = { volume = 0.5 } }
local roots = {
	{ token = "CoinService", label = "CoinService", kind = "module", value = service },
	{ token = "Zeta", label = "Zeta", kind = "module", value = other },
	{ token = "Zeta#2", label = "Zeta#2", kind = "module", value = {} },
	{ token = core.PERSIST_ROOT, label = "persist", kind = "persist", value = stores },
}

-- Roots ------------------------------------------------------------------------------------------------------------
local list = core.inspectState(roots, q(""))
check("roots: every module and persist, in order", keys(list) == "CoinService,Zeta,Zeta#2,persist", keys(list))
check("roots: types", list.entries[1].type == "module" and list.entries[4].type == "persist" and list.type == "roots")
check("roots: persist preview counts keys", list.entries[4].preview == "2 keys", list.entries[4].preview)
check("roots: an empty module doesn't open", list.entries[3].expandable == false and list.entries[1].expandable == true)
check("roots: segments are the tokens", list.entries[4].seg == core.PERSIST_ROOT and list.entries[1].seg == "CoinService")
local filtered = core.inspectState(roots, q("", {}, { filter = "zeta", keep = { core.PERSIST_ROOT } }))
check("roots: filter + keep", keys(filtered) == "Zeta,Zeta#2,persist", keys(filtered))

-- Module fields --------------------------------------------------------------------------------------------------------
local fields = core.inspectState(roots, q("CoinService", {}, {}))
check("module: type", fields.type == "module", fields.type)
check("module: own fields only (no class methods)", entry(fields, "grant") == nil and entry(fields, "__index") == nil and entry(fields, "total") ~= nil)
check("module: sorted by key", fields.entries[1].key == "bad" and fields.entries[2].key == "blob", keys(fields))
local e = entry(fields, "total")
check("number", e.type == "number" and e.preview == "42" and not e.expandable, e.preview)
check("float", entry(fields, "ratio").preview == "0.125", entry(fields, "ratio").preview)
check("nan / inf", entry(fields, "nan").preview == "nan" and entry(fields, "huge").preview == "inf")
check("boolean", entry(fields, "flag").preview == "true" and entry(fields, "flag").type == "boolean")
check("string: quoted and escaped", entry(fields, "name").preview == [["coins\n\"main\""]], entry(fields, "name").preview)
check("string: truncated with the rest counted", entry(fields, "long").preview == '"' .. string.rep("x", 80) .. '..." (+420)', entry(fields, "long").preview)
check("string: invalid UTF-8 escaped", entry(fields, "bad").preview == [["ok\xff\xfeend"]], entry(fields, "bad").preview)
check("function: named, never called", entry(fields, "onChanged").type == "function" and entry(fields, "onChanged").preview == "function" and not called.field)
check("thread", entry(fields, "worker").preview == "thread")
check("buffer: size", entry(fields, "blob").preview == "buffer(1234 bytes)", entry(fields, "blob").preview)
check("Vector3 via tostring", entry(fields, "position").type == "Vector3" and entry(fields, "position").preview == tostring(service.position), entry(fields, "position").preview)
check("Color3 / UDim2 / CFrame via tostring", entry(fields, "color").preview == tostring(service.color) and entry(fields, "size").preview == tostring(service.size) and entry(fields, "frame").type == "CFrame")
check("Instance: class and full path", entry(fields, "coin").type == "Part" and entry(fields, "coin").preview == "Workspace.Map.Coin", entry(fields, "coin").preview)
if okPlayer then
	check("Player: its name", entry(fields, "player").type == "Player" and entry(fields, "player").preview == "Alice", entry(fields, "player").preview)
else
	print("note: Lune can't create a Player here; the Player preview isn't checked")
end
check("userdata (newproxy): no tostring", entry(fields, "proxy").preview == "userdata" and not called.proxy)
check("empty table", entry(fields, "empty").preview == "{}" and entry(fields, "empty").expandable == false and entry(fields, "empty").type == "table")
check("array preview", entry(fields, "list").type == "array" and entry(fields, "list").preview == "[10, 20, 30, 40, ...] (200+)", entry(fields, "list").preview)
check("set", entry(fields, "tags").type == "set", entry(fields, "tags").type)
check("map: non-string keys", entry(fields, "owners").type == "map" and entry(fields, "mixed").type == "map")
check("table (string keys)", entry(fields, "byName").type == "table")

-- Never calls anything ---------------------------------------------------------------------------------------------------
local trap = core.inspectState(roots, q("CoinService", { "strap" }))
check("trap: raw fields", keys(trap) == "real", keys(trap))
check("no metamethod or method ran", next(called) == nil, (function()
	local names = {}
	for name in called do
		table.insert(names, name)
	end
	return table.concat(names, ",")
end)())

-- Paging -----------------------------------------------------------------------------------------------------------
local page0 = core.inspectState(roots, q("CoinService", { "slist" }))
check("array: 250 entries, 3 pages", page0.size == 250 and page0.pages == 3 and page0.hasMore and #page0.entries == 100, page0.size)
check("array: by index", page0.entries[1].key == "1" and page0.entries[1].preview == "10" and page0.entries[100].key == "100")
local page2 = core.inspectState(roots, q("CoinService", { "slist" }, { page = 2 }))
check("array: last page", #page2.entries == 50 and page2.entries[1].key == "201" and not page2.hasMore)
local clamped = core.inspectState(roots, q("CoinService", { "slist" }, { page = 99 }))
check("page clamps to the last", clamped.page == 2 and clamped.entries[1].key == "201", clamped.page)
local byName = core.inspectState(roots, q("CoinService", { "sbyName" }, { page = 1 }))
check("table: sorted, second page", byName.entries[1].key == "key101" and byName.entries[100].key == "key200", byName.entries[1].key)
local arrayFilter = core.inspectState(roots, q("CoinService", { "slist" }, { filter = "25" }))
check("array filter: index text", keys(arrayFilter) == "25,125,225,250", keys(arrayFilter))

-- Maps with Instance keys, reference segments --------------------------------------------------------------------
local owners = core.inspectState(roots, q("CoinService", { "sowners" }))
local refs = {}
for _, item in owners.entries do
	refs[item.preview] = item.seg
end
check("map: Instance keys shown by path", entry(owners, "[Workspace.Map.Coin]") ~= nil, keys(owners))
check("map: same path told apart (r1, r2)", refs['"first"'] == "r1:Workspace.Map.Coin" or refs['"first"'] == "r2:Workspace.Map.Coin", refs['"first"'])
check("map: the two segments differ", refs['"first"'] ~= refs['"second"'] and refs['"second"'] ~= nil)
if okPlayer then
	local alice = entry(owners, "[Alice]")
	check("map: Player key", alice ~= nil and alice.seg == "r1:Alice" and alice.expandable, keys(owners))
	local inner = core.inspectState(roots, q("CoinService", { "sowners", "r1:Alice" }))
	check("map: opens through a reference segment", keys(inner) == "coins" and inner.entries[1].preview == "7", keys(inner))
end
local numbers = core.inspectState(roots, q("CoinService", { "snumbers" }))
check("number keys: sorted numerically", keys(numbers) == "-5,0.1,1e+300,inf", keys(numbers))
local allFound = true
for _, item in numbers.entries do
	local back = core.inspectState(roots, q("CoinService", { "snumbers", item.seg }))
	if back.missing or back.type ~= "string" then
		allFound = false
	end
end
check("number keys: every segment finds its value", allFound)
local mixed = core.inspectState(roots, q("CoinService", { "smixed" }))
check("mixed keys: numbers first, then strings", keys(mixed) == "1,3,x", keys(mixed))

-- Cycles ------------------------------------------------------------------------------------------------------------
local cache = core.inspectState(roots, q("CoinService", { "scache" }))
local self = entry(cache, "self")
check("cycle: self", self.cycle == true and not self.expandable and self.preview == "cycle: CoinService.cache", self.preview)
check("shared table is not a cycle", entry(cache, "shared").expandable and entry(cache, "again").expandable and not entry(cache, "again").cycle)
local child = core.inspectState(roots, q("CoinService", { "scache", "schild" }))
check("cycle: back to the parent", entry(child, "parent").cycle == true and entry(child, "parent").preview == "cycle: CoinService.cache", entry(child, "parent").preview)
check("cycle: back to the module", entry(child, "root").cycle == true and entry(child, "root").preview == "cycle: CoinService", entry(child, "root").preview)

-- Depth -------------------------------------------------------------------------------------------------------------
local path = { "sdeep" }
for _ = 2, core.STATE_MAX_DEPTH do
	table.insert(path, "snext")
end
local atMax = core.inspectState(roots, q("CoinService", path))
check("depth: the deepest node lists its entries", #atMax.entries == 1 and atMax.entries[1].key == "next", keys(atMax))
check("depth: below it nothing opens", atMax.entries[1].expandable == false)
local above = core.inspectState(roots, q("CoinService", { table.unpack(path, 1, #path - 1) }))
check("depth: one up still opens", above.entries[1].expandable == true)
table.insert(path, "snext")
local tooDeep = core.inspectState(roots, q("CoinService", path))
check("depth: deeper is refused", tooDeep.tooDeep == true and #tooDeep.entries == 0)

-- Filter, keep, missing, scalars ----------------------------------------------------------------------------------
local filter = core.inspectState(roots, q("CoinService", {}, { filter = "CO", keep = { "slist" } }))
check("filter: case-insensitive, kept node listed", keys(filter) == "coin,color,list", keys(filter))
check("filter: matched count", filter.matched == 3 and filter.size > 3)
local gone = core.inspectState(roots, q("CoinService", { "snope" }))
check("missing key", gone.missing == true and gone.type == "nil")
local goneRoot = core.inspectState(roots, q("Nope"))
check("missing root", goneRoot.missing == true)
local scalar = core.inspectState(roots, q("CoinService", { "stotal" }))
check("a scalar node: its preview, no entries", scalar.type == "number" and scalar.preview == "42" and #scalar.entries == 0)
local persist = core.inspectState(roots, q(core.PERSIST_ROOT))
check("persist: stores by key", persist.type == "persist" and keys(persist) == "session,settings", keys(persist))
local session = core.inspectState(roots, q(core.PERSIST_ROOT, { "ssession" }))
check("persist: a store's values", keys(session) == "joins" and session.entries[1].preview == "3")

-- Big tables ----------------------------------------------------------------------------------------------------------
local big = {}
for i = 1, 25000 do
	big["k" .. i] = i
end
service.big = big
local started = os.clock()
local bigReply = core.inspectState(roots, q("CoinService", { "sbig" }))
local elapsed = os.clock() - started
check("big table: first 20000 keys listed", bigReply.truncated == true and bigReply.size == 25000 and bigReply.matched == 20000, bigReply.matched)
check("big table: under 0.5 s", elapsed < 0.5, string.format("%.3f s", elapsed))
service.big = nil

-- Node ids -----------------------------------------------------------------------------------------------------------
check("node ids: no two paths collide", core.stateNodeId({ "ab", "c" }) ~= core.stateNodeId({ "a", "bc" }))

-- Request validation ------------------------------------------------------------------------------------------------
local function parse(raw)
	return core.parseStateRequest(raw)
end
check("request: one query", type(parse({ side = "server", root = "", path = {} })) == "table")
check("request: a batch", #parse({ queries = { q(""), q("CoinService") } }) == 2)
local many = {}
for _ = 1, core.STATE_MAX_QUERIES + 1 do
	table.insert(many, q(""))
end
check("request: too many queries", parse({ queries = many }) == "too_many", parse({ queries = many }))
check("request: bad side", parse({ side = "both", root = "" }) == "bad_side")
check("request: bad page", parse({ side = "server", root = "", page = -1 }) == "bad_page" and parse({ side = "server", root = "", page = 1.5 }) == "bad_page")
check("request: bad path", parse({ side = "server", root = "", path = { 1, 2 } }) == "bad_path" and parse({ side = "server", root = "", path = "x" }) == "bad_path")
local longPath = {}
for _ = 1, core.STATE_MAX_DEPTH + 2 do
	table.insert(longPath, "sx")
end
check("request: path too long", parse({ side = "server", root = "", path = longPath }) == "bad_path")
check("request: holes in a list", parse({ side = "server", root = "", path = { [1] = "a", [3] = "c" } }) == "bad_path")
local cutFilter = parse({ side = "server", root = "", filter = string.rep("f", 200) })
check("request: filter cut to 64", #cutFilter[1].filter == 64)
check("request: not a table", parse("x") == "bad_query")

-- Version -----------------------------------------------------------------------------------------------------------
local version = load("out/version.luau").FRAMEWORK_VERSION
local package = serde.decode("json", fs.readFile(root .. "package.json"))
check("FRAMEWORK_VERSION matches package.json", version == package.version, `{version} vs {package.version}`)

print(`state inspector: {passed} passed, {failed} failed`)
process.exit(if failed == 0 then 0 else 1)
