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

print(`analytics join: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
