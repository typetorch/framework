-- Offline test of the compiled explorer core (out/devtools/explorer/core.luau) under Lune: registry ids, paging and
-- order, typed property edits and validation, attributes, permissions, the paged find walk, ancestry and the codec.
-- ReflectionService is stubbed with its documented ReflectedProperty shape; everything else is Lune's DataModel.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-explorer-core.luau ../framework/out/devtools/explorer/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local task = require("@lune/task")
local Instance = roblox.Instance
local base = process.args[1] or "out/devtools/explorer/"

local game = Instance.new("DataModel")
local workspace = game:GetService("Workspace")
game:GetService("ReplicatedStorage")

local supers = { Part = "BasePart", BasePart = "PVInstance", PVInstance = "Instance", Model = "PVInstance", Folder = "Instance" }
local function prop(name, scriptType, category, order, write, extra)
	local entry = {
		Name = name,
		Type = { ScriptType = scriptType },
		Display = { Category = category, LayoutOrder = order },
		Permits = { Read = {}, Write = write and {} or nil },
	}
	for k, v in extra or {} do
		if k == "EnumType" then entry.Type.EnumType = v else entry.Display[k] = v end
	end
	return entry
end
local reflection = {}
function reflection:GetClass(className)
	return { Name = className, Superclass = supers[className] }
end
function reflection:GetPropertiesOfClass(className)
	local list = {
		prop("Name", "string", "Data", 1, true),
		prop("ClassName", "string", "Data", 2, false),
		prop("Parent", "Instance?", "Data", 3, true),
	}
	if className == "Part" then
		table.insert(list, prop("Size", "Vector3", "Transform", 1, true))
		table.insert(list, prop("Color", "Color3", "Appearance", 1, true))
		table.insert(list, prop("Material", "EnumItem", "Appearance", 2, true, { EnumType = "Material" }))
		table.insert(list, prop("Anchored", "boolean", "Behavior", 1, true))
		table.insert(list, prop("Transparency", "number", "Appearance", 3, true))
		table.insert(list, prop("Velocity", "Vector3", "Physics", 1, true))
		table.insert(list, prop("brickColor", "BrickColor", "Appearance", 9, true))
		table.insert(list, prop("Mass", "number", "Physics", 2, false))
		table.insert(list, prop("Elasticity", "number", "Physics", 3, true, { DeprecationMessage = "use CustomPhysicalProperties" }))
	end
	return list
end

local env
local script = {}
local function loadModule(name)
	local source = fs.readFile(base .. name .. ".luau")
	source = source:gsub('game:GetService%("ReflectionService"%)', "__reflection")
	return luau.load(source, { debugName = name, environment = env })()
end
local TS = { import = function(_, _, name) return loadModule(name) end }
env = setmetatable({
	game = game, script = script, _G = { [script] = TS }, Instance = Instance,
	Vector2 = roblox.Vector2, Vector3 = roblox.Vector3, UDim = roblox.UDim, UDim2 = roblox.UDim2,
	Color3 = roblox.Color3, Enum = roblox.Enum, task = task, __reflection = reflection,
}, { __index = _G })

local core = loadModule("core")
local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then passed += 1 else failed += 1; print("FAIL " .. label .. (detail and (": " .. tostring(detail)) or "")) end
end
local function throws(label, fn, needle)
	local ok, err = pcall(fn)
	check(label, not ok and (needle == nil or tostring(err):find(needle, 1, true) ~= nil), ok and "no error" or err)
end

-- Fixture: 1203 coins, duplicate names, a model with a weird name.
local coins = Instance.new("Folder"); coins.Name = "Coins"; coins.Parent = workspace
for i = 1, 1203 do local p = Instance.new("Part"); p.Name = "Coin" .. i; p.Parent = coins end
for _ = 1, 2 do local f = Instance.new("Folder"); f.Name = "Dup"; f.Parent = workspace end
local model = Instance.new("Model"); model.Name = 'Odd "name"'; model.Parent = workspace
local part = Instance.new("Part"); part.Name = "Target"; part.Parent = model
part:SetAttribute("Hp", 5); part:SetAttribute("Label", "hi"); part:SetAttribute("Tint", roblox.Color3.new(1, 0, 0))
part:AddTag("Coin")

local canEdit = true
local audit = {}
local ops = core.explorerHandlers(core.Registry.new(), function() return canEdit end, function(line) table.insert(audit, line) end)
local function find(rows, name) for _, r in rows do if r.name == name then return r end end end

-- children: root, paging, order, duplicates
local root = ops.children({ nodes = { { id = 0 } } })[1]
check("root total", root.total == #game:GetChildren(), root.total)
local ws = find(root.rows, "Workspace")
check("workspace row", ws and ws.className == "Workspace" and ws.parent == 0)
local wsPage = ops.children({ nodes = { { id = ws.id } } })[1]
local dups = {}
for _, r in wsPage.rows do if r.name == "Dup" then table.insert(dups, r.id) end end
check("duplicate names get distinct ids", #dups == 2 and dups[1] ~= dups[2])
local coinsRow = find(wsPage.rows, "Coins")
check("childCount", coinsRow.childCount == 1203, coinsRow.childCount)
local p1 = ops.children({ nodes = { { id = coinsRow.id } } })[1]
check("page size 500", #p1.rows == 500 and p1.total == 1203, #p1.rows)
local p3 = ops.children({ nodes = { { id = coinsRow.id, offset = 1000 } } })[1]
check("last page", #p3.rows == 203 and p3.offset == 1000, #p3.rows)
check("name order", p1.rows[1].name == "Coin1" and p1.rows[2].name == "Coin10", p1.rows[2].name)
local big = ops.children({ nodes = { { id = coinsRow.id, limit = 5000 } } })[1]
check("limit capped at 2000", #big.rows == 1203)
local batch = ops.children({ nodes = { { id = 0 }, { id = 999999 }, "junk" } })
check("batch + gone", #batch == 3 and batch[2].gone == true and batch[3].gone == true)
throws("too many nodes", function() local n = {} for i = 1, 65 do n[i] = { id = 0 } end ops.children({ nodes = n }) end, "bad nodes")
local modelRow = find(wsPage.rows, 'Odd "name"')
local folderIndex, modelIndex
for i, r in wsPage.rows do if r.name == "Coins" then folderIndex = i elseif r.id == modelRow.id then modelIndex = i end end
check("ExplorerOrder (Folder before Model)", folderIndex < modelIndex, `{folderIndex} {modelIndex}`)
local targetRow = ops.children({ nodes = { { id = modelRow.id } } })[1].rows[1]

-- props
local props = ops.props({ id = targetRow.id })
local byName = {}
for _, r in props.props do byName[r.name] = r end
check("props path", props.path == 'game.Workspace["Odd \\"name\\""].Target', props.path)
check("hidden Velocity", byName.Velocity == nil)
-- (Lune can't read brickColor/Elasticity, so check the reflection metadata directly)
local metas = {}
for _, m in core.propsOf("Part") do metas[m.name] = m end
check("lowercase alias deprecated", metas.brickColor and metas.brickColor.deprecated)
check("deprecation message", metas.Elasticity and metas.Elasticity.deprecated)
check("not deprecated", metas.Size and not metas.Size.deprecated)
check("read-only ClassName", byName.ClassName.readOnly)
check("Parent is Instance link", byName.Parent.kind == "Instance" and byName.Parent.ref == modelRow.id, byName.Parent.kind)
check("Size kind", byName.Size.kind == "Vector3" and not byName.Size.readOnly, byName.Size.kind)
check("Material enum", byName.Material.kind == "Enum" and byName.Material.enumType == "Material", byName.Material.enumType)
check("category order", props.props[1].category == "Data", props.props[1].category)
check("attrs typed", #props.attrs == 3 and props.attrs[1].name == "Hp" and props.attrs[1].kind == "number")
check("tags", props.tags[1] == "Coin")

-- edits
check("set Vector3", ops.set({ id = targetRow.id, name = "Size", text = "2, 3.5, 4" }) == "2, 3.5, 4" and part.Size == roblox.Vector3.new(2, 3.5, 4))
ops.set({ id = targetRow.id, name = "Color", text = "255, 128, 0" })
check("set Color3", math.abs(part.Color.G - 128 / 255) < 1e-6, part.Color)
ops.set({ id = targetRow.id, name = "Material", text = "Neon" })
check("set Enum", part.Material == roblox.Enum.Material.Neon, part.Material)
throws("bad enum", function() ops.set({ id = targetRow.id, name = "Material", text = "Nope" }) end, "not a Material")
ops.set({ id = targetRow.id, name = "Anchored", text = "true" })
check("set boolean", part.Anchored == true)
throws("bad number", function() ops.set({ id = targetRow.id, name = "Transparency", text = "abc" }) end, "not a number")
throws("wrong count", function() ops.set({ id = targetRow.id, name = "Size", text = "1, 2" }) end, "expected 3 numbers")
throws("read-only prop", function() ops.set({ id = targetRow.id, name = "Mass", text = "1" }) end, "read-only")
throws("instance not editable", function() ops.set({ id = targetRow.id, name = "Parent", text = "x" }) end, "can't be edited")
check("attr number", ops.attr({ id = targetRow.id, name = "Hp", text = "7" }) == "7" and part:GetAttribute("Hp") == 7)
check("attr string", ops.attr({ id = targetRow.id, name = "Label", text = "yo" }) == "yo")
ops.attr({ id = targetRow.id, name = "Tint", text = "0, 255, 0" })
check("attr color", part:GetAttribute("Tint") == roblox.Color3.fromRGB(0, 255, 0))
throws("missing attr", function() ops.attr({ id = targetRow.id, name = "Nope", text = "1" }) end, "no such attribute")
canEdit = false
throws("read-only channel", function() ops.set({ id = targetRow.id, name = "Size", text = "1, 1, 1" }) end, "read-only here")
check("props readOnly when !canEdit", ops.props({ id = targetRow.id }).props[1].readOnly)
canEdit = true
ops.rename({ id = targetRow.id, name = "Renamed" })
check("rename", part.Name == "Renamed")
throws("rename empty", function() ops.rename({ id = targetRow.id, name = "" }) end, "bad name")
throws("delete service", function() ops.destroy({ id = ws.id }) end, "service")
check("audit lines", #audit >= 7, #audit)

-- search + ancestry
-- find: paged breadth-first walk from game; "coin" matches Coins + 1203 parts -> capped at 500 hits
local all, pages, page = {}, 0, nil
repeat
	page = ops.find({ id = 0, query = "COIN", token = 1, next = page ~= nil })
	pages += 1
	for _, h in page.hits do table.insert(all, h) end
until page.done
check("find capped at 500", #all == 500 and page.capped, `{#all} {page.capped}`)
check("find pages of <=100 hits", pages >= 5, pages)
check("find breadth-first + relative path", all[1].row.name == "Coins" and table.concat(all[1].path, "/") == "Workspace/Coins", table.concat(all[1].path, "/"))
check("find hit path", table.concat(all[2].path, "/"):match("^Workspace/Coins/Coin%d+$") ~= nil, table.concat(all[2].path, "/"))
local fromCoins = ops.find({ id = coinsRow.id, query = "coin12", token = 2 })
local paths = {}
for _, h in fromCoins.hits do paths[table.concat(h.path, "/")] = true end
check("find relative to root", fromCoins.done and paths["Coin12"] and paths["Coin120"] and paths["Coin1203"] and not fromCoins.capped)
local byClass = ops.find({ id = 0, query = "model", token = 3 })
local classFound = false
for _, h in byClass.hits do if h.row.name == 'Odd "name"' then classFound = true end end
check("find by ClassName", classFound)
throws("stale continuation", function() ops.find({ id = 0, query = "model", token = 99, next = true }) end, "stale search")
-- a newer search replaces the walk; continuing the old token is stale
ops.find({ id = 0, query = "coin", token = 4 })
ops.find({ id = 0, query = "dup", token = 5 })
throws("cancelled by newer search", function() ops.find({ id = 0, query = "coin", token = 4, next = true }) end, "stale search")
local limited = false
for _ = 1, 30 do
	local ok, err = pcall(ops.find, { id = 0, query = "dup", token = 6 })
	if not ok and tostring(err):find("rate limited", 1, true) then limited = true break end
end
check("find rate limited", limited)
local chain = ops.ancestry({ id = targetRow.id })
check("ancestry", #chain == 3 and chain[1].name == "Workspace" and chain[3].name == "Renamed", #chain)
check("instance op", ops.instance({ id = targetRow.id }).instance == part)

-- destroy -> gone
ops.destroy({ id = targetRow.id })
check("destroyed", part.Parent == nil)
throws("gone after destroy", function() ops.props({ id = targetRow.id }) end, "gone")
throws("bad id", function() ops.props({ id = "x" }) end, "bad id")

-- codec
check("num", core.num(0.1 + 0.2) == "0.3" and core.num(5) == "5" and core.num(-2.5) == "-2.5", core.num(0.1 + 0.2))
-- TS tuples come back as arrays
local decoded = core.decode("UDim2", "0.5, 10, 1, -4")
check("decode UDim2", decoded[1] and decoded[2] == roblox.UDim2.new(0.5, 10, 1, -4))
check("encode UDim2", core.encode(roblox.UDim2.new(0.5, 10, 1, -4)) == "0.5, 10, 1, -4")
check("decode inf rejected", core.decode("number", "1e999")[1] == false)
check("decode bool strict", core.decode("boolean", "yes")[1] == false and core.decode("boolean", "false")[2] == false)
check("decode color clamps", core.decode("Color3", "300, -5, 128")[2] == roblox.Color3.fromRGB(255, 0, 128))
check("enumName", core.enumName(roblox.Enum.Material.Neon) == "Material", core.enumName(roblox.Enum.Material.Neon))
check("luaPath", core.luaPath({ "Workspace", "a b", "x_1" }) == 'game.Workspace["a b"].x_1', core.luaPath({ "Workspace", "a b", "x_1" }))
check("luaPath keyword", core.luaPath({ "Workspace", "end" }) == 'game.Workspace["end"]', core.luaPath({ "Workspace", "end" }))
local workspacePath = core.servicePath({ "Workspace", "Map", "Part" }, "Workspace")
check("servicePath workspace", workspacePath == "workspace.Map.Part", workspacePath)
local servicePathText = core.servicePath({ "Stuff", "a b" }, "ReplicatedStorage")
check("servicePath GetService", servicePathText == 'game:GetService("ReplicatedStorage")["a b"]', servicePathText)
check("servicePath game", core.servicePath({}) == "game")
check("classInfo fallback", core.classInfo("Part")[1] >= 0 and core.classInfo("NoSuchClass")[2] == 999)

print(`{passed} passed, {failed} failed`)
if failed > 0 then process.exit(1) end
