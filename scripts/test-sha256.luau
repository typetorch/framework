-- Offline test of the compiled SHA-256 / HMAC / pairing-code fingerprint (out/devtools/sha256.luau) under Lune.
-- The expected values come from Node's crypto; the fingerprint vector is also checked by dev-server/test/security.test.ts.
-- Run after `bun run build` (Lune is pinned in kernel/rokit.toml):
--   cd ../kernel && lune run ../framework/scripts/test-sha256.luau ../framework/out/devtools/sha256.luau
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")

local path = process.args[1] or "out/devtools/sha256.luau"
local sha = luau.load(fs.readFile(path), { debugName = "sha256" })()

local failures = 0
local function check(name, got, want)
	if got ~= want then
		failures += 1
		print(`FAIL {name}: got {got}, want {want}`)
	end
end

check("empty", sha.sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
check("abc", sha.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
check("1000 x", sha.sha256(string.rep("x", 1000)), "44f8354494a5ba03ba1792a8d3e9c534c47a9181980fde7a3f44b06ef2ae7c7f")
-- Padding boundaries: 50..70 bytes (55, 56 and 64 are the edge cases).
local prefixes = {}
for n = 50, 70 do
	table.insert(prefixes, sha.sha256(string.rep("a", n)):sub(1, 8))
end
check(
	"a x 50..70",
	table.concat(prefixes, " "),
	"160b4e43 bfc5fe0e 6c1b3dc7 abe346a7 a3f01b69 9f4390f8 b35439a4 f13b2d72 d5c039b7 111bb261 11ee3912 35d5fc17 f506898c 7d3e74a0 ffe054fe 635361c4 ac137fce 6116c09f 574c61e5 ef5ed46e 6bd5e503"
)
check("hmac", sha.toHex(sha.hmacSha256Raw("key", "The quick brown fox jumps over the lazy dog")), "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8")
check("hmac long key", sha.toHex(sha.hmacSha256Raw(string.rep("k", 100), "msg")), "bd56a1782c2830e8abc6ed866a57a1230661e650b84c62f7ee3accc5fa5af491")
check("fingerprint", sha.codeFingerprint("ABCDEFGHJKLMNPQRSTUV", "abc-def.trycloudflare.com"), "T4SP")
check("fingerprint lowercases the host", sha.codeFingerprint("ABCDEFGHJKLMNPQRSTUV", "ABC-DEF.trycloudflare.com"), "T4SP")

if failures > 0 then
	print(`{failures} failure(s)`)
	process.exit(1)
end
print("sha256: all checks pass")
