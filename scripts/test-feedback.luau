--!nocheck
-- Offline test of TypeTorch.feedback() (plans/32) under Lune: the config check (defaults, 2..10 steps, labels per step,
-- thumbs = 2), rating normalisation (thumbs, stars, scale), text sanitising and the caps (maxText characters and 2000
-- UTF-8 bytes, never half a code point, multi-byte text), topic and ctx, the rate windows, and the server half
-- (out/feedback/server.luau with the real analytics/rows and runtime/player-state): the row's shape, text-only rows,
-- refusals (empty, bad_rating, no_session, disabled, rate_limited), the settings record's game.feedback over
-- configure(), and the rate state cleared when the player leaves. Run after `bun run build`:
--   lune run scripts/test-feedback.luau out/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")
local task = require("@lune/task")
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

-- Mocks --------------------------------------------------------------------------------------------------------------

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
			task.spawn(fn, ...)
		end
	end
	return signal
end

local Trove = {}
Trove.__index = Trove
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

local INSTANCE = {}
local PlayersService = { PlayerAdded = Signal(), PlayerRemoving = Signal(), list = {} }
PlayersService[INSTANCE] = true
function PlayersService:GetPlayers()
	return table.clone(self.list)
end
local function makePlayer(userId)
	local player = { UserId = userId, Name = "P" .. userId, Parent = PlayersService, [INSTANCE] = true }
	function player:IsA(class)
		return class == "Player"
	end
	table.insert(PlayersService.list, player)
	return player
end
local function leave(player)
	PlayersService.PlayerRemoving:Fire(player)
	task.wait()
	table.remove(PlayersService.list, table.find(PlayersService.list, player))
	player.Parent = nil
end

local HttpService = {}
function HttpService:JSONEncode(value)
	return serde.encode("json", value)
end
local services = { HttpService = HttpService, Players = PlayersService }

local settingsMock = { current = nil }
local outFolder = { Name = "out" }
local G = {}
local loaded = {}
local TS = {}
local internals
function TS.getModule(_, scope, name)
	return { external = scope .. "/" .. name }
end
local loadOut
function TS.import(_, parent, ...)
	if type(parent) == "table" and parent.external then
		return services
	end
	local path = table.concat({ ... }, "/")
	if parent ~= outFolder and parent.Name ~= "out" then
		path = parent.Name .. "/" .. path
	end
	if internals[path] then
		return internals[path]
	end
	return loadOut(path)
end
local warnings = {}
function loadOut(path)
	if loaded[path] then
		return loaded[path]
	end
	local folder = if path:find("/") then { Name = path:match("^[^/]+"), Parent = outFolder } else outFolder
	local script = { Name = path:match("[^/]+$"), Parent = folder }
	G[script] = TS
	local environment = setmetatable({
		script = script,
		_G = G,
		task = task,
		typeof = function(value)
			if type(value) == "table" and value[INSTANCE] then
				return "Instance"
			end
			return typeof(value)
		end,
		warn = function(...)
			table.insert(warnings, table.concat({ ... }, " "))
		end,
	}, { __index = _G })
	local value = luau.load(fs.readFile(base .. path .. ".luau"), { debugName = path, environment = environment })()
	loaded[path] = value
	return value
end

internals = {
	settings = {
		currentSettings = function()
			return settingsMock.current
		end,
	},
}

local Core = loadOut("feedback/core")
local Rows = loadOut("analytics/rows")
local PlayerStates = loadOut("runtime/player-state")
local FeedbackServer = loadOut("feedback/server").FeedbackServer

local function resolves(raw)
	local ok, result = pcall(Core.resolveFeedbackConfig, raw)
	return ok, result
end

-- Config ----------------------------------------------------------------------------------------------------------------

local ok, defaults = resolves(nil)
check("defaults: stars5", ok and defaults.scale.id == "stars5" and defaults.scale.type == "stars" and defaults.scale.steps == 5)
check("defaults: maxText 1000, 2/min, 20/day", defaults.maxText == 1000 and defaults.perMinute == 2 and defaults.perDay == 20 and defaults.enabled)
local FACES = { "BAD", "MEH", "OK", "GOOD", "GREAT" }
local faces
ok, faces = resolves({ scale = { id = "faces5", type = "scale", steps = 5, labels = FACES }, maxText = 300, rate = { perMinute = 3 } })
check("faces5 config", ok and faces.scale.id == "faces5" and faces.scale.labels[5] == "GREAT" and faces.maxText == 300 and faces.perMinute == 3 and faces.perDay == 20, faces)
local thumbs
ok, thumbs = resolves({ scale = { id = "thumbs", type = "thumbs", steps = 7, labels = { "Down", "Up" } } })
check("thumbs: steps ignored (always 2)", ok and thumbs.scale.steps == 2, thumbs)
check("false: disabled", (select(2, resolves(false))).enabled == false)
check("enabled = false: disabled", (select(2, resolves({ enabled = false }))).enabled == false)
local function refused(label, raw, needle)
	local good, err = resolves(raw)
	check("refused: " .. label, not good and (needle == nil or tostring(err):find(needle, 1, true) ~= nil), err)
end
refused("1 step", { scale = { id = "a", type = "stars", steps = 1 } }, "2..10")
refused("11 steps", { scale = { id = "a", type = "scale", steps = 11 } }, "2..10")
refused("fractional steps", { scale = { id = "a", type = "scale", steps = 4.5 } }, "2..10")
refused("no steps", { scale = { id = "a", type = "stars" } }, "2..10")
refused("labels != steps", { scale = { id = "a", type = "scale", steps = 5, labels = { "a", "b", "c" } } }, "one label per step")
refused("thumbs with 3 labels", { scale = { id = "a", type = "thumbs", labels = { "a", "b", "c" } } }, "thumbs is always 2")
refused("empty label", { scale = { id = "a", type = "scale", steps = 2, labels = { "", "b" } } }, "1-32")
refused("bad type", { scale = { id = "a", type = "slider", steps = 5 } }, "thumbs, stars or scale")
refused("bad id", { scale = { id = "Faces 5", type = "stars", steps = 5 } }, "[a-z0-9_]")
refused("maxText 0", { maxText = 0 }, "maxText")
refused("maxText 5000", { maxText = 5000 }, "maxText")
refused("perMinute 0", { rate = { perMinute = 0 } }, "perMinute")
refused("not an object", "stars", "object")

-- Ratings ---------------------------------------------------------------------------------------------------------------

local function norm(config, rating)
	return Core.normaliseRating(config.scale, rating)
end
local up, down = norm(thumbs, 1), norm(thumbs, 0)
check("thumbs up", up and up.r == 1 and up.norm == 1 and up.label == "Up")
check("thumbs down", down and down.r == 0 and down.norm == 0 and down.label == "Down")
check("thumbs 2: bad", norm(thumbs, 2) == nil)
check("thumbs -1: bad", norm(thumbs, -1) == nil)
check("stars 1 -> 0", norm(defaults, 1).norm == 0 and norm(defaults, 1).label == nil)
check("stars 3 -> 0.5", norm(defaults, 3).norm == 0.5)
check("stars 5 -> 1", norm(defaults, 5).norm == 1)
check("stars 0, 6: bad", norm(defaults, 0) == nil and norm(defaults, 6) == nil)
check("stars 2.5: bad", norm(defaults, 2.5) == nil)
check("stars NaN, inf, string: bad", norm(defaults, 0 / 0) == nil and norm(defaults, math.huge) == nil and norm(defaults, "3") == nil)
check("faces 4 -> GOOD 0.75", norm(faces, 4).label == "GOOD" and norm(faces, 4).norm == 0.75)
local _, scale7 = resolves({ scale = { id = "s7", type = "scale", steps = 7 } })
check("scale7 2 -> 0.1667 (4 decimals)", norm(scale7, 2).norm == 0.1667, norm(scale7, 2).norm)
check("scale7 6 -> 0.8333", norm(scale7, 6).norm == 0.8333, norm(scale7, 6).norm)

-- Text ------------------------------------------------------------------------------------------------------------------

local function clean(text, max)
	return Core.sanitiseText(text, max or 1000)
end
local cleaned = clean("  hello\n\n\tworld\0 \u{200B}again \u{202E}x\r\n ")
check("sanitise: controls stripped, whitespace collapsed, trimmed", cleaned.text == "hello world again x", cleaned.text)
check("sanitise: len is the raw length", cleaned.len == utf8.len("  hello\n\n\tworld\0 \u{200B}again \u{202E}x\r\n "), cleaned.len)
check("whitespace only: no text, len 0", clean(" \n\t ").text == "" and clean(" \n\t ").len == 0)
check("not a string: no text", clean(42).text == "" and clean(nil).len == 0)
check("invalid UTF-8 bytes dropped", clean("a\255b\192\175c").text == "abc", clean("a\255b\192\175c").text)
check("non-breaking space collapses", clean("a\u{00A0}\u{00A0}b").text == "a b")
check("unicode kept", clean("güzel oyun 🎮").text == "güzel oyun 🎮")
local capped = clean("abcdefgh", 5)
check("maxText caps characters", capped.text == "abcde" and capped.len == 8, capped.text)
check("cap trims a trailing space", clean("abcd efgh", 5).text == "abcd")
local function valid(text)
	return utf8.len(text) ~= nil
end
local twoByte = clean(string.rep("é", 1500), 1000)
check("2-byte: 1000 chars, 2000 bytes", utf8.len(twoByte.text) == 1000 and #twoByte.text == 2000 and twoByte.len == 1500, #twoByte.text)
local threeByte = clean(string.rep("€", 1000), 1000)
check("3-byte: 666 chars (1998 bytes), not split", valid(threeByte.text) and utf8.len(threeByte.text) == 666 and #threeByte.text == 1998, #threeByte.text)
local fourByte = clean(string.rep("😀", 600), 1000)
check("4-byte: 500 chars (2000 bytes)", valid(fourByte.text) and utf8.len(fourByte.text) == 500 and #fourByte.text == 2000 and fourByte.len == 600)
local mixed = clean(string.rep("a", 1999) .. "😀", 2000)
check("a code point that doesn't fit is left out whole", mixed.text == string.rep("a", 1999), #mixed.text)
local ascii = clean(string.rep("x", 5000), 2000)
check("2000 ASCII bytes at maxText 2000", #ascii.text == 2000 and ascii.len == 5000)
local huge = clean(string.rep("y", 100000))
check("huge text: capped, len counts it all", #huge.text == 1000 and huge.len == 100000)

-- Topic and ctx ---------------------------------------------------------------------------------------------------------

check("topic bug kept", Core.cleanTopic("bug") == "bug")
check("topic Bug!/long/number dropped", Core.cleanTopic("Bug!") == nil and Core.cleanTopic(string.rep("a", 33)) == nil and Core.cleanTopic(5) == nil)
local ctxIn = { level = 12, map = "forest", ok = true, ["Bad-Key"] = 1, nested = { 1 }, nan = 0 / 0, long = string.rep("z", 100) }
for index = 1, 6 do
	ctxIn["k" .. index] = index
end
local ctx = Core.cleanContext(ctxIn)
local keys = {}
for key in ctx do
	table.insert(keys, key)
end
table.sort(keys)
check("ctx: at most 8 valid keys, sorted", #keys == 8 and table.concat(keys, ",") == "k1,k2,k3,k4,k5,k6,level,long", table.concat(keys, ","))
check("ctx: long string capped at 64", ctx.long == string.rep("z", 64))
check("ctx: few keys kept as they are", serde.encode("json", Core.cleanContext({ level = 12, map = "forest", ok = true })) == serde.encode("json", { level = 12, map = "forest", ok = true }))
check("ctx: nothing valid -> nil", Core.cleanContext({ ["A"] = 1 }) == nil and Core.cleanContext("x") == nil)

-- Rate windows ----------------------------------------------------------------------------------------------------------

local rate = { times = {} }
local function attempt(now, perMinute, perDay)
	if Core.rateAllows(rate, now, perMinute, perDay) then
		Core.rateRecord(rate, now)
		return true
	end
	return false
end
check("rate: 2 a minute", attempt(0, 2, 5) and attempt(10, 2, 5) and not attempt(59, 2, 5))
check("rate: the minute window slides", attempt(60.5, 2, 5) and not attempt(65, 2, 5) and attempt(71, 2, 5))
check("rate: 5 a day", attempt(200, 2, 5) and not attempt(400, 2, 5) and not attempt(86399, 2, 5))
check("rate: a day later again", attempt(86400 + 11, 2, 5) and #rate.times <= 5, #rate.times)

-- The row ---------------------------------------------------------------------------------------------------------------

local function size(props)
	return #serde.encode("json", props)
end
local function build(config, input, play)
	return Core.buildFeedbackProps(config, input, play or 0, size, 4096)
end
local row = build(faces, { rating = 4, text = " great  game ", topic = "idea", ctx = { level = 3 } }, 125.7).props
check(
	"row shape",
	row.scale == "faces5" and row.type == "scale" and row.steps == 5 and row.r == 4 and row.norm == 0.75 and row.label == "GOOD"
		and row.text == "great game" and row.len == 13 and row.topic == "idea" and row.ctx.level == 3 and row.play_s == 125,
	serde.encode("json", row)
)
local textOnly = build(faces, { text = "the shop is broken" }).props
check("text-only row: scale kept, no r / norm / label", textOnly.scale == "faces5" and textOnly.type == "scale" and textOnly.steps == 5 and textOnly.r == nil and textOnly.norm == nil and textOnly.label == nil and textOnly.len == 18)
local ratingOnly = build(defaults, { rating = 2 }).props
check("rating-only row: len 0, no text, no label", ratingOnly.len == 0 and ratingOnly.text == nil and ratingOnly.label == nil and ratingOnly.norm == 0.25)
local thumbsRow = build(thumbs, { rating = 0 }).props
check("thumbs row: steps 2, r 0, norm 0, Down", thumbsRow.steps == 2 and thumbsRow.r == 0 and thumbsRow.norm == 0 and thumbsRow.label == "Down" and thumbsRow.type == "thumbs")
check("empty: no rating, no text", build(faces, {}).reason == "empty" and build(faces, { text = " \n " }).reason == "empty")
check("bad_rating: 0, 6, 2.5, string", build(faces, { rating = 0 }).reason == "bad_rating" and build(faces, { rating = 6 }).reason == "bad_rating" and build(faces, { rating = 2.5, text = "x" }).reason == "bad_rating" and build(faces, { rating = "4" }).reason == "bad_rating")
local _, maxConfig = resolves({ maxText = 2000 })
local quoted = build(maxConfig, { rating = 5, text = string.rep('"', 3000), ctx = { a = string.rep("q", 64) } }).props
check("escapes: the text is cut so the row fits 4096 bytes", quoted.text ~= nil and size(quoted) <= 4096 and #quoted.text < 2000, size(quoted))
local cjk = build(maxConfig, { text = string.rep("界", 3000) }).props
check("multi-byte: at most 2000 bytes, whole code points", #cjk.text <= 2000 and valid(cjk.text) and size(cjk) <= 4096 and cjk.len == 3000, #cjk.text)

-- The server --------------------------------------------------------------------------------------------------------------

local persistStore = {}
local trove = Trove.new()
PlayerStates.bindPlayerStates(trove, function(key, init)
	if persistStore[key] == nil then
		persistStore[key] = init()
	end
	return persistStore[key]
end)
local now = 1000
local server = FeedbackServer.new(function()
	return now
end)
local alice = makePlayer(1001)
local bob = makePlayer(1002)

check("no engine: no_session", server:submit(alice, { rating = 3 }).reason == "no_session")
local rows = {}
local unregisterRows = Rows.registerBuiltinRows(function(target, kind, name, props)
	table.insert(rows, { target = target, kind = kind, name = name, props = props })
end)
local plays = { [alice] = 42 }
local unregisterSessions = Rows.registerBuiltinSessions(function(player)
	local seconds = plays[player]
	return if seconds then { playSeconds = seconds } else nil
end)
check("no session for the player: no_session", server:submit(bob, { rating = 3 }).reason == "no_session" and #rows == 0)
plays[bob] = 7

local result = server:submit(alice, { rating = 5, text = "Love it", topic = "idea", ctx = { level = 12, map = "forest" } })
check("submit ok (defaults: stars5)", result.ok == true and #rows == 1, result.reason)
local written = rows[1]
check("row: kind feedback, name submit, on the player", written and written.kind == "feedback" and written.name == "submit" and written.target == alice)
check(
	"row props",
	written and written.props.scale == "stars5" and written.props.type == "stars" and written.props.steps == 5 and written.props.r == 5 and written.props.norm == 1
		and written.props.text == "Love it" and written.props.len == 7 and written.props.play_s == 42 and written.props.topic == "idea" and written.props.ctx.map == "forest",
	written and serde.encode("json", written.props)
)
check("no UserId or username on the row", written and written.props.userId == nil and written.props.username == nil and not serde.encode("json", written.props):find("P1001"))

-- Refusals don't count; the third accepted one a minute is rate_limited.
check("bad_rating refused", server:submit(alice, { rating = 9 }).reason == "bad_rating")
check("empty refused", server:submit(alice, { text = "   " }).reason == "empty")
check("second ok", server:submit(alice, { text = "more" }).ok == true)
check("third in a minute: rate_limited", server:submit(alice, { rating = 1 }).reason == "rate_limited" and #rows == 2)
check("another player has their own limit", server:submit(bob, { rating = 1 }).ok == true)
now += 61
check("a minute later: ok", server:submit(alice, { rating = 2 }).ok == true)
check("rate state in playerState", persistStore.__playerState and persistStore.__playerState["__typetorch/feedback.rate.v1"] ~= nil)

-- Leaving clears the player's rate state.
local _, perDay2 = resolves({ rate = { perDay = 3 } })
server:configure({ rate = { perDay = 3 } })
check("perDay 3 reached", server:submit(alice, { rating = 3 }).reason == "rate_limited")
leave(alice)
task.wait(0.05)
local store = persistStore.__playerState["__typetorch/feedback.rate.v1"]
check("leave clears the player's rate state", store and store[1001] == nil and store[1002] ~= nil)
local alice2 = makePlayer(1001)
plays[alice2] = 1
check("rejoined: allowed again", server:submit(alice2, { rating = 3 }).ok == true and rows[#rows].props.play_s == 1)

-- configure() and the settings record.
check("configure: invalid throws", not pcall(function()
	server:configure({ scale = { id = "x", type = "scale", steps = 12 } })
end))
server:configure({ scale = { id = "faces5", type = "scale", steps = 5, labels = FACES } })
check("configure: scale()", server:scale().id == "faces5" and server:scale().labels[1] == "BAD")
now += 3600
check("configure: faces label on the row", server:submit(bob, { rating = 1 }).ok and rows[#rows].props.label == "BAD" and rows[#rows].props.norm == 0)
settingsMock.current = { game = { feedback = { scale = { id = "thumbs", type = "thumbs", labels = { "Down", "Up" } } } } }
check("the record wins over configure", server:scale().id == "thumbs")
check("record: thumbs row", server:submit(bob, { rating = 1 }).ok and rows[#rows].props.type == "thumbs" and rows[#rows].props.label == "Up" and rows[#rows].props.steps == 2)
check("record: 3 is a bad thumbs rating", server:submit(bob, { rating = 3 }).reason == "bad_rating")
settingsMock.current = { game = { feedback = { enabled = false } } }
check("record: enabled = false -> disabled", server:submit(bob, { rating = 1 }).reason == "disabled" and server:scale() == nil)
local warned = #warnings
settingsMock.current = { game = { feedback = { scale = { id = "x", type = "scale", steps = 3, labels = { "a" } } } } }
check("record: invalid -> disabled, warned once", server:submit(bob, { rating = 1 }).reason == "disabled" and server:submit(bob, { rating = 1 }).reason == "disabled" and #warnings == warned + 1, #warnings - warned)
settingsMock.current = { game = {} }
check("record without game.feedback: configure applies", server:scale().id == "faces5")
check("not a player / not a table: refused, no error", pcall(function()
	server:submit(bob, "nope")
end))

unregisterRows()
unregisterSessions()
check("engine gone: no_session", server:submit(bob, { rating = 1 }).reason == "no_session")

print(`test-feedback: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
