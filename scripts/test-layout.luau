-- Offline test of the dev menu's window manager core (out/devtools/layout.luau) under Lune: a fresh layout, splits in
-- both directions and their limits (desktop and phone), closing panes (splits collapse, a window's last pane closes the
-- window, the main panel keeps one), popping a pane out into a window and docking it back (split, replace on a full
-- phone panel, "full"), singleton pages (focus the open pane instead of a second copy), ratios, raise / focus repair,
-- and sanitizeLayout on persisted data from older or newer generations (garbage, unknown pages, duplicate ids and
-- singletons, deep trees, bad windows and order).
-- Run after `bun run build`:
--   cd ../kernel && lune run ../framework/scripts/test-layout.luau ../framework/
-- or from framework/: <rokit>/tool-storage/lune-org/lune/0.10.5/lune.exe run scripts/test-layout.luau
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local root = process.args[1] or "./"

local L = luau.load(fs.readFile(root .. "out/devtools/layout.luau"), { debugName = "layout" })()

local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
	else
		failed += 1
		print("FAIL " .. label .. (if detail ~= nil then ": " .. tostring(detail) else ""))
	end
end

local DESKTOP = L.limitsFor(false)
local PHONE = L.limitsFor(true)
local SINGLE = { Claude = true, ["Server/Branch"] = true }
local function single(page)
	return SINGLE[page] == true
end
local KNOWN = { Artifact = true, Claude = true, Logs = true, ["Modules/State"] = true, ["Server/Branch"] = true, ["Network/Packets"] = true }
local function known(page)
	return KNOWN[page] == true
end

local function pages(node)
	local list = {}
	for _, leaf in L.leavesOf(node) do
		table.insert(list, leaf.page)
	end
	return table.concat(list, ",")
end
local function ids(layout)
	local seen, dup = {}, false
	local function walk(node)
		if seen[node.id] then
			dup = true
		end
		seen[node.id] = true
		if node.kind == "split" then
			walk(node.a)
			walk(node.b)
		end
	end
	walk(layout.main)
	for _, win in layout.windows do
		if seen[win.id] then
			dup = true
		end
		seen[win.id] = true
		walk(win.root)
	end
	return not dup, seen
end

-- Fresh layout ----------------------------------------------------------------------------------------------------------
do
	local layout = L.newLayout("Modules/State")
	check("fresh: one leaf", layout.main.kind == "leaf" and layout.main.page == "Modules/State")
	check("fresh: id 1 focused", layout.main.id == 1 and layout.focus == 1)
	check("fresh: no windows, main in order", #layout.windows == 0 and #layout.order == 1 and layout.order[1] == 0)
	check("limits desktop", DESKTOP.main == 6 and DESKTOP.window == 4 and DESKTOP.rows == true)
	check("limits phone", PHONE.main == 2 and PHONE.window == 1 and PHONE.rows == false)
end

-- Splits ----------------------------------------------------------------------------------------------------------------
do
	local layout = L.newLayout("Artifact")
	local right = L.splitLeaf(layout, 1, "row", "Logs", DESKTOP)
	check("split right: new leaf", right ~= nil and right.page == "Logs")
	check("split right: tree", layout.main.kind == "split" and layout.main.dir == "row" and pages(layout.main) == "Artifact,Logs")
	check("split right: ratio 0.5", layout.main.ratio == 0.5)
	check("split right: focus moves", layout.focus == right.id)
	local down = L.splitLeaf(layout, right.id, "column", "Modules/State", DESKTOP)
	check("split down: nested", pages(layout.main) == "Artifact,Logs,Modules/State" and layout.main.b.kind == "split" and layout.main.b.dir == "column")
	check("ids unique", (ids(layout)))
	check("count", L.countLeaves(layout.main) == 3)
	-- Up to six panes, then no more.
	for _ = 1, 3 do
		L.splitLeaf(layout, layout.focus, "row", "Logs", DESKTOP)
	end
	check("six panes", L.countLeaves(layout.main) == 6)
	check("seventh refused", L.splitLeaf(layout, layout.focus, "row", "Logs", DESKTOP) == nil and L.countLeaves(layout.main) == 6)
	check("canSplit false when full", not L.canSplit(layout, 0, "column", DESKTOP))
	check("unknown leaf", L.splitLeaf(layout, 999, "row", "Logs", DESKTOP) == nil)
	check("findLeaf", L.findLeaf(layout, down.id)[1].page == "Modules/State" and L.findLeaf(layout, down.id)[2] == 0)
end

-- Phone limits ------------------------------------------------------------------------------------------------------------
do
	local layout = L.newLayout("Artifact")
	check("phone: no split right", L.splitLeaf(layout, 1, "row", "Logs", PHONE) == nil)
	check("phone: split down", L.splitLeaf(layout, 1, "column", "Logs", PHONE) ~= nil)
	check("phone: two panes at most", L.splitLeaf(layout, 1, "column", "Logs", PHONE) == nil)
	local win = L.popOut(layout, layout.focus, "Artifact", PHONE)
	check("phone: window maximised", win ~= nil and win.max == true)
	check("phone: no split in a window", not L.canSplit(layout, win.id, "column", PHONE))
end

-- Close -------------------------------------------------------------------------------------------------------------------
do
	local layout = L.newLayout("Artifact")
	check("close last main pane refused", L.closeLeaf(layout, 1) == false and layout.main.id == 1)
	local logs = L.splitLeaf(layout, 1, "row", "Logs", DESKTOP)
	local state = L.splitLeaf(layout, logs.id, "column", "Modules/State", DESKTOP)
	check("close: collapses split", L.closeLeaf(layout, logs.id) and pages(layout.main) == "Artifact,Modules/State")
	check("close: parent split kept as row", layout.main.kind == "split" and layout.main.dir == "row" and layout.main.b.id == state.id)
	check("close focused: focus moves", L.closeLeaf(layout, state.id) and layout.focus == 1 and layout.main.kind == "leaf")
	check("close unknown", L.closeLeaf(layout, 12345) == false)
end

-- Windows: pop out, close, dock -----------------------------------------------------------------------------------------
do
	local layout = L.newLayout("Network/Packets")
	local state = L.splitLeaf(layout, 1, "row", "Modules/State", DESKTOP)
	local win = L.popOut(layout, state.id, "Artifact", DESKTOP)
	check("popOut: window", win ~= nil and #layout.windows == 1 and win.root.id == state.id)
	check("popOut: main collapsed", layout.main.kind == "leaf" and layout.main.id == 1)
	check("popOut: on top and focused", layout.order[#layout.order] == win.id and layout.focus == state.id)
	check("popOut: desktop not maximised", win.max == nil)
	check("popOut window's only pane refused", L.popOut(layout, state.id, "Artifact", DESKTOP) == nil)
	-- The main panel's last pane leaves a fresh pane behind.
	local main = layout.main.id
	local win2 = L.popOut(layout, main, "Artifact", DESKTOP)
	check("popOut last main pane", win2 ~= nil and layout.main.kind == "leaf" and layout.main.page == "Artifact" and layout.main.id ~= main)
	check("ids unique after pop outs", (ids(layout)))
	-- Splitting inside a window.
	local inner = L.splitLeaf(layout, state.id, "column", "Logs", DESKTOP)
	check("split in window", inner ~= nil and L.countLeaves(win.root) == 2 and L.findLeaf(layout, inner.id)[2] == win.id)
	-- Closing a window's panes: the last one closes the window.
	check("close in window", L.closeLeaf(layout, inner.id) and #layout.windows == 2)
	check("close window's last pane", L.closeLeaf(layout, state.id) and #layout.windows == 1 and L.windowOf(layout, win.id) == nil)
	check("order drops closed window", not table.find(layout.order, win.id))
	-- Dock back: split next to the target.
	local outcome = L.dockWindow(layout, win2.id, layout.main.id, "row", DESKTOP)
	check("dock: split", outcome == "split" and #layout.windows == 0 and L.countLeaves(layout.main) == 2)
	check("dock: focus on docked pane", layout.focus == main)
	check("dock: order", #layout.order == 1 and layout.order[1] == 0)
	check("dock unknown window", L.dockWindow(layout, 999, 1, "row", DESKTOP) == "none")
end

do
	-- Phone: the main panel is full (2), a one-pane window replaces the target.
	local layout = L.newLayout("Artifact")
	local logs = L.splitLeaf(layout, 1, "column", "Logs", PHONE)
	L.splitLeaf(layout, 1, "column", "Logs", DESKTOP) -- a third pane (made on desktop)
	local win = L.popOut(layout, logs.id, "Artifact", PHONE)
	L.splitLeaf(layout, 1, "column", "Modules/State", DESKTOP)
	check("phone dock: main full", L.countLeaves(layout.main) == 3)
	local outcome = L.dockWindow(layout, win.id, 1, "row", PHONE)
	check("phone dock: replaced", outcome == "replaced" and L.findLeaf(layout, 1) == nil and L.findLeaf(layout, logs.id) ~= nil)
	check("phone dock: window gone", #layout.windows == 0)
	-- Desktop: a two-pane window into a full main panel is refused.
	local desk = L.newLayout("Artifact")
	for _ = 1, 4 do
		L.splitLeaf(desk, desk.focus, "row", "Logs", DESKTOP)
	end
	local pane = L.splitLeaf(desk, desk.focus, "row", "Logs", DESKTOP)
	local w = L.popOut(desk, pane.id, "Artifact", DESKTOP)
	L.splitLeaf(desk, pane.id, "column", "Logs", DESKTOP)
	L.splitLeaf(desk, 1, "row", "Logs", DESKTOP)
	check("desk: main full again", L.countLeaves(desk.main) == 6)
	check("desk dock full", L.dockWindow(desk, w.id, 1, "row", DESKTOP) == "full" and #desk.windows == 1)
end

-- Window count limit ------------------------------------------------------------------------------------------------------
do
	local layout = L.newLayout("Artifact")
	for _ = 1, 6 do
		L.splitLeaf(layout, 1, "row", "Logs", { main = 99, window = 4, windows = 6, rows = true })
		L.popOut(layout, layout.focus, "Artifact", DESKTOP)
	end
	check("six windows", #layout.windows == 6)
	L.splitLeaf(layout, 1, "row", "Logs", { main = 99, window = 4, windows = 6, rows = true })
	check("seventh window refused", L.popOut(layout, layout.focus, "Artifact", DESKTOP) == nil and #layout.windows == 6)
end

-- Singletons and pages ----------------------------------------------------------------------------------------------------
do
	local layout = L.newLayout("Claude")
	local other = L.splitLeaf(layout, 1, "row", "Artifact", DESKTOP)
	local found = L.openPage(layout, other.id, "Claude", single)
	check("singleton: focuses the open pane", found ~= nil and found[1].id == 1 and layout.focus == 1 and other.page == "Artifact")
	local again = L.openPage(layout, other.id, "Logs", single)
	check("openPage: switches", again ~= nil and other.page == "Logs" and layout.focus == other.id)
	local dup = L.openPage(layout, 1, "Logs", single)
	check("openPage: non-singleton twice", dup ~= nil and pages(layout.main) == "Logs,Logs")
	check("leavesWithPage", #L.leavesWithPage(layout, "Logs") == 2)
	check("openPage unknown leaf", L.openPage(layout, 999, "Artifact", single) == nil)
end

-- Ratios, raise, focus ----------------------------------------------------------------------------------------------------
do
	local layout = L.newLayout("Artifact")
	L.splitLeaf(layout, 1, "row", "Logs", DESKTOP)
	local split = layout.main
	check("setRatio", L.setRatio(layout, split.id, 0.3) and split.ratio == 0.3)
	check("setRatio clamps low", L.setRatio(layout, split.id, -2) and split.ratio == L.MIN_RATIO)
	check("setRatio clamps high", L.setRatio(layout, split.id, 7) and split.ratio == L.MAX_RATIO)
	check("setRatio nan", L.setRatio(layout, split.id, 0 / 0) and split.ratio == 0.5)
	check("setRatio unknown", L.setRatio(layout, 999, 0.4) == false)
	local win = L.popOut(layout, layout.focus, "Artifact", DESKTOP)
	L.raise(layout, 0)
	check("raise main", layout.order[#layout.order] == 0 and layout.order[1] == win.id)
	L.raise(layout, win.id)
	check("raise window", layout.order[#layout.order] == win.id)
	-- A minimised window's pane can't keep the focus.
	layout.focus = win.root.id
	win.min = true
	L.repairFocus(layout)
	check("focus leaves a minimised window", layout.focus == 1)
	layout.focus = 4242
	L.repairFocus(layout)
	check("focus repaired", layout.focus == 1)
end

-- sanitizeLayout ----------------------------------------------------------------------------------------------------------
do
	local fresh = L.sanitizeLayout(nil, known, single, "Artifact")
	check("sanitize nil", fresh.main.kind == "leaf" and fresh.main.page == "Artifact" and fresh.focus == fresh.main.id)
	check("sanitize garbage", L.sanitizeLayout("nope", known, single, "Artifact").main.page == "Artifact")
	check("sanitize no main", L.sanitizeLayout({ main = 5 }, known, single, "Artifact").main.page == "Artifact")

	-- A round trip keeps a good layout.
	local layout = L.newLayout("Logs")
	local state = L.splitLeaf(layout, 1, "row", "Modules/State", DESKTOP)
	state.data = { realm = "client" }
	layout.main.ratio = 0.62
	local win = L.popOut(layout, state.id, "Artifact", DESKTOP)
	win.rect = { x = 10, y = 20, w = 400, h = 300 }
	win.min = true
	local clean = L.sanitizeLayout(layout, known, single, "Artifact")
	check("round trip: main", pages(clean.main) == pages(layout.main))
	check("round trip: window", #clean.windows == 1 and clean.windows[1].id == win.id and clean.windows[1].min == true)
	check("round trip: rect", clean.windows[1].rect.w == 400 and clean.windows[1].rect.y == 20)
	check("round trip: data kept", clean.windows[1].root.data.realm == "client")
	check("round trip: next above every id", (function()
		local _, seen = ids(clean)
		for id in seen do
			if id >= clean.next then
				return false
			end
		end
		return true
	end)())
	check("round trip: focus not in minimised window", clean.focus == clean.main.id)

	-- Unknown pages, duplicate ids, a second singleton, a bad ratio and direction.
	local raw = {
		main = {
			kind = "split",
			id = 3,
			dir = "diagonal",
			ratio = 5,
			a = { kind = "leaf", id = 7, page = "Claude" },
			b = { kind = "leaf", id = 7, page = "Gone/Page" },
		},
		windows = {
			{ id = 3, root = { kind = "leaf", id = 9, page = "Claude" }, rect = { x = "a" } },
			{ id = 11, root = "bad" },
			"junk",
		},
		order = { 11, 3, 3, 0, "x", 99 },
		focus = 9,
	}
	local cleaned = L.sanitizeLayout(raw, known, single, "Artifact")
	local okIds = ids(cleaned)
	check("dirty: ids unique", okIds)
	check("dirty: dir row, ratio clamped", cleaned.main.dir == "row" and cleaned.main.ratio == L.MAX_RATIO)
	check("dirty: unknown page", cleaned.main.b.page == "Artifact")
	check("dirty: singleton kept once", cleaned.main.a.page == "Claude" and cleaned.windows[1].root.page == "Artifact")
	check("dirty: bad windows dropped", #cleaned.windows == 1)
	check("dirty: rect dropped", cleaned.windows[1].rect == nil)
	check("dirty: window id renumbered", cleaned.windows[1].id ~= cleaned.main.id)
	local orderOk = #cleaned.order == 2 and table.find(cleaned.order, 0) ~= nil and table.find(cleaned.order, cleaned.windows[1].id) ~= nil
	check("dirty: order", orderOk, table.concat(cleaned.order, ","))
	check("dirty: focus valid", L.findLeaf(cleaned, cleaned.focus) ~= nil)

	-- A deep tree is cut to the desktop limits.
	local function deep(n)
		if n == 0 then
			return { kind = "leaf", id = 100, page = "Logs" }
		end
		return { kind = "split", id = 100 + n, dir = "column", ratio = 0.5, a = { kind = "leaf", id = 200 + n, page = "Logs" }, b = deep(n - 1) }
	end
	local big = L.sanitizeLayout({ main = deep(20) }, known, single, "Artifact")
	check("deep: at most 6 panes", L.countLeaves(big.main) <= 6, L.countLeaves(big.main))
	check("deep: ids unique", (ids(big)))
	local many = { main = { kind = "leaf", id = 1, page = "Logs" }, windows = {} }
	for index = 1, 10 do
		table.insert(many.windows, { id = 50 + index, root = { kind = "leaf", id = 80 + index, page = "Logs" } })
	end
	check("too many windows cut to 6", #L.sanitizeLayout(many, known, single, "Artifact").windows == 6)
end

print(`test-layout: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
