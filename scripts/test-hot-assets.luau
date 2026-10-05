-- Offline test of hot assets (plans/13) under Lune: the compiled manifest parser and AssetSync decision
-- (out/assets/manifest.luau), the Status issues (out/devtools/health.luau), and the live-copy rules of
-- out/assets/dom.luau on a Lune DataModel (clones of a template never count). Run after `bun run build` (Lune is
-- pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-hot-assets.luau ../framework/out/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local base = process.args[1] or "out/"

local function load(path, env)
	return luau.load(fs.readFile(base .. path), { debugName = path, environment = env or setmetatable({}, { __index = _G }) })()
end

local M = load("assets/manifest.luau")
local health = load("devtools/health.luau")
local decode = function(text)
	return serde.decode("json", text)
end

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end
local function list(values)
	local parts = {}
	for _, value in values do
		table.insert(parts, tostring(value))
	end
	return "{" .. table.concat(parts, ",") .. "}"
end

-- Keys -------------------------------------------------------------------------------------------------------------
check("key ui/shop", M.isAssetKey("ui/shop"))
check("key fx/coin-burst", M.isAssetKey("fx/coin-burst"))
check("key props/crate_2", M.isAssetKey("props/crate_2"))
check("key 64 chars", M.isAssetKey(string.rep("a", 64)))
check("key 65 chars", not M.isAssetKey(string.rep("a", 65)))
check("key uppercase", not M.isAssetKey("UI/Shop"))
check("key empty", not M.isAssetKey(""))
check("key space", not M.isAssetKey("ui shop"))
check("key dot", not M.isAssetKey("ui.shop"))
check("key number", not M.isAssetKey(5))
check("tag", M.assetTag("ui/shop") == "__typetorch_asset:ui/shop")
check("keyOfTag", M.keyOfTag("__typetorch_asset:ui/shop") == "ui/shop")
check("keyOfTag other tag", M.keyOfTag("Element:HUD.Button") == nil)
check("keyOfTag bad key", M.keyOfTag("__typetorch_asset:UI") == nil)

-- Numbers and paths --------------------------------------------------------------------------------------------------
check("whole 5", M.wholeNumber(5) == 5)
check("whole string", M.wholeNumber("123456789012345") == 123456789012345)
check("whole 0", M.wholeNumber(0) == nil)
check("whole -1", M.wholeNumber(-1) == nil)
check("whole 1.5", M.wholeNumber(1.5) == nil)
check("whole 12a", M.wholeNumber("12a") == nil)
check("whole 2^53", M.wholeNumber(2 ^ 53) == nil)
check("whole nan", M.wholeNumber(0 / 0) == nil)
check("whole bool", M.wholeNumber(true) == nil)
check("path 3", #M.pathSegments("ReplicatedStorage/Assets/UI") == 3)
check("path empty", M.pathSegments("") == nil)
check("path //", M.pathSegments("ReplicatedStorage//UI") == nil)
check("path leading /", M.pathSegments("/ReplicatedStorage") == nil)
check("path trailing /", M.pathSegments("ReplicatedStorage/") == nil)
check("path too deep", M.pathSegments(string.rep("A/", 20) .. "A") == nil)
check("path 20 deep", M.pathSegments(string.rep("A/", 19) .. "A") ~= nil)
check("path not string", M.pathSegments(5) == nil)
check("realm ServerStorage", M.realmOfPath("ServerStorage/Assets") == "server")
check("realm ServerScriptService", M.realmOfPath("ServerScriptService") == "server")
check("realm ReplicatedStorage", M.realmOfPath("ReplicatedStorage/Assets/UI") == "replicated")
check("realm Workspace", M.realmOfPath("Workspace/Props") == "replicated")

-- parseManifest ----------------------------------------------------------------------------------------------------
local function parse(raw)
	return M.parseManifest(raw, decode)
end
local none = parse(nil)
check("no attribute: no manifest", none.manifest == nil)
check("no attribute: no errors", #none.errors == 0)
check("number attribute", parse(42).manifest == nil and #parse(42).errors == 1)
check("not json", parse("{nope").manifest == nil and parse("{nope").errors[1] == "Assets is not JSON")
check("json array root", parse("[1,2]").manifest == nil)
check("version 2", parse('{"v":2,"assets":{}}').manifest == nil and #parse('{"v":2,"assets":{}}').errors == 1)
check("no assets map", #parse('{"v":1}').manifest.entries == 0)
check("empty assets", #parse('{"v":1,"assets":{}}').manifest.entries == 0)
check("assets is a string", parse('{"v":1,"assets":"x"}').manifest == nil)

local full = parse([[{"v":1,"placeVersion":42,"assets":{
	"ui/shop":{"id":111,"ver":"900000000001","n":3,"hash":"ABCDEF012345","realm":"replicated","path":"ReplicatedStorage/Assets/UI","className":"ScreenGui"},
	"fx/coin-burst":{"id":"222","ver":900000000002,"hash":"0123456789ab","path":"ServerStorage/FX"}
}}]])
check("full: manifest", full.manifest ~= nil)
check("full: no errors", #full.errors == 0, list(full.errors))
check("full: 2 entries", #full.manifest.entries == 2)
check("full: placeVersion", full.manifest.placeVersion == 42)
local first, second = full.manifest.entries[1], full.manifest.entries[2]
check("full: sorted by key", first.key == "fx/coin-burst" and second.key == "ui/shop", first.key)
check("full: string id", first.id == 222)
check("full: realm from path", first.realm == "server")
check("full: no n", first.n == nil)
check("full: string ver", second.ver == 900000000001)
check("full: hash lowercased", second.hash == "abcdef012345")
check("full: n", second.n == 3)
check("full: className", second.className == "ScreenGui")
check("full: path", second.path == "ReplicatedStorage/Assets/UI")

local bad = parse([[{"v":1,"placeVersion":"x","assets":{
	"UI/Shop":{"id":1,"ver":1,"hash":"000000000000","path":"ReplicatedStorage"},
	"a/no-id":{"ver":1,"hash":"000000000000","path":"ReplicatedStorage"},
	"a/bad-ver":{"id":2,"ver":0,"hash":"000000000000","path":"ReplicatedStorage"},
	"a/short-hash":{"id":3,"ver":1,"hash":"00000000000","path":"ReplicatedStorage"},
	"a/hex-hash":{"id":4,"ver":1,"hash":"00000000000g","path":"ReplicatedStorage"},
	"a/bad-path":{"id":5,"ver":1,"hash":"000000000000","path":"ReplicatedStorage//UI"},
	"a/bad-realm":{"id":6,"ver":1,"hash":"000000000000","path":"ReplicatedStorage","realm":"client"},
	"a/bad-class":{"id":7,"ver":1,"hash":"000000000000","path":"ReplicatedStorage","className":""},
	"a/not-object":5,
	"b/good":{"id":8,"ver":1,"hash":"000000000000","path":"ReplicatedStorage"},
	"c/same-id":{"id":8,"ver":2,"hash":"000000000000","path":"ReplicatedStorage"}
}}]])
check("bad: manifest kept", bad.manifest ~= nil)
check("bad: only the good entry", #bad.manifest.entries == 1 and bad.manifest.entries[1].key == "b/good", #bad.manifest.entries)
check("bad: one error per bad entry", #bad.errors == 10, list(bad.errors))
check("bad: placeVersion ignored", bad.manifest.placeVersion == nil)
local joined = table.concat(bad.errors, "|")
check("bad: key error", string.find(joined, "bad key UI/Shop", 1, true) ~= nil, joined)
check("bad: duplicate id error", string.find(joined, "c/same-id: id 8 is also b/good", 1, true) ~= nil, joined)

local manyBad = {}
for index = 1, 30 do
	manyBad[`BAD{index}`] = {}
end
check("errors capped at 20", #parse(serde.encode("json", { v = 1, assets = manyBad })).errors == 20)
local many = {}
for index = 1, 1001 do
	many[`k/{index}`] = { id = index, ver = index, hash = "000000000000", path = "ReplicatedStorage" }
end
local capped = parse(serde.encode("json", { v = 1, assets = many }))
check("assets capped at 1000", #capped.manifest.entries == 1000, #capped.manifest.entries)
check("cap noted", #capped.errors == 1, list(capped.errors))
check("too long", parse(string.rep(" ", 600 * 1024)).errors[1] == "Assets is too long")

-- decideAsset (indexes are 0-based, as in the TypeScript) -----------------------------------------------------------
local entry = { key = "ui/shop", id = 1, ver = 100, hash = "aabbccddeeff", realm = "replicated", path = "ReplicatedStorage/Assets/UI" }
local d = M.decideAsset(entry, { { version = 99 }, { version = 100 } }, {}, false)
check("keep: the matching copy", d.action == "keep" and d.use == 1, d.action)
check("keep: the other goes", list(d.staleTagged) == "{0}", list(d.staleTagged))
check("keep: baked stays", #d.staleBaked == 0)
d = M.decideAsset(entry, { { version = 100 }, { version = 100 } }, { { hash = "aabbccddeeff" } }, true)
check("keep: newest of two", d.action == "keep" and d.use == 1 and list(d.staleTagged) == "{0}")
check("keep: never touches baked", #d.staleBaked == 0)
d = M.decideAsset(entry, {}, { { hash = "000000000000" }, { hash = "AABBCCDDEEFF" } }, false)
check("adopt: by hash (any case)", d.action == "adopt" and d.use == 1, `{d.action} {d.use}`)
check("adopt: nothing to destroy", #d.staleTagged == 0 and #d.staleBaked == 0)
d = M.decideAsset(entry, { { version = 99 } }, { { hash = "aabbccddeeff" } }, false)
check("adopt: replaces a wrong tagged copy", d.action == "adopt" and list(d.staleTagged) == "{0}")
d = M.decideAsset(entry, {}, { {} }, true)
check("adopt: by place version (one baked copy)", d.action == "adopt" and d.use == 0)
d = M.decideAsset(entry, {}, { {} }, false)
check("load: baked without hash", d.action == "load")
check("load: baked superseded", list(d.staleBaked) == "{0}")
check("load: baked is the fallback", d.fallbackBaked == 0)
d = M.decideAsset(entry, {}, { {}, {} }, true)
check("load: two baked copies are ambiguous", d.action == "load" and list(d.staleBaked) == "{0,1}" and d.fallbackBaked == 0)
d = M.decideAsset(entry, { { version = 99 } }, {}, false)
check("load: replaces the old version", d.action == "load" and list(d.staleTagged) == "{0}" and d.fallbackBaked == nil)
d = M.decideAsset(entry, { {} }, { { hash = "000000000000" } }, false)
check("load: a fallback copy (no version) is replaced", d.action == "load" and list(d.staleTagged) == "{0}")
check("load: no fallback while one is tagged", d.fallbackBaked == nil)
d = M.decideAsset(entry, {}, {}, false)
check("load: nothing there", d.action == "load" and #d.staleTagged == 0 and #d.staleBaked == 0 and d.fallbackBaked == nil)

-- Status -------------------------------------------------------------------------------------------------------------
check("summary: no manifest", M.summarizeAssets({ manifest = "none", errors = {}, running = false, entries = {}, unmanaged = {} }) == nil)
local facts = M.summarizeAssets({
	manifest = "ok",
	errors = {},
	running = false,
	unmanaged = {},
	entries = {
		{ key = "a", id = 1, wanted = 1, live = true, source = "kept" },
		{ key = "b", id = 2, wanted = 2, live = true, source = "failed", error = "timed out" },
		{ key = "c", id = 3, wanted = 3, live = false, source = "failed" },
	},
})
check("summary: failed", facts.failed == 2)
check("summary: missing", facts.missing == 1)
check("summary: first", facts.first == "b: timed out", facts.first)
check("summary: no manifest error", facts.manifestError == nil)
local invalid = M.summarizeAssets({ manifest = "invalid", errors = { "Assets is not JSON" }, running = false, entries = {}, unmanaged = {} })
check("summary: invalid", invalid.failed == 0 and invalid.manifestError == "Assets is not JSON")

local issues = health.assetIssues(facts)
check("issue: missing is an error", issues[1].level == "error" and issues[1].title == "Hot asset missing")
check("issue: detail", issues[1].detail == "b: timed out (+1 more)", issues[1].detail)
issues = health.assetIssues({ failed = 1, missing = 0, first = "b: timed out" })
check("issue: kept old is a warning", #issues == 1 and issues[1].level == "warn" and issues[1].detail == "b: timed out")
check("issue: manifest", health.assetIssues(invalid)[1].title == "Asset manifest")
check("issue: none", #health.assetIssues(nil) == 0)
local status = { kernelApi = 1, kernelVersion = health.LATEST_KERNEL, generation = {}, history = {}, memoryMb = 10 }
local all = health.checkHealth(status, { assets = { failed = 1, missing = 0, first = "ui/shop: timed out" } })
check("checkHealth lists it", #all == 1 and all[1].title == "Hot asset failed", #all)

-- Live copies on a DataModel (dom.luau) ------------------------------------------------------------------------------
local Instance = roblox.Instance
local game = Instance.new("DataModel")
local tagged = {}
local CollectionService = {
	GetTagged = function(_, tag)
		local found = {}
		for _, instance in tagged[tag] or {} do
			table.insert(found, instance)
		end
		return found
	end,
}
local script = {}
local TS = {
	getModule = function()
		return "services"
	end,
	import = function(_, from, name)
		if from == "services" then
			return { CollectionService = CollectionService }
		end
		return M
	end,
}
local dom = load("assets/dom.luau", setmetatable({ game = game, script = script, _G = { [script] = TS }, Instance = Instance }, { __index = _G }))

local replicated = game:GetService("ReplicatedStorage")
local made = dom.resolveParent("ReplicatedStorage/Assets/UI", true)
check("resolve: creates folders", made ~= nil and made:GetFullName() == "ReplicatedStorage.Assets.UI", made and made:GetFullName())
check("resolve: folders are Folders", replicated:FindFirstChild("Assets").ClassName == "Folder")
check("resolve: finds it again", dom.resolveParent("ReplicatedStorage/Assets/UI", false) == made)
check("resolve: missing without create", dom.resolveParent("ReplicatedStorage/Other", false) == nil)
check("resolve: not a service", dom.resolveParent("NotAService/X", true) == nil)
check("resolve: bad path", dom.resolveParent("ReplicatedStorage//X", true) == nil)

local shop = Instance.new("ScreenGui")
shop.Name = "Shop"
shop:SetAttribute(M.ATTR_KEY, "ui/shop")
shop:SetAttribute(M.ATTR_PATH, "ReplicatedStorage/Assets/UI")
shop.Parent = made
local clone = shop:Clone()
clone.Parent = game:GetService("StarterGui")
local moved = shop:Clone()
moved:SetAttribute(M.ATTR_PATH, nil)
moved.Parent = made
tagged[M.assetTag("ui/shop")] = { clone, shop, moved }
check("live: the placed copy", dom.isLiveCopy(shop))
check("live: a clone elsewhere is not", not dom.isLiveCopy(clone))
check("live: no path attribute is not", not dom.isLiveCopy(moved))
local live = dom.liveCopies("ui/shop")
check("liveCopies: only the placed copy", #live == 1 and live[1] == shop, #live)
shop.Parent = nil
check("live: unparented is not", not dom.isLiveCopy(shop))
check("attributes", dom.numberAttribute(nil, "x") == nil and dom.stringAttribute(clone, M.ATTR_KEY) == "ui/shop" and dom.numberAttribute(clone, M.ATTR_KEY) == nil)

print(`hot assets: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
