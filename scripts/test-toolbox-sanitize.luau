-- Offline test of the compiled Creator Store sanitizer (out/devtools/toolbox-sanitize.luau) under Lune: a model with
-- every kind of script, remotes, bindables, side-effect instances, a tool, a playing sound and parts goes through the
-- strict pass and the "Keep scripts" pass (plans/14). Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-toolbox-sanitize.luau ../framework/out/devtools/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local Instance = roblox.Instance
local Enum = roblox.Enum
local base = process.args[1] or "out/devtools/"

-- roblox-ts's ReadonlySet compiles to a table literal; nothing else from the runtime is needed.
local env = setmetatable({ Instance = Instance, Enum = Enum }, { __index = _G })
local sanitize = luau.load(fs.readFile(base .. "toolbox-sanitize.luau"), { debugName = "toolbox-sanitize", environment = env })()

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then passed += 1 else failed += 1; print("FAIL " .. label .. (detail ~= nil and (": " .. tostring(detail)) or "")) end
end

local function make(className, name, parent, props)
	local instance = Instance.new(className)
	instance.Name = name
	for key, value in props or {} do instance[key] = value end
	instance.Parent = parent
	return instance
end

-- A free model with everything a backdoor or a nuisance could use.
local function fixture()
	local model = Instance.new("Model")
	model.Name = "Door"
	local frame = make("Part", "Frame", model, { Anchored = false })
	make("MeshPart", "Knob", model, { Anchored = false })
	make("Script", "DoorServer", model)
	make("Script", "ClientRun", model, { RunContext = Enum.RunContext.Client })
	make("Script", "ServerRun", frame, { RunContext = Enum.RunContext.Server })
	make("LocalScript", "Local", model)
	make("ModuleScript", "Config", model)
	local remote = make("RemoteEvent", "Remote", model)
	make("Script", "HiddenInRemote", remote) -- a script inside a removed container
	make("RemoteFunction", "Fn", model)
	make("UnreliableRemoteEvent", "Fast", model)
	make("BindableEvent", "Signal", model)
	make("Explosion", "Boom", model)
	make("SpawnLocation", "Spawn", model)
	make("ForceField", "FF", model)
	make("ProximityPrompt", "Prompt", frame)
	make("ClickDetector", "Click", frame)
	local tool = make("Tool", "Sword", model)
	make("Part", "Handle", tool, { Anchored = false })
	make("LocalScript", "SwordClient", tool)
	make("Sound", "Music", model, { Playing = true, PlayOnRemove = true })
	return model
end

-- Scan: what loaded.
local scanned = sanitize.scanAsset(fixture(), 12)
check("scan scripts", scanned.scripts == 7, scanned.scripts)
check("scan keepable (2 server scripts + module + script in remote)", scanned.keepableCount == 4, scanned.keepableCount)
check("scan remotes", scanned.remotes == 3, scanned.remotes)
check("scan bindables", scanned.bindables == 1, scanned.bindables)
check("scan side effects", scanned.sideEffects == 3, scanned.sideEffects)
check("scan interactions", scanned.interactions == 2, scanned.interactions)
check("scan tools", scanned.tools == 1, scanned.tools)
check("scan parts (SpawnLocation and Handle are parts)", scanned.parts == 4, scanned.parts)
check("scan meshParts", scanned.meshParts == 1, scanned.meshParts)
check("keepable paths", table.find(scanned.keepable, "Frame.ServerRun (Script)") ~= nil, table.concat(scanned.keepable, ", "))

-- Strict (default): no script of any kind is left.
local strict = fixture()
local report = sanitize.sanitizeAsset(strict, { keepScripts = false, anchor = true })
check("strict leftovers", sanitize.leftovers(strict, false) == 0, sanitize.leftovers(strict, false))
local scripts = 0
for _, d in strict:GetDescendants() do if d:IsA("LuaSourceContainer") then scripts += 1 end end
check("strict: zero scripts", scripts == 0, scripts)
check("strict removed scripts (6 direct + 1 inside the remote)", report.removed.scripts == 7, report.removed.scripts)
check("strict removed remotes + bindables", report.removed.remotes == 4, report.removed.remotes)
check("strict removed other", report.removed.other == 5, report.removed.other)
check("tool became a model", strict:FindFirstChild("Sword") ~= nil and strict.Sword.ClassName == "Model" and strict.Sword:FindFirstChild("Handle") ~= nil)
check("tools converted", report.toolsConverted == 1, report.toolsConverted)
check("sound stopped", strict.Music.Playing == false and strict.Music.PlayOnRemove == false)
local unanchored = 0
for _, d in strict:GetDescendants() do if d:IsA("BasePart") and not d.Anchored then unanchored += 1 end end
check("everything anchored", unanchored == 0, unanchored)
check("no spawn left", strict:FindFirstChild("Spawn") == nil)

-- anchor = false leaves parts as they loaded.
local loose = fixture()
sanitize.sanitizeAsset(loose, { keepScripts = false, anchor = false })
check("anchor off", loose.Frame.Anchored == false)

-- Keep scripts: server scripts, modules, bindables and detectors stay; client code and remotes still go.
local kept = fixture()
local keptReport = sanitize.sanitizeAsset(kept, { keepScripts = true, anchor = true })
check("keep leftovers", sanitize.leftovers(kept, true) == 0, sanitize.leftovers(kept, true))
check("keep: server Script stays", kept:FindFirstChild("DoorServer") ~= nil)
check("keep: RunContext Server stays", kept.Frame:FindFirstChild("ServerRun") ~= nil)
check("keep: ModuleScript stays", kept:FindFirstChild("Config") ~= nil)
check("keep: client RunContext goes", kept:FindFirstChild("ClientRun") == nil)
check("keep: LocalScript goes", kept:FindFirstChild("Local") == nil)
check("keep: remotes go", kept:FindFirstChild("Remote") == nil and kept:FindFirstChild("Fn") == nil and kept:FindFirstChild("Fast") == nil)
check("keep: bindable stays", kept:FindFirstChild("Signal") ~= nil)
check("keep: prompt stays", kept.Frame:FindFirstChild("Prompt") ~= nil)
check("keep: explosion goes", kept:FindFirstChild("Boom") == nil)
check("keep: tool's LocalScript goes", kept.Sword:FindFirstChild("SwordClient") == nil)
check("keep: kept count", keptReport.kept.scripts == 3, keptReport.kept.scripts)
check("strict check fails on a kept model", sanitize.leftovers(kept, false) > 0)

print(`toolbox sanitizer: {passed} passed, {failed} failed`)
if failed > 0 then process.exit(1) end
