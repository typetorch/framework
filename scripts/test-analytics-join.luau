--!nocheck
-- Offline test of the join row's join metadata (out/analytics/join.luau, plans/29 "Native join metadata") under Lune:
-- every GetJoinData field and player fact as props, `from` (notification first among the launch-data cases), the launch
-- data cases (verified, tt_bad, the game's own), and privacy: no other player's UserId in any prop, ever. Run after
-- `bun run build`:
--   cd ../kernel && lune run ../framework/scripts/test-analytics-join.luau ../framework/
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")
local root = process.args[1] or "./"

local J = luau.load(fs.readFile(root .. "out/analytics/join.luau"), { debugName = "join", environment = setmetatable({}, { __index = _G }) })()

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end

local ME, REF, FOLLOW, FRIEND, STRANGER = 1111111111, 2222222222, 3333333333, 4444444444, 5555555555
local KNOWN = { [REF] = "pidref00000000000000000000000000", [FRIEND] = "pidfriend0000000000000000000000" }
local function pidOf(userId)
	return KNOWN[userId]
end
local function facts(overrides)
	local base = { userId = ME, gameId = 42, followUserId = 0, accountAge = 400.7, locale = "tr-tr", verified = false, membership = "Premium" }
	for key, value in overrides or {} do
		base[key] = value
	end
	return base
end
-- Every other player's UserId must be absent from the encoded props (as a number or text).
local function noOtherUserIds(label, props)
	local text = serde.encode("json", props)
	for _, userId in { REF, FOLLOW, FRIEND, STRANGER } do
		check(label .. ": no UserId " .. userId, not text:find(tostring(userId), 1, true), text)
	end
end

-- Everything at once (a party teleport from another game, with a referrer and a follow) -----------------------------------------
do
	local data = {
		SourcePlaceId = 777,
		SourceGameId = 99,
		ReferredByPlayerId = REF,
		Members = { ME, FRIEND, STRANGER, FRIEND },
		HasTeleportData = true,
		LaunchData = "shop/item/7?ref=" .. tostring(STRANGER):sub(1, 3) .. string.rep("x", 40),
		GameJoinContext = { JoinSource = "AvatarItem", ItemType = "Asset", AssetId = "123", OutfitId = "456", AssetType = "Hat" },
	}
	local props = J.joinProps(data, facts({ followUserId = FOLLOW, tpBytes = 321 }), pidOf, nil)
	check("from teleport_game", props.from == "teleport_game", props.from)
	check("src_place / src_game", props.src_place == 777 and props.src_game == 99)
	check("ref as pid", props.ref == KNOWN[REF], props.ref)
	check("follow unknown = other", props.follow == "other", props.follow)
	check("party count", props.party == 4)
	check("party pids: known only, deduped, not mine", #props.party_pids == 1 and props.party_pids[1] == KNOWN[FRIEND])
	check("ctx fields", props.ctx == "AvatarItem" and props.ctx_item == "Asset" and props.ctx_asset == "123" and props.ctx_outfit == "456" and props.ctx_asset_type == "Hat")
	check("tp + tp_bytes", props.tp == true and props.tp_bytes == 321)
	check("launch: off by default, length only", props.launch == nil and props.launch_len == #data.LaunchData)
	local prefixed = J.joinProps(data, facts({ followUserId = FOLLOW, tpBytes = 321 }), pidOf, nil, { launchPrefix = true })
	check("launch: joinLaunchPrefix keeps the first 32 chars", prefixed.launch == data.LaunchData:sub(1, 32) and prefixed.launch_len == #data.LaunchData)
	check("age_days", props.age_days == 400)
	check("locale / verified / membership", props.locale == "tr-tr" and props.verified == false and props.membership == "Premium")
	noOtherUserIds("everything", props)
end

-- from ----------------------------------------------------------------------------------------------------------------------
do
	check("direct", J.joinProps({}, facts(), pidOf, nil).from == "direct")
	check("no join data: direct", J.joinProps(nil, facts(), pidOf, nil).from == "direct")
	check("teleport (same game)", J.joinProps({ SourcePlaceId = 1, SourceGameId = 42 }, facts(), pidOf, nil).from == "teleport")
	local referral = J.joinProps({ ReferredByPlayerId = STRANGER }, facts(), pidOf, nil)
	check("referral, unknown referrer = other", referral.from == "referral" and referral.ref == "other")
	noOtherUserIds("referral", referral)
	check("share", J.joinProps({ LaunchData = "abc" }, facts(), pidOf, nil).from == "share")
	local follow = J.joinProps({}, facts({ followUserId = REF }), pidOf, nil)
	check("follow, known = pid", follow.from == "follow" and follow.follow == KNOWN[REF])
	noOtherUserIds("follow", follow)

	local token = "tt1n.abc0123xyz.gift_new.21i3v9.t5chpc.bWFpbDo0Mg.qHiEc9Cd2kb-f4921kh__g"
	local good = J.joinProps({ LaunchData = token }, facts(), pidOf, { ok = true, nid = "abc0123xyz", kind = "gift_new" })
	check("notification: from / launch / nid / nk", good.from == "notification" and good.launch == "notification" and good.nid == "abc0123xyz" and good.nk == "gift_new")
	check("notification: the token never lands in props", good.launch_len == nil and not serde.encode("json", good):find("qHiEc9", 1, true))
	local bad = J.joinProps({ LaunchData = token }, facts(), pidOf, { ok = false, why = "user" })
	check("tt_bad: from share, launch tt_bad + why", bad.from == "share" and bad.launch == "tt_bad" and bad.launch_bad == "user" and bad.nid == nil)
	check("tt_bad: no token text", bad.launch_len == nil and not serde.encode("json", bad):find("qHiEc9", 1, true))
	-- A teleport keeps its from even with a verified token (teleport data wins, as before).
	check("teleport beats notification", J.joinProps({ SourcePlaceId = 1, LaunchData = token }, facts(), pidOf, { ok = true, nid = "n", kind = "k" }).from == "teleport")
end

-- Small cases -----------------------------------------------------------------------------------------------------------------
do
	local plain = J.joinProps({}, facts({ locale = "", accountAge = -3 }), pidOf, nil)
	check("empty locale left out", plain.locale == nil)
	local bare = J.joinProps({}, { userId = ME, gameId = 42, followUserId = 0, accountAge = 1 }, pidOf, nil)
	check("unknown facts left out", bare.locale == nil and bare.verified == nil and bare.membership == nil and bare.age_days == 1)
	check("age_days never negative", plain.age_days == 0)
	check("no tp without TeleportData", plain.tp == nil and plain.tp_bytes == nil)
	check("no party without members", plain.party == nil and plain.party_pids == nil)
	local empty = J.joinProps({ Members = {} }, facts(), pidOf, nil)
	check("empty members", empty.party == nil)
	local many = {}
	for index = 1, 30 do
		table.insert(many, 9000000000 + index)
	end
	local all = J.joinProps({ Members = many }, facts(), function(userId)
		return string.format("pid%029d", userId - 9000000000)
	end, nil)
	check("party pids capped", #all.party_pids == J.PARTY_PIDS_MAX and all.party == 30)
	local blankContext = J.joinProps({ GameJoinContext = { JoinSource = "Direct", AssetId = "" } }, facts(), pidOf, nil)
	check("blank context ids left out", blankContext.ctx == "Direct" and blankContext.ctx_asset == nil)
	local wanted = J.wantedUserIds({ ReferredByPlayerId = REF, Members = { ME, FRIEND, REF } }, facts({ followUserId = FOLLOW }))
	check("wantedUserIds: deduped, not mine", #wanted == 3 and wanted[1] == REF and wanted[2] == FOLLOW and wanted[3] == FRIEND, #wanted)
	check("wantedUserIds: none", #J.wantedUserIds(nil, facts()) == 0)
end

-- The raw join data: jd (plans/30) -----------------------------------------------------------------------------------------
do
	local Enum = require("@lune/roblox").Enum
	local encode = function(value)
		return serde.encode("json", value)
	end
	local quote = function(text)
		return serde.encode("json", text)
	end
	local function jd(raw, followUserId, lookup)
		local value = J.joinDataJson(raw, followUserId or 0, lookup or pidOf, encode, quote)
		if value == nil then
			return nil, nil
		end
		local text = J.encodeJoinData(value, quote)
		return serde.decode("json", text), text
	end
	local function noIds(label, text)
		for _, userId in { REF, FOLLOW, FRIEND, STRANGER } do
			check(label .. ": no UserId " .. userId, not text:find(tostring(userId), 1, true), text)
		end
	end

	-- The evidence case: Roblox dropped the launch data, the context came back empty.
	local evidence, evidenceText = jd({ LaunchData = "", GameJoinContext = {} })
	check("evidence: keys sorted", #evidence.keys == 2 and evidence.keys[1] == "GameJoinContext" and evidence.keys[2] == "LaunchData")
	check("evidence: empty launch data kept", evidence.LaunchData == "" and evidence.LaunchDataLen == 0)
	check("evidence: empty context is {} (not [])", evidenceText:find('"GameJoinContext":{}', 1, true) ~= nil, evidenceText)
	check("evidence: nothing else", evidence.SourcePlaceId == nil and evidence.Members == nil and evidence.TeleportData == nil and evidence.other == nil and evidence.trunc == nil)
	local absent, absentText = jd({})
	check("absent context: no key", absent.GameJoinContext == nil and absent.LaunchData == nil and absent.LaunchDataLen == nil and #absent.keys == 0)
	check("absent: keys is a list", absentText:find('"keys":[]', 1, true) ~= nil, absentText)
	check("GetJoinData failed: no jd", J.joinDataJson(nil, 0, pidOf, encode, quote) == nil)

	-- Enum fields by .Name, every field as text.
	local context = jd({ GameJoinContext = { JoinSource = Enum.JoinSource.CreatedItemAttribution, ItemType = Enum.AvatarItemType.Asset, AssetId = "123", OutfitId = 456, AssetType = Enum.AssetType.Hat } })
	local c = context.GameJoinContext
	check("context: enums by name", c.JoinSource == "CreatedItemAttribution" and c.ItemType == "Asset" and c.AssetType == "Hat", serde.encode("json", c))
	check("context: every field as text", c.AssetId == "123" and c.OutfitId == "456")

	-- Ids: numbers; ReferredByPlayerId 0: absent; Follow from the player.
	local ids, idsText = jd({ SourcePlaceId = 1818, SourceGameId = 2828, ReferredByPlayerId = 0 }, FOLLOW)
	check("place / game ids as numbers", ids.SourcePlaceId == 1818 and ids.SourceGameId == 2828)
	check("ReferredByPlayerId 0: absent (key still listed)", ids.ReferredByPlayerId == nil and table.find(ids.keys, "ReferredByPlayerId") ~= nil)
	check("FollowUserId unknown: other", ids.FollowUserId == "other")
	noIds("ids", idsText)
	local referred = jd({ ReferredByPlayerId = REF }, 0)
	check("referrer known: pid", referred.ReferredByPlayerId == KNOWN[REF] and referred.FollowUserId == nil)

	-- Members: pids or other, in order, with the count; the joining player by their own pid when known.
	local lookup = function(userId)
		if userId == ME then
			return "pidme000000000000000000000000000"
		end
		return KNOWN[userId]
	end
	local members, membersText = jd({ Members = { ME, FRIEND, STRANGER, REF } }, 0, lookup)
	check("members: count + pids in order", members.Members.count == 4 and members.Members.pids[1] == "pidme000000000000000000000000000" and members.Members.pids[2] == KNOWN[FRIEND] and members.Members.pids[3] == "other" and members.Members.pids[4] == KNOWN[REF])
	noIds("members", membersText)

	-- TeleportData: size, type, top-level keys (at most 20, 32 chars each, sorted), never the content.
	local tp = {}
	for index = 1, 30 do
		tp[string.format("key%02d_", index) .. string.rep("z", 40)] = "SECRET" .. index
	end
	local teleport, teleportText = jd({ TeleportData = tp })
	check("teleport: bytes", teleport.TeleportData.bytes == #encode(tp), teleport.TeleportData.bytes)
	check("teleport: type", teleport.TeleportData.type == "table")
	check("teleport: 20 keys, 32 chars, sorted", #teleport.TeleportData.keys == 20 and #teleport.TeleportData.keys[1] == 32 and teleport.TeleportData.keys[1] < teleport.TeleportData.keys[2])
	check("teleport: never the content", not teleportText:find("SECRET", 1, true))
	local scalar = jd({ TeleportData = "SECRETSTRING" })
	check("teleport string: type + bytes only", scalar.TeleportData.type == "string" and scalar.TeleportData.keys == nil and scalar.TeleportData.bytes == 14)

	-- LaunchData: 200 bytes at a UTF-8 boundary, the full length.
	local long = string.rep("a", 199) .. "é" .. string.rep("b", 50) -- é = 2 bytes at 200..201
	local launch = jd({ LaunchData = long })
	check("launch: cut before a split character", launch.LaunchData == string.rep("a", 199) and launch.LaunchDataLen == #long, #launch.LaunchData)
	check("launch: 3-byte character", J.cutUtf8(string.rep("a", 198) .. "€x", 200) == string.rep("a", 198) and J.cutUtf8("ab€", 5) == "ab€" and J.cutUtf8("ab€", 4) == "ab")
	local exact = jd({ LaunchData = string.rep("c", 200) })
	check("launch: exactly 200 kept", #exact.LaunchData == 200)
	local nonString = jd({ LaunchData = 5 })
	check("launch: not a string, by type", nonString.LaunchData == nil and nonString.other.LaunchData == "number")

	-- Unknown keys: type only.
	local extra, extraText = jd({ LaunchData = "x", NewRobloxField = { secret = "SECRETVALUE" }, Another = "SECRETTOO" })
	check("unknown keys by type", extra.other.NewRobloxField == "table" and extra.other.Another == "string")
	check("unknown keys: never the value", not extraText:find("SECRET", 1, true))
	check("unknown keys listed", table.find(extra.keys, "NewRobloxField") ~= nil)

	-- The 1 KB cap: TeleportData keys go first, then Members pids, then LaunchData; trunc.
	local bigTp = {}
	for index = 1, 20 do
		bigTp[string.format("k%02d", index) .. string.rep("q", 29)] = index
	end
	local bigMembers = {}
	for index = 1, 40 do
		table.insert(bigMembers, 7000000000 + index)
	end
	local manyPids = function(userId)
		if userId > 7000000000 then
			return string.format("pid%029d", userId - 7000000000)
		end
		return nil
	end
	local capped, cappedText = jd({ LaunchData = string.rep("L", 200), TeleportData = bigTp, Members = bigMembers, GameJoinContext = { JoinSource = "Direct" } }, 0, manyPids)
	check("cap: <= 1024 bytes", #cappedText <= J.JD_MAX_BYTES, #cappedText)
	check("cap: trunc", capped.trunc == true)
	check("cap: teleport keys dropped first", capped.TeleportData.keys == nil and capped.TeleportData.bytes ~= nil)
	check("cap: members pids cut, count kept", capped.Members.count == 40 and (capped.Members.pids == nil or #capped.Members.pids < 40))
	check("cap: launch data kept while pids could go", #capped.LaunchData == 200)
	local small, smallText = jd({ LaunchData = "x", TeleportData = { a = 1 } })
	check("under the cap: no trunc", small.trunc == nil and not smallText:find("trunc", 1, true))
	-- Launch data shortens only after the lists are gone.
	local launchHeavy = {}
	for index = 1, 40 do
		launchHeavy["field" .. index] = string.rep("v", 40)
	end
	local heavy, heavyText = jd({ LaunchData = string.rep("\"", 200), GameJoinContext = launchHeavy }, 0)
	check("cap: escaped launch data + big context fits", #heavyText <= J.JD_MAX_BYTES and heavy.trunc == true, #heavyText)
	check("cap: launch data shortened", heavy.LaunchData == nil or #heavy.LaunchData < 200)
	check("cap: LaunchDataLen kept", heavy.LaunchDataLen == 200)
end

-- joinData "off": only the props from before plans/29 ----------------------------------------------------------------------
do
	local data = { SourcePlaceId = 777, SourceGameId = 99, ReferredByPlayerId = REF, Members = { FRIEND }, HasTeleportData = true, LaunchData = "abc", GameJoinContext = { JoinSource = "Direct", AssetId = "5" } }
	local off = J.joinProps(data, facts({ followUserId = FOLLOW, tpBytes = 9 }), pidOf, nil, { mode = "off" })
	local names = {}
	for name in off do
		table.insert(names, name)
	end
	table.sort(names)
	check("off: legacy props only", table.concat(names, ",") == "ctx,from,party,tp", table.concat(names, ","))
	local summary = J.joinProps(data, facts({ followUserId = FOLLOW, tpBytes = 9 }), pidOf, nil, { mode = "summary" })
	check("summary: every summary prop", summary.src_place == 777 and summary.ref == KNOWN[REF] and summary.ctx_asset == "5" and summary.launch_len == 3)
	check("modes", #J.JOIN_DATA_MODES == 3)
end

print(`analytics join: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
