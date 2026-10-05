--!nocheck
-- The analytics client core (out/analytics/client.luau) under Lune, with mocked services, PlayerGui, camera and
-- character, and a fake os.clock: hello and device, events held until the server's "hi", experiments, screens, and
-- the first-session recorder (samples, keys never while typing, buttons, text boxes, the 60 s window, chunks that
-- decode). Takes a few seconds.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml and template/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-analytics-client.luau ../framework/out/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local task = require("@lune/task")
local base = process.args[1] or "out/"
local Enum, CFrame, Vector2, Vector3 = roblox.Enum, roblox.CFrame, roblox.Vector2, roblox.Vector3

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
	local signal = {}
	function signal:Connect(fn)
		local connection = { Connected = true }
		handlers[connection] = fn
		function connection:Disconnect()
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

-- A tiny instance: Name, Parent, class, signals, properties with changed signals.
local function Node(className, name, parent, props)
	local node = { Name = name, Parent = parent, ClassName = className, _changed = {} }
	for key, value in props or {} do
		node[key] = value
	end
	function node:IsA(class)
		return class == self.ClassName or (class == "GuiButton" and self.ClassName == "TextButton") or (class == "GuiObject" and (self.ClassName == "TextButton" or self.ClassName == "Frame"))
	end
	function node:GetPropertyChangedSignal(property)
		self._changed[property] = self._changed[property] or Signal()
		return self._changed[property]
	end
	function node:Set(property, value)
		self[property] = value
		if self._changed[property] then
			self._changed[property]:Fire()
		end
	end
	function node:FindFirstAncestorWhichIsA(class)
		local current = self.Parent
		while current do
			if current:IsA(class) then
				return current
			end
			current = current.Parent
		end
		return nil
	end
	node.AncestryChanged = Signal()
	return node
end

local fakeNow = 1000
local playerGui = Node("PlayerGui", "PlayerGui", nil)
playerGui.ChildAdded, playerGui.DescendantAdded, playerGui.DescendantRemoving = Signal(), Signal(), Signal()
local shopGui = Node("ScreenGui", "Shop", playerGui, { Enabled = true })
local frame = Node("Frame", "Main", shopGui)
local buyButton = Node("TextButton", "Buy", frame)
buyButton.Activated, buyButton.MouseEnter = Signal(), Signal()
local devGui = Node("ScreenGui", "TypeTorchDev", playerGui, { Enabled = true })
local devButton = Node("TextButton", "Toggle", devGui)
devButton.Activated, devButton.MouseEnter = Signal(), Signal()
function playerGui:GetChildren()
	return { shopGui, devGui }
end
function playerGui:GetDescendants()
	return { shopGui, frame, buyButton, devGui, devButton }
end

local root = { Position = Vector3.new(10, 3, -5), CFrame = CFrame.new(10, 3, -5) }
function root:IsA(class)
	return class == "BasePart"
end
local character = Node("Model", "PlayerName", nil)
function character:FindFirstChild(name)
	return if name == "HumanoidRootPart" then root else nil
end
function character:WaitForChild()
	return nil
end
local localPlayer = { Name = "PlayerName", DisplayName = "PlayerName", Character = character, CharacterAdded = Signal() }
function localPlayer:WaitForChild(name)
	return if name == "PlayerGui" then playerGui else nil
end
function localPlayer:FindFirstChildOfClass(class)
	return if class == "PlayerGui" then playerGui else nil
end
function localPlayer:GetNetworkPing()
	return 0.08
end

local focusedBox = nil
local camera = { CFrame = CFrame.new(Vector3.new(10, 10, 5), Vector3.new(10, 3, -5)), ViewportSize = Vector2.new(390, 844) }
local services = {
	GuiService = {
		IsTenFootInterface = function()
			return false
		end,
	},
	Players = {
		LocalPlayer = localPlayer,
		GetPlayers = function()
			return { localPlayer }
		end,
		GetPlayerFromCharacter = function(_, model)
			return if model == character then localPlayer else nil
		end,
	},
	ProximityPromptService = { PromptShown = Signal(), PromptHidden = Signal(), PromptTriggered = Signal() },
	RunService = { Heartbeat = Signal(), RenderStepped = Signal() },
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
	UserInputService = {
		TouchEnabled = true,
		KeyboardEnabled = false,
		MouseEnabled = false,
		GamepadEnabled = false,
		InputBegan = Signal(),
		InputEnded = Signal(),
		InputChanged = Signal(),
		TextBoxFocused = Signal(),
		GetLastInputType = function()
			return Enum.UserInputType.Touch
		end,
		GetFocusedTextBox = function()
			return focusedBox
		end,
	},
	VRService = { VREnabled = false },
	Workspace = { CurrentCamera = camera },
	HttpService = {
		JSONEncode = function(_, value)
			return serde.encode("json", value)
		end,
	},
}

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

local sent = {}
local raw = {}
local dispatcher = {
	kernel = {
		send = function(_, channel, ...)
			table.insert(sent, { channel = channel, args = { ... } })
		end,
	},
}
function dispatcher:setRaw(channel, fn)
	raw[channel] = fn
end
function dispatcher:removeRaw(channel)
	raw[channel] = nil
end

local internals = {
	typetorch = { TypeTorch = TypeTorch },
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
		time = function()
			return 4.2
		end,
		warn = function() end,
	}, { __index = _G })
	loaded[name] = luau.load(fs.readFile(base .. "analytics/" .. name .. ".luau"), { debugName = name, environment = environment })()
	return loaded[name]
end

local ClientAnalytics = loadAnalytics("client").ClientAnalytics
local C = loadAnalytics("codec")
local function messages(op)
	local found = {}
	for _, message in sent do
		if message.args[1] == op then
			table.insert(found, message.args)
		end
	end
	return found
end
local function heldEvents()
	local events = {}
	for _, message in messages("ev") do
		for _, event in message[2] do
			table.insert(events, event)
		end
	end
	return events
end
local function step(seconds)
	fakeNow += seconds
	services.RunService.Heartbeat:Fire(seconds)
end

-- Start --------------------------------------------------------------------------------------------------------------
local trove = Trove.new()
local client = ClientAnalytics.new({}, dispatcher, trove)
task.wait(0.05)
local hello = messages("hello")[1]
check("hello sent", hello ~= nil)
check("hello: phone", hello and hello[2].dev == "phone" and hello[2].input == "touch" and hello[2].w == 390 and hello[2].touch == true)
check("hello: load time on boot", hello and hello[2].load == 4.2)
client:track("custom", "early", { a = 1 })
check("held until hi", #messages("ev") == 0)

raw["__tt/an"]("hi", {
	pid = string.rep("ab", 16),
	newp = true,
	rec = true,
	tech = 60,
	exps = { onboarding = { variant = "long" } },
})
local events = heldEvents()
check("hi releases held events", #events >= 2, #events)
local early, firstScreen
for _, event in events do
	if event[3] == "early" then
		early = event
	elseif event[2] == "state" and event[3] == "screen" then
		firstScreen = event
	end
end
check("held event shape", early and early[2] == "custom" and early[4] == '{"a":1}' and early[1] >= 0)
check("screen at start: Shop (dev menu ignored)", firstScreen and serde.decode("json", firstScreen[4]).to == "Shop", firstScreen and firstScreen[4])
check("experiment forced by settings", client:experiment("onboarding", { "short", "long" }) == "long")
client:experiment("onboarding", { "short", "long" })
check("exp sent once", #messages("exp") == 1 and messages("exp")[1][2] == "onboarding")
check("bad experiment = control", client:experiment("bad name!", { "a", "b" }) == "a")

-- Recorder -----------------------------------------------------------------------------------------------------------
for _ = 1, 5 do
	root.Position += Vector3.new(1, 0, 0)
	root.CFrame = CFrame.new(root.Position)
	step(0.1)
end
step(0.1) -- unchanged: skipped
services.UserInputService.InputBegan:Fire({ UserInputType = Enum.UserInputType.Keyboard, KeyCode = Enum.KeyCode.W, Position = Vector3.new() }, false)
local firstInputAt = fakeNow
focusedBox = Node("TextBox", "NameBox", frame)
services.UserInputService.InputBegan:Fire({ UserInputType = Enum.UserInputType.Keyboard, KeyCode = Enum.KeyCode.H, Position = Vector3.new() }, false)
services.UserInputService.TextBoxFocused:Fire(focusedBox)
focusedBox = nil
services.UserInputService.InputBegan:Fire({ UserInputType = Enum.UserInputType.Touch, KeyCode = Enum.KeyCode.Unknown, Position = Vector3.new(195, 422, 0) }, true)
buyButton.Activated:Fire()
buyButton.MouseEnter:Fire()
buyButton.MouseEnter:Fire() -- within 1 s: once
devButton.Activated:Fire() -- the dev menu: never
services.ProximityPromptService.PromptTriggered:Fire(Node("ProximityPrompt", "Open", Node("Part", "Door", nil)))
client:track("custom", "bought_coins", nil)
shopGui:Set("Enabled", false)
task.wait(1.2) -- the close debounce
client:flush()
local closed = false
for _, event in heldEvents() do
	if event[3] == "screen" then
		local props = serde.decode("json", event[4])
		if props.to == "" and props.from == "Shop" then
			closed = true
		end
	end
end
check("screen closed", closed)

check("no chunk yet", #messages("rec") == 0)
step(10) -- 10 s: a chunk
check("chunk after 10 s", #messages("rec") == 1, #messages("rec"))
fakeNow = firstInputAt + 59
step(0.5)
check("still recording at 59.5 s", #messages("rec") <= 2)
step(1)
local chunks = messages("rec")
local last = chunks[#chunks]
check("ends 60 s after the first input", last and last[6] == true and last[7] == "window", last and tostring(last[7]))
local stateRec = persist["__typetorch/analytics-client.v1"].rec
check("persisted state ended", stateRec.ended == true and stateRec.chunk == #chunks)
local indexes = {}
for _, chunk in chunks do
	table.insert(indexes, chunk[2])
end
local sequential = true
for index, value in indexes do
	if value ~= index - 1 then
		sequential = false
	end
end
check("chunk indexes 0..n", sequential and #indexes == 3, table.concat(indexes, ","))

local records = {}
for _, chunk in chunks do
	local decoded = C.decodeChunk(chunk[5])
	for _, record in decoded.records do
		table.insert(records, record)
	end
end
local texts, keys, samples, pointers = {}, {}, 0, 0
for _, record in records do
	if record.tag == 7 then
		table.insert(texts, `{record.kind}:{record.text or ""}`)
	elseif record.tag == 4 then
		table.insert(keys, record.code)
	elseif record.tag == 2 then
		samples += 1
	elseif record.tag == 5 then
		pointers += 1
	end
end
local textList = table.concat(texts, " ")
check("samples written (unchanged skipped)", samples >= 6 and samples <= 9, samples)
check("only the key typed outside a text box", #keys == 1 and keys[1] == Enum.KeyCode.W.Value, table.concat(keys, ","))
check("touch pointer", pointers == 1)
check("text box: path only", string.find(textList, "10:Shop/Main/NameBox", 1, true) ~= nil, textList)
check("button press", string.find(textList, "1:Shop/Main/Buy", 1, true) ~= nil)
local hovers = 0
for _, text in texts do
	if text == "2:Shop/Main/Buy" then
		hovers += 1
	end
end
check("hover once", hovers == 1, hovers)
check("dev menu button never", not string.find(textList, "Toggle", 1, true))
check("prompt path", string.find(textList, "7:Door/Open", 1, true) ~= nil, textList)
check("custom event", string.find(textList, "11:bought_coins", 1, true) ~= nil)
check("screen close in recording", string.find(textList, "4:Shop", 1, true) ~= nil)
local firstSample
for _, record in records do
	if record.tag == 2 then
		firstSample = record
		break
	end
end
check("sample position", firstSample and math.abs(firstSample.values[1] - 10) < 0.1 and math.abs(firstSample.values[3] + 5) < 0.1, firstSample and firstSample.values[1])
check("camera position", firstSample and math.abs(firstSample.values[5] - 10) < 0.1 and math.abs(firstSample.values[6] - 10) < 0.1 and math.abs(firstSample.values[7] - 5) < 0.1)
local recCount = #messages("rec")
step(20)
check("nothing after the end", #messages("rec") == recCount)

-- A new generation (client swap) doesn't record again; a swap sends held events at once.
client:track("custom", "before_swap", nil)
local evBefore = #messages("ev")
for listener in swapOut do
	listener({ reason = "deploy" })
end
check("swap sends held events", #messages("ev") == evBefore + 1)
trove:clean()
sent = {}
local trove2 = Trove.new()
local client2 = ClientAnalytics.new({}, dispatcher, trove2)
raw["__tt/an"]("hi", { pid = string.rep("ab", 16), newp = true, rec = true, tech = 60, exps = {} })
step(15)
check("ended recording never restarts", #messages("rec") == 0)
client2:setActivity("round")
client2:setActivity("round")
client2:flush()
local activities = 0
for _, event in heldEvents() do
	if event[3] == "activity" then
		activities += 1
	end
end
check("activity once", activities == 1)
check("load only once", messages("hello")[1][2].load == nil)
trove2:clean()

print(`analytics client: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
process.exit(0)
