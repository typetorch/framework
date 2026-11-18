--!nocheck
-- plans/36: the extended recorder (out/analytics/ext-recorder.luau) and the replay list (out/analytics/replay.luau)
-- under Lune, in a mock world (instances, an R6 character, another player, tracked models, server-mirrored tracks, a
-- PlayerGui tree) with a fake os.clock: the Keyframe's full state, View, Rig / Pose, Spawn / Look / Move / Gone, the
-- animation signals, UiNode / UiProps / UiGone, AFK pauses, the game's AFK flag, dry runs, the tech counters, and the
-- ClientAnalytics wiring (the hello's `ext` starts it, "xrec" messages, it ends with the tt-rec-1 window).
-- Run after `bun run build`:
--   <rokit>/tool-storage/lune-org/lune/0.10.5/lune run scripts/test-analytics-ext.luau out/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local task = require("@lune/task")
local base = process.args[1] or "out/"
local Enum, CFrame, Vector2, Vector3, Color3 = roblox.Enum, roblox.CFrame, roblox.Vector2, roblox.Vector3, roblox.Color3

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end

local function Signal()
	local handlers = {}
	local signal = { count = 0 }
	function signal:Connect(fn)
		local connection = { Connected = true }
		handlers[connection] = fn
		signal.count += 1
		function connection:Disconnect()
			if handlers[connection] then
				signal.count -= 1
			end
			handlers[connection] = nil
			connection.Connected = false
		end
		return connection
	end
	function signal:Fire(...)
		for _, fn in table.clone(handlers) do
			fn(...)
		end
	end
	return signal
end

local Trove = {}
Trove.__index = Trove
local function cleanup(item)
	if type(item) == "function" then
		item()
	elseif type(item) == "thread" then
		pcall(task.cancel, item)
	elseif getmetatable(item) == Trove then
		item:clean()
	elseif type(item) == "table" and item.Disconnect then
		item:Disconnect()
	end
end
function Trove.new()
	return setmetatable({ items = {} }, Trove)
end
function Trove:add(item)
	table.insert(self.items, item)
	return item
end
function Trove:connect(signal, fn)
	return self:add(signal:Connect(fn))
end
function Trove:extend()
	return self:add(Trove.new())
end
function Trove:remove(item)
	local index = table.find(self.items, item)
	if index then
		table.remove(self.items, index)
		cleanup(item)
	end
end
function Trove:clean()
	local items = self.items
	self.items = {}
	for index = #items, 1, -1 do
		cleanup(items[index])
	end
end
Trove.destroy = Trove.clean

-- Instances ------------------------------------------------------------------------------------------------------------
local CLASSES = {
	Model = { "PVInstance" },
	Part = { "BasePart", "PVInstance" },
	Humanoid = {},
	Animator = {},
	AnimationController = {},
	Motor6D = { "JointInstance" },
	Folder = {},
	ObjectValue = { "ValueBase" },
	ScreenGui = { "LayerCollector", "GuiBase2d" },
	Frame = { "GuiObject", "GuiBase2d" },
	TextLabel = { "GuiObject", "GuiBase2d" },
	TextButton = { "GuiButton", "GuiObject", "GuiBase2d" },
	ImageLabel = { "GuiObject", "GuiBase2d" },
	UICorner = { "UIComponent" },
	UIStroke = { "UIComponent" },
	UIGradient = { "UIComponent" },
	UIScale = { "UIComponent" },
	CanvasGroup = { "GuiObject", "GuiBase2d" },
	Shirt = { "Clothing" },
	Pants = { "Clothing" },
	BodyColors = {},
	Decal = {},
	PlayerGui = {},
	Workspace = {},
	ReplicatedStorage = {},
}
local Instance = {}
local function isA(self, class)
	if class == "Instance" or class == self.ClassName then
		return true
	end
	return table.find(CLASSES[self.ClassName] or {}, class) ~= nil
end
local function descendants(self, out)
	for _, child in self._children do
		table.insert(out, child)
		descendants(child, out)
	end
	return out
end
local function ancestors(self)
	local list = {}
	local node = self.Parent
	while node do
		table.insert(list, node)
		node = node.Parent
	end
	return list
end
local function new(class, name, parent, props)
	local inst = { __instance = true, ClassName = class, Name = name, _children = {}, _attrs = {}, _changed = {} }
	for _, signal in { "ChildAdded", "ChildRemoved", "DescendantAdded", "DescendantRemoving", "AncestryChanged", "Destroying" } do
		inst[signal] = Signal()
	end
	for key, value in props or {} do
		inst[key] = value
	end
	inst.IsA = isA
	function inst:GetChildren()
		return table.clone(self._children)
	end
	function inst:GetDescendants()
		return descendants(self, {})
	end
	function inst:FindFirstChild(childName)
		for _, child in self._children do
			if child.Name == childName then
				return child
			end
		end
		return nil
	end
	function inst:WaitForChild(childName)
		return self:FindFirstChild(childName)
	end
	function inst:FindFirstChildOfClass(childClass)
		for _, child in self._children do
			if child.ClassName == childClass then
				return child
			end
		end
		return nil
	end
	function inst:FindFirstChildWhichIsA(childClass, recursive)
		local list = if recursive then descendants(self, {}) else self._children
		for _, child in list do
			if child:IsA(childClass) then
				return child
			end
		end
		return nil
	end
	function inst:IsDescendantOf(other)
		return table.find(ancestors(self), other) ~= nil
	end
	function inst:GetAttribute(key)
		return self._attrs[key]
	end
	function inst:SetAttribute(key, value)
		self._attrs[key] = value
	end
	function inst:GetPropertyChangedSignal(property)
		self._changed[property] = self._changed[property] or Signal()
		return self._changed[property]
	end
	function inst:Set(property, value)
		self[property] = value
		if self._changed[property] then
			self._changed[property]:Fire()
		end
	end
	function inst:GetPivot()
		return self.Pivot or CFrame.new()
	end
	function inst:GetExtentsSize()
		return self.Extents or Vector3.new(4, 5, 2)
	end
	function inst:Destroy()
		self.Destroying:Fire()
		Instance.setParent(self, nil)
	end
	if parent then
		Instance.setParent(inst, parent)
	end
	return inst
end
function Instance.setParent(inst, parent)
	local old = inst.Parent
	if old then
		local index = table.find(old._children, inst)
		if index then
			table.remove(old._children, index)
		end
		for _, ancestor in { old, table.unpack(ancestors(old)) } do
			ancestor.DescendantRemoving:Fire(inst)
		end
		old.ChildRemoved:Fire(inst)
	end
	inst.Parent = parent
	if parent then
		table.insert(parent._children, inst)
		parent.ChildAdded:Fire(inst)
		for _, ancestor in { parent, table.unpack(ancestors(parent)) } do
			ancestor.DescendantAdded:Fire(inst)
		end
	end
	inst.AncestryChanged:Fire(inst, parent)
end

local function Track(id, props)
	local track = { Animation = { AnimationId = id }, Speed = 1, WeightTarget = 1, Looped = true, TimePosition = 0, IsPlaying = true, Stopped = Signal() }
	for key, value in props or {} do
		track[key] = value
	end
	return track
end
local function newAnimator(parent)
	local animator = new("Animator", "Animator", parent)
	animator.AnimationPlayed = Signal()
	animator.tracks = {}
	function animator:GetPlayingAnimationTracks()
		local list = {}
		for _, track in self.tracks do
			if track.IsPlaying then
				table.insert(list, track)
			end
		end
		return list
	end
	function animator:Play(track)
		track.IsPlaying = true
		table.insert(self.tracks, track)
		self.AnimationPlayed:Fire(track)
	end
	function animator:Stop(track)
		track.IsPlaying = false
		local index = table.find(self.tracks, track)
		if index then
			table.remove(self.tracks, index)
		end
		track.Stopped:Fire()
	end
	return animator
end

-- The world -------------------------------------------------------------------------------------------------------------
local workspace = new("Workspace", "Workspace", nil)
local replicated = new("ReplicatedStorage", "ReplicatedStorage", nil)

local function character(name, at)
	local model = new("Model", name, workspace, { Pivot = CFrame.new(at) })
	local humanoid = new("Humanoid", "Humanoid", model, { RigType = Enum.HumanoidRigType.R6 })
	humanoid.Died = Signal()
	local animator = newAnimator(humanoid)
	local root = new("Part", "HumanoidRootPart", model, { CFrame = CFrame.new(at), Position = at, Size = Vector3.new(2, 2, 1) })
	local torso = new("Part", "Torso", model)
	local motors = {}
	for _, joint in { { root, "RootJoint" }, { torso, "Neck" }, { torso, "Left Shoulder" }, { torso, "Right Shoulder" }, { torso, "Left Hip" }, { torso, "Right Hip" } } do
		motors[joint[2]] = new("Motor6D", joint[2], joint[1], { Transform = CFrame.new() })
	end
	return model, humanoid, animator, root, motors
end

local me, _, myAnimator, myRoot, myMotors = character("Me", Vector3.new(0, 3, 0))
-- A weapon's joint: listed after the six R6 joints; the rig stays R6.
new("Motor6D", "KnifeGrip", myMotors["Right Shoulder"].Parent, { Transform = CFrame.new() })
local other = character("Other", Vector3.new(20, 3, 0))
local zombie = new("Model", "Zombie", workspace, { Pivot = CFrame.new(10, 3, 10), Extents = Vector3.new(4, 6, 2) })
new("Humanoid", "Humanoid", zombie)
local zombieAnimator = newAnimator(zombie:FindFirstChild("Humanoid"))
new("Shirt", "Shirt", zombie, { ShirtTemplate = "rbxassetid://555" })
new("BodyColors", "Body Colors", zombie, {
	HeadColor3 = Color3.new(1, 0, 0),
	TorsoColor3 = Color3.new(0, 1, 0),
	LeftArmColor3 = Color3.new(0, 0, 1),
	RightArmColor3 = Color3.new(1, 1, 1),
	LeftLegColor3 = Color3.new(0, 0, 0),
	RightLegColor3 = Color3.new(0.5, 0.5, 0.5),
})
local zombieWalk = Track("rbxassetid://1001")
zombieAnimator:Play(zombieWalk) -- already playing when it enters the radius
local farModel = new("Model", "Far", workspace, { Pivot = CFrame.new(5000, 3, 0) })
local boss = new("Model", "Boss", workspace, { Pivot = CFrame.new(-30, 3, 0) })
local mobs = new("Folder", "Mobs", workspace)
local mob = new("Model", "Mob1", mobs, { Pivot = CFrame.new(0, 3, 40) })
local mobController = new("AnimationController", "AnimationController", mob)
newAnimator(mobController)
-- The server's mirror: a boss and a container.
local mirror = new("Folder", "TypeTorchReplay", replicated)
new("ObjectValue", "boss", mirror, { Value = boss })
local mobsValue = new("ObjectValue", "mob", mirror, { Value = mobs })
mobsValue:SetAttribute("children", true)

local playerGui = new("PlayerGui", "PlayerGui", nil)
local hud = new("ScreenGui", "HUD", playerGui, {
	Enabled = true,
	DisplayOrder = 2,
	ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
	AbsolutePosition = Vector2.new(0, 0),
	AbsoluteSize = Vector2.new(1920, 1080),
})
local function gui(class, name, parent, props)
	local defaults = {
		Visible = true,
		ZIndex = 1,
		AbsolutePosition = Vector2.new(10, 20),
		AbsoluteSize = Vector2.new(200, 50),
		AbsoluteRotation = 0,
		BackgroundColor3 = Color3.new(1, 1, 1),
		BackgroundTransparency = 0,
		BorderSizePixel = 0,
		BorderColor3 = Color3.new(0, 0, 0),
		ClipsDescendants = false,
	}
	for key, value in props or {} do
		defaults[key] = value
	end
	return new(class, name, parent, defaults)
end
local panel = gui("Frame", "Panel", hud, { ZIndex = 2 })
new("UICorner", "UICorner", panel, { CornerRadius = roblox.UDim.new(0, 8) })
new("UIStroke", "UIStroke", panel, { Color = Color3.new(0, 0, 0), Transparency = 0, Thickness = 2, Enabled = true, ApplyStrokeMode = Enum.ApplyStrokeMode.Border })
local textProps = {
	Text = "Coins: 10",
	TextColor3 = Color3.new(1, 1, 0),
	TextTransparency = 0,
	TextSize = 24,
	TextScaled = false,
	TextBounds = Vector2.new(100, 24),
	FontFace = { Family = "rbxasset://fonts/families/GothamSSm.json", Weight = Enum.FontWeight.Bold },
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Center,
	TextWrapped = false,
	RichText = false,
	TextStrokeTransparency = 1,
	TextStrokeColor3 = Color3.new(0, 0, 0),
}
local coins = gui("TextLabel", "Coins", panel, textProps)
local icon = gui("ImageLabel", "Icon", panel, {
	Image = "rbxassetid://777",
	ImageColor3 = Color3.new(1, 1, 1),
	ImageTransparency = 0,
	ScaleType = Enum.ScaleType.Slice,
	ImageRectOffset = Vector2.new(0, 0),
	ImageRectSize = Vector2.new(0, 0),
	SliceCenter = roblox.Rect.new(Vector2.new(4, 4), Vector2.new(12, 12)),
	ZIndex = 1,
})
local back = gui("Frame", "Back", hud, { ZIndex = 1 })
new("UIGradient", "UIGradient", back, {
	Color = roblox.ColorSequence.new(Color3.new(1, 0, 0), Color3.new(0, 0, 1)),
	Transparency = roblox.NumberSequence.new(0),
	Offset = Vector2.new(0, 0),
	Rotation = 90,
	Enabled = true,
})
-- 0.7.3: a HUD scaled by UIScale (gnome: ~2x at 1080p), one hidden by UIScale 0, gnome's modal sheen, a CanvasGroup.
local scaled = gui("Frame", "Scaled", hud, { ZIndex = 3, AbsoluteSize = Vector2.new(64, 64) })
local scaledBy = new("UIScale", "UIScale", scaled, { Scale = 2 })
new("UICorner", "UICorner", scaled, { CornerRadius = roblox.UDim.new(0, 4) })
new("UIStroke", "UIStroke", scaled, { Color = Color3.new(0, 0, 0), Transparency = 0, Thickness = 1, Enabled = true, ApplyStrokeMode = Enum.ApplyStrokeMode.Border })
local dollarProps = table.clone(textProps)
dollarProps.Text, dollarProps.TextSize, dollarProps.TextBounds, dollarProps.AbsoluteSize = "$", 16, Vector2.new(9, 16), Vector2.new(32, 32)
gui("TextLabel", "Dollar", scaled, dollarProps)
local inner = gui("Frame", "Inner", scaled)
new("UIScale", "UIScale", inner, { Scale = 0.5 })
local halfProps = table.clone(textProps)
halfProps.Text, halfProps.TextSize = "Half", 20
gui("TextLabel", "Half", inner, halfProps)
local hiddenHud = gui("Frame", "HiddenHud", hud, { ZIndex = 4, AbsoluteSize = Vector2.new(0, 0) })
new("UIScale", "UIScale", hiddenHud, { Scale = 0 })
local ghostProps = table.clone(textProps)
ghostProps.Text, ghostProps.TextSize, ghostProps.AbsoluteSize = "Ghost", 18, Vector2.new(0, 0)
gui("TextLabel", "Ghost", hiddenHud, ghostProps)
local highlight = gui("Frame", "Highlight", hud, { ZIndex = 5, AbsoluteSize = Vector2.new(400, 300) })
new("UIGradient", "UIGradient", highlight, {
	Color = roblox.ColorSequence.new(Color3.new(1, 1, 1)),
	Transparency = roblox.NumberSequence.new({ roblox.NumberSequenceKeypoint.new(0, 0.9), roblox.NumberSequenceKeypoint.new(0.7, 1), roblox.NumberSequenceKeypoint.new(1, 1) }),
	Offset = Vector2.new(0, 0.5),
	Rotation = 90,
	Enabled = true,
})
local fade = gui("CanvasGroup", "Fade", hud, { ZIndex = 6, GroupTransparency = 0.5, GroupColor3 = Color3.new(1, 1, 1) })
local shop = new("ScreenGui", "Shop", playerGui, { Enabled = false, DisplayOrder = 5, ZIndexBehavior = Enum.ZIndexBehavior.Sibling, AbsolutePosition = Vector2.new(0, 0), AbsoluteSize = Vector2.new(1920, 1080) })
gui("Frame", "ShopPanel", shop)
local dev = new("ScreenGui", "TypeTorchDev", playerGui, { Enabled = true, DisplayOrder = 99, ZIndexBehavior = Enum.ZIndexBehavior.Sibling, AbsolutePosition = Vector2.new(0, 0), AbsoluteSize = Vector2.new(1920, 1080) })
gui("Frame", "DevPanel", dev)

local localPlayer = new("Player", "Me", nil, { Character = me, CharacterAdded = Signal(), UserId = 1 })
local otherPlayer = new("Player", "Other", nil, { Character = other, UserId = 2 })
local camera = { CFrame = CFrame.new(Vector3.new(0, 10, 10), Vector3.new(0, 3, 0)), ViewportSize = Vector2.new(1920, 1080), FieldOfView = 70 }

local fakeNow = 1000
local services = {
	GuiService = {
		GetGuiInset = function()
			return Vector2.new(0, 58), Vector2.new(0, 0)
		end,
		IsTenFootInterface = function()
			return false
		end,
	},
	Players = {
		LocalPlayer = localPlayer,
		GetPlayers = function()
			return { localPlayer, otherPlayer }
		end,
		GetPlayerFromCharacter = function()
			return nil
		end,
	},
	ReplicatedStorage = replicated,
	RunService = {
		Heartbeat = Signal(),
		RenderStepped = Signal(),
		IsServer = function()
			return false
		end,
	},
	UserInputService = {
		InputBegan = Signal(),
		InputEnded = Signal(),
		InputChanged = Signal(),
		TextBoxFocused = Signal(),
		TouchEnabled = false,
		KeyboardEnabled = true,
		MouseEnabled = true,
		GamepadEnabled = false,
		GetLastInputType = function()
			return Enum.UserInputType.Keyboard
		end,
		GetFocusedTextBox = function()
			return nil
		end,
	},
	Workspace = workspace,
	ProximityPromptService = { PromptShown = Signal(), PromptHidden = Signal(), PromptTriggered = Signal() },
	Stats = {
		GetTotalMemoryUsageMb = function()
			return 900
		end,
	},
	TextChatService = {
		FindFirstChildOfClass = function()
			return nil
		end,
	},
	VRService = { VREnabled = false },
	HttpService = {
		JSONEncode = function(_, value)
			return serde.encode("json", value)
		end,
	},
}
workspace.CurrentCamera = camera

local persist = {}
local swapOut = {}
local TypeTorch = { generation = 1, startInfo = { kind = "boot", reason = "boot" } }
function TypeTorch:persist(key, init)
	persist[key] = persist[key] or init()
	return persist[key]
end
function TypeTorch:onLog()
	return function() end
end
function TypeTorch:onSwapOut(fn)
	swapOut[fn] = true
	return function()
		swapOut[fn] = nil
	end
end

local internals = {
	typetorch = {
		TypeTorch = TypeTorch,
		generationScope = function()
			return nil
		end,
	},
	ui = { observeElement = function() end },
}
local outFolder = { Name = "out" }
local analyticsFolder = { Name = "analytics", Parent = outFolder }
local G, loaded, TS = {}, {}, {}
function TS.getModule(_, scope, name)
	return { external = scope .. "/" .. name }
end
local loadAnalytics
function TS.import(_, parent, ...)
	local path = table.concat({ ... }, "/")
	if type(parent) == "table" and parent.external then
		return services
	elseif parent == analyticsFolder then
		return loadAnalytics(path)
	elseif parent == outFolder then
		return assert(internals[path], "no mock for " .. path)
	end
	error("unexpected import " .. path)
end
local fakeOs = setmetatable({
	clock = function()
		return fakeNow
	end,
}, { __index = os })
local realTypeof = typeof
local fakeDebug = setmetatable({ profilebegin = function() end, profileend = function() end }, { __index = debug })
function loadAnalytics(name)
	if loaded[name] then
		return loaded[name]
	end
	local script = { Name = name, Parent = analyticsFolder }
	G[script] = TS
	local environment = setmetatable({
		script = script,
		_G = G,
		task = task,
		Enum = Enum,
		os = fakeOs,
		debug = fakeDebug,
		typeof = function(value)
			if type(value) == "table" and rawget(value, "__instance") then
				return "Instance"
			end
			return realTypeof(value)
		end,
		time = function()
			return 4.2
		end,
		warn = function() end,
	}, { __index = _G })
	loaded[name] = luau.load(fs.readFile(base .. "analytics/" .. name .. ".luau"), { debugName = name, environment = environment })()
	return loaded[name]
end

local X = loadAnalytics("ext-codec")
local R = loadAnalytics("replay")
local ExtRecorder = loadAnalytics("ext-recorder").ExtRecorder
local S = loadAnalytics("settings")

local function frames(seconds, fps)
	fps = fps or 60
	for _ = 1, math.floor(seconds * fps + 0.5) do
		fakeNow += 1 / fps
		services.RunService.Heartbeat:Fire(1 / fps)
	end
end
local function input()
	services.UserInputService.InputBegan:Fire({ UserInputType = Enum.UserInputType.Keyboard, KeyCode = Enum.KeyCode.W, Position = Vector3.new() }, false)
end

-- The recorder ----------------------------------------------------------------------------------------------------------
local chunks = {}
local dials = S.parseExtended({ hz = 5, afkSeconds = 30 }, {})
local untrackZombie = R.replay:track(zombie, "zombie")
R.replay:track(farModel, "far")
check("replay: tracked locally", #R.trackedEntries == 2)
check("replay: bad kind refused", not pcall(function()
	R.replay:track(zombie, "bad kind!")
end))
check("replay: active is off before recording", R.replay:active() == false)
local state = { started = false, ended = false, chunk = 0, bytes = 0 }
local trove = Trove.new()
local recorder = ExtRecorder.new(trove, state, dials, "desktop", function(chunk, age, n, data, last, why)
	table.insert(chunks, { chunk = chunk, age = age, n = n, data = data, last = last, why = why })
end)
recorder:start(playerGui)
check("replay: the server's mirror arrives (boss + the mobs container's animated child)", #R.trackedEntries == 4, #R.trackedEntries)
input()
frames(1)
check("replay: active once recording", R.replay:active() == true)
check("one DescendantAdded per ScreenGui", hud.DescendantAdded.count == 1 and shop.DescendantAdded.count == 1 and coins.ChildAdded.count == 0)

-- Changes: text, motion, joints, animations.
coins:Set("Text", "Coins: 11")
scaledBy.Scale = 1.5 -- a UIScale tween: text sizes follow on the next pass
fade.GroupTransparency = 0.25
zombie.Pivot = CFrame.new(12, 3, 10) * CFrame.Angles(0, math.pi / 2, 0)
myMotors["Left Shoulder"].Transform = CFrame.Angles(math.rad(40), 0, 0)
local mySwing = Track("rbxassetid://2002", { Looped = false })
myAnimator:Play(mySwing)
local zombieAttack = Track("rbxassetid://1002", { Looped = false })
zombieAnimator:Play(zombieAttack)
input()
frames(0.5)
zombieWalk.Speed = 1.5
input()
frames(0.5)
zombieAnimator:Stop(zombieAttack)
myAnimator:Stop(mySwing)
panel:Set("Visible", false)
untrackZombie()
input()
frames(1)
frames(9) -- past 10 s: a chunk
check("a chunk after ~10 s", #chunks >= 1, #chunks)

local decodeState = X.newExtDecodeState()
local all = {}
local function decodeNew(from)
	for index = from, #chunks do
		local decoded = X.decodeExtChunk(chunks[index].data, decodeState)
		for _, record in decoded.records do
			table.insert(all, record)
		end
	end
end
decodeNew(1)
check("chunk 0 starts with a Keyframe", X.decodeExtChunk(chunks[1].data).keyframe == true and all[1].tag == 2)
check("chunk counter", chunks[1].chunk == 0 and state.chunk == #chunks)
check("row n = records", chunks[1].n == #X.decodeExtChunk(chunks[1].data).records)
local function find(tag, predicate)
	local found = {}
	for _, record in all do
		if record.tag == tag and (predicate == nil or predicate(record)) then
			table.insert(found, record)
		end
	end
	return found
end
local view = find(3)[1]
check("View", view and view.w == 1920 and view.h == 1080 and view.inset == 58 and view.fov == 70)
check("View about once a second (fps)", #find(3) >= 8 and #find(3) <= 14, #find(3))
check("Anchor at the keyframe", #find(5) >= 1)
local rig = find(6)[1]
check("Rig: R6, the six joints in order, then extras", rig and rig.entity == 0 and rig.rig == 1 and #rig.names == 7 and rig.names[1] == "RootJoint" and rig.names[3] == "Left Shoulder" and rig.names[7] == "KnifeGrip")
local poses = find(7)
check("Pose: the keyframe's full pose", poses[1] and #poses[1].joints == 7)
local moved = nil
for _, pose in poses do
	if #pose.joints == 1 and pose.joints[1][1] == 2 then
		moved = pose.joints[1]
	end
end
check("Pose: only the moved joint later (Left Shoulder, 40 degrees about X)", moved ~= nil and math.abs(math.abs(moved[2]) - math.sin(math.rad(20))) < 0.003)
local spawns = find(8)
local kinds = {}
for _, spawn in spawns do
	kinds[spawn.kind] = spawn
end
check("Spawn: another player's character", kinds.player and kinds.player.flags == 3)
check("Spawn: the tracked zombie (size, humanoid)", kinds.zombie and kinds.zombie.flags == 1 and kinds.zombie.size[2] == 6)
check("Spawn: server-mirrored boss and container child", kinds.boss ~= nil and kinds.mob ~= nil)
check("no Spawn for a model outside the radius", kinds.far == nil)
local look = find(9)[1]
check("Look: the zombie's shirt and body colours", look and look.entity == kinds.zombie.entity and look.colors[1] == 255 and look.slots[1][1] == 1 and look.slots[1][2] == "rbxassetid://555")
check("no Look for players", #find(9, function(r)
	return r.entity == kinds.player.entity
end) == 0)
local zMoves = {}
for _, move in find(10) do
	for _, entry in move.moves do
		if entry[1] == kinds.zombie.entity then
			table.insert(zMoves, entry)
		end
	end
end
check("Move: the zombie", #zMoves >= 1 and math.abs(zMoves[1][2] - 12) < 0.2 and math.abs(zMoves[1][4] - 10) < 0.2, #zMoves)
check("Gone: the zombie once untracked", #find(11, function(r)
	return r.entity == kinds.zombie.entity
end) == 1)
local plays = find(12)
local animIds = {}
for _, play in plays do
	animIds[play.animation] = play
end
check("AnimPlay: a track already playing when it spawned", animIds["rbxassetid://1001"] ~= nil and animIds["rbxassetid://1001"].entity == kinds.zombie.entity)
check("AnimPlay: from AnimationPlayed (zombie)", animIds["rbxassetid://1002"] ~= nil and animIds["rbxassetid://1002"].looped == false)
check("AnimPlay: my own Animator is entity 0", animIds["rbxassetid://2002"] ~= nil and animIds["rbxassetid://2002"].entity == 0)
check("AnimAdjust: speed", #find(14, function(r)
	return r.speed == 1.5 and r.entity == kinds.zombie.entity
end) == 1)
check("AnimStop: zombie and me", #find(13) >= 2)
local nodes = find(20)
local byId = {}
for _, node in nodes do
	byId[node.id] = node
end
local textNode = nil
for _, node in nodes do
	if node.text == "Coins: 10" then
		textNode = node
	end
end
check("UiNode: the HUD ScreenGui", #find(20, function(r)
	return r.class == 0 and r.parent == 65535 and r.order == 2
end) == 1)
check("UiNode: no disabled ScreenGui, no TypeTorch dev UI", #find(20, function(r)
	return r.class == 0
end) == 1)
check("UiNode: text node", textNode and textNode.class == 2 and textNode.textSize == 24 and textNode.family == "rbxasset://fonts/families/GothamSSm.json" and textNode.weight == 700 and textNode.xAlign == 0)
local panelNode = textNode and byId[textNode.parent]
check("UiNode: panel corner and stroke", panelNode and panelNode.corner == 8 and panelNode.border and panelNode.border[5] == 2)
check("UiNode: image with a 9-slice", #find(20, function(r)
	return r.image == "rbxassetid://777" and r.scaleType == 1 and r.slice and r.slice[3] == 12
end) == 1)
check("UiNode: gradient", #find(20, function(r)
	return r.gradient ~= nil and #r.gradient == 2 and r.gradientRotation == 90 and r.gradientAlpha == nil
end) == 1)
local backNode = find(20, function(r)
	return r.gradient ~= nil and r.gradientAlpha == nil
end)[1]
check("UiNode: draw order honours ZIndex (Back z1 under Panel z2)", backNode and panelNode and backNode.order < panelNode.order)
check("UiProps: the text change", #find(21, function(r)
	return r.text == "Coins: 11"
end) == 1)
-- 0.7.3: UIScale, the gradient's transparency / offset, CanvasGroup.
local function nodeNamed(text)
	return find(20, function(r)
		return r.text == text
	end)[1]
end
local function near(a, b, tolerance)
	return type(a) == "number" and math.abs(a - b) <= tolerance
end
local dollar = nodeNamed("$")
check("UIScale: TextSize 16 under a 2x UIScale is drawn at 32", dollar and dollar.textSize == 32 and dollar.textScale == 2, dollar and dollar.textSize)
check("UIScale: nested scales multiply (2 x 0.5 = 1: no textScale)", nodeNamed("Half") and nodeNamed("Half").textSize == 20 and nodeNamed("Half").textScale == nil)
check("UIScale: unscaled text sends no textScale", textNode and textNode.textScale == nil and textNode.more == nil)
check("UIScale 0: hidden HUD text has size 0", nodeNamed("Ghost") and nodeNamed("Ghost").textSize == 0 and nodeNamed("Ghost").textScale == 0)
local scaledNode = dollar and byId[dollar.parent]
check("UIScale: corner offset and stroke thickness scale", scaledNode and scaledNode.corner == 8 and scaledNode.border and scaledNode.border[5] == 2, scaledNode and scaledNode.corner)
check("UIScale tween: UiProps with the new size and scale", #find(21, function(r)
	return dollar ~= nil and r.id == dollar.id and r.textSize == 24 and r.textScale == 1.5
end) == 1)
local sheen = find(20, function(r)
	return r.gradientAlpha ~= nil
end)[1]
check(
	"UIGradient transparency + offset (gnome's Highlight)",
	sheen and #sheen.gradientAlpha == 3 and near(sheen.gradientAlpha[1][2], 0.9, 0.003) and near(sheen.gradientAlpha[2][1], 0.7, 0.003)
		and sheen.gradientAlpha[3][2] == 1 and sheen.gradientOffset[1] == 0 and sheen.gradientOffset[2] == 0.5 and #sheen.gradient == 2 and sheen.gradientRotation == 90
)
local fadeNode = find(20, function(r)
	return r.class == 9
end)[1]
check("CanvasGroup: GroupTransparency and GroupColor3", fadeNode and fadeNode.group and fadeNode.group[1] == 128 and fadeNode.group[2] == 255 and fadeNode.textScale == nil)
check("CanvasGroup: a GroupTransparency change is seen on the next pass", #find(21, function(r)
	return fadeNode ~= nil and r.id == fadeNode.id and r.group ~= nil and r.group[1] == 64
end) == 1)
local gone = {}
for _, record in find(22) do
	gone[record.id] = true
end
check("UiGone: a hidden frame and its sent children", panelNode and textNode and gone[panelNode.id] and gone[textNode.id])

-- AFK: no input and no motion for afkSeconds -> one Afk record and nothing else; input -> back with a Keyframe.
local before = #chunks
frames(31)
recorder:rotate(false, "")
decodeNew(before + 1)
local afkRecords = find(4)
check("AFK after 30 s", #afkRecords == 1 and afkRecords[1].afk == true, #afkRecords)
check("replay: not active while AFK", R.replay:active() == false)
local beforeQuiet = #chunks
frames(20)
recorder:rotate(false, "")
check("nothing written while AFK", #chunks == beforeQuiet, #chunks - beforeQuiet)
input()
frames(0.5)
recorder:rotate(false, "")
local fromBack = #all + 1
decodeNew(beforeQuiet + 1)
check("back: Afk 0 then a Keyframe", all[fromBack] and all[fromBack].tag == 4 and all[fromBack].afk == false and all[fromBack + 1] and all[fromBack + 1].tag == 2)
check("back: the keyframe re-sends the UI", #find(20) > #nodes)
-- The game's flag (replay.setAfk on the client for its own player).
R.replay:setAfk(localPlayer, true)
input()
frames(0.5)
check("setAfk pauses", R.replay:active() == false)
R.replay:setAfk(localPlayer, false)
input()
frames(0.5)
check("setAfk false resumes", R.replay:active() == true)
-- The server's attribute.
localPlayer:SetAttribute("TTReplayAfk", true)
frames(0.5)
check("the server's AFK attribute pauses", R.replay:active() == false)
localPlayer:SetAttribute("TTReplayAfk", nil)
input()
frames(0.5)

-- Every Keyframe starts its chunk, and the header says so.
local keyframesFirst, keyframeChunks = true, 0
for _, chunk in chunks do
	local decoded = X.decodeExtChunk(chunk.data)
	for index, record in decoded.records do
		if record.tag == 2 and index ~= 1 then
			keyframesFirst = false
		end
	end
	if (decoded.records[1] ~= nil and decoded.records[1].tag == 2) ~= decoded.keyframe then
		keyframesFirst = false
	end
	if decoded.keyframe then
		keyframeChunks += 1
	end
end
check("every Keyframe starts a chunk flagged as one", keyframesFirst and keyframeChunks >= 2, keyframeChunks)

-- Counters, the swap and the end.
local stats = recorder:takeStats()
check("stats: bytes per second", stats.xb > 0, stats.xb)
check("stats: ms numbers", stats.xms >= 0 and stats.xmax >= 0)
check("stats: visible UI nodes (HUD, Back, Scaled + 3, HiddenHud + Ghost, Highlight, Fade)", stats.xui == 10, stats.xui)
recorder:swapOut()
check("swap sends the chunk", chunks[#chunks].why == "swap")
recorder:finish("window")
check("finish: the last chunk", chunks[#chunks].last == true and chunks[#chunks].why == "window" and state.ended == true)
check("replay: inactive after the end", R.replay:active() == false)
recorder:takeStats()
check("stats: none once ended", recorder:takeStats() == nil)
check("finish disconnects everything", hud.DescendantAdded.count == 0 and services.RunService.Heartbeat.count == 0, services.RunService.Heartbeat.count)
local total = 0
for _, chunk in chunks do
	total += buffer.len(chunk.data)
	check("chunk under 32 KB", buffer.len(chunk.data) <= 32768)
end
print(`tt-ext-1 in this test: {#chunks} chunks, {total} bytes`)

-- Dry run: everything is built and counted, nothing is sent.
local dryChunks = 0
local dryState = { started = false, ended = false, chunk = 0, bytes = 0 }
local dry = ExtRecorder.new(Trove.new(), dryState, S.parseExtended({ dryRun = true }, {}), "phone", function()
	dryChunks += 1
end)
dry:start(playerGui)
input()
frames(12)
local dryStats = dry:takeStats()
check("dry run sends nothing", dryChunks == 0 and dryState.chunk == 0)
check("dry run counts bytes", dryStats.xb > 0 and dryState.bytes > 0, dryStats.xb)
dry:finish("window")

-- Streams off: only what is on.
local onlyView = {}
local viewRecorder = ExtRecorder.new(Trove.new(), { started = false, ended = false, chunk = 0, bytes = 0 }, S.parseExtended({ streams = { pose = false, ent = false, ui = false } }, {}), "desktop", function(_, _, _, data)
	table.insert(onlyView, data)
end)
viewRecorder:start(playerGui)
input()
frames(2)
viewRecorder:finish("window")
local tags = {}
for _, data in onlyView do
	for _, record in X.decodeExtChunk(data).records do
		tags[record.tag] = true
	end
end
check("streams: view only", tags[3] and not tags[6] and not tags[8] and not tags[20])

-- ClientAnalytics: the hello's `ext` starts it next to tt-rec-1; it ends with the window.
local sent = {}
local raw = {}
local dispatcher = { kernel = {
	send = function(_, channel, ...)
		table.insert(sent, { channel = channel, args = { ... } })
	end,
} }
function dispatcher:setRaw(channel, fn)
	raw[channel] = fn
end
function dispatcher:removeRaw(channel)
	raw[channel] = nil
end
localPlayer.WaitForChild = function(_, name)
	return if name == "PlayerGui" then playerGui else nil
end
localPlayer.FindFirstChildOfClass = function(_, class)
	return if class == "PlayerGui" then playerGui else nil
end
localPlayer.GetNetworkPing = function()
	return 0.05
end
local ClientAnalytics = loadAnalytics("client").ClientAnalytics
local clientTrove = Trove.new()
ClientAnalytics.new({}, dispatcher, clientTrove)
task.wait(0.05)
raw["__tt/an"]("hi", { pid = string.rep("ef", 16), newp = true, rec = true, tech = 60, exps = {}, rsec = 20, ext = { seconds = 20, hz = 5 } })
input()
frames(12)
local function count(op)
	local n = 0
	for _, message in sent do
		if message.args[1] == op then
			n += 1
		end
	end
	return n
end
check("client: xrec chunks next to rec", count("xrec") >= 1 and count("rec") >= 1, `{count("xrec")} / {count("rec")}`)
frames(10)
local lastExt
for _, message in sent do
	if message.args[1] == "xrec" then
		lastExt = message.args
	end
end
check("client: it ends with the tt-rec-1 window", lastExt and lastExt[6] == true and lastExt[7] == "window", lastExt and tostring(lastExt[7]))
check("client: persisted ext state", persist["__typetorch/analytics-client.v1"].ext.ended == true)
clientTrove:clean()

-- A hello without `ext`: no extended recording.
persist = {}
sent = {}
local plainTrove = Trove.new()
ClientAnalytics.new({}, dispatcher, plainTrove)
task.wait(0.05)
raw["__tt/an"]("hi", { pid = string.rep("aa", 16), newp = true, rec = true, tech = 60, exps = {} })
input()
frames(12)
check("client: no ext without the dials", count("xrec") == 0 and count("rec") >= 1)
plainTrove:clean()

print(`analytics ext: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
process.exit(0)
