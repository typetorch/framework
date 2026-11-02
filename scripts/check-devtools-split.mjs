// What a non-dev client can reach never includes devtools, and a dev's copy holds everything its client imports.
// Usage: node scripts/check-devtools-split.mjs out (after bun run build). Reads the compiled TS.import calls of out/.
import fs from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] ?? "out");
const loader = fs.readFileSync(path.join(out, "runtime", "devtools-loader.luau"), "utf8");
const listed = loader.match(/SERVER_ONLY = \{([^}]*)\}/);
const serverOnly = new Set([...(listed?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]));

function moduleFile(dir, parts) {
	const target = path.join(dir, ...parts);
	for (const file of [`${target}.luau`, path.join(target, "init.luau")]) if (fs.existsSync(file)) return file;
}

/** A compiled file's imports inside out/. `dynamic` keeps those in TS.Promise.new (dynamic imports). */
function imports(file) {
	const found = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const m = line.match(/TS\.import\(script, (script(?:\.Parent)*)((?:, "[^"]+")*)\)/);
		if (!m) continue;
		const ups = m[1].split(".Parent").length - 1;
		let dir = path.basename(file) === "init.luau" ? path.dirname(file) : file.slice(0, -".luau".length);
		for (let i = 0; i < ups; i++) dir = path.dirname(dir);
		const target = moduleFile(dir, [...m[2].matchAll(/"([^"]+)"/g)].map((p) => p[1]));
		if (target) found.push({ target, dynamic: line.includes("resolve(") });
	}
	return found;
}

function closure(start, followDynamic) {
	const seen = new Set();
	const stack = [start];
	while (stack.length) {
		const file = stack.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		for (const { target, dynamic } of imports(file)) if (followDynamic || !dynamic) stack.push(target);
	}
	return seen;
}

const devtools = path.join(out, "devtools") + path.sep;
let failed = false;
const fail = (text) => {
	failed = true;
	console.error(text);
};

// Every static importer outside devtools would hang on a non-dev client (TS.import waits for the missing child).
function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".luau") ? [path.join(dir, e.name)] : []));
}
const all = walk(out);
for (const file of all.filter((f) => !f.startsWith(devtools))) {
	for (const { target, dynamic } of imports(file)) {
		if (target.startsWith(devtools) && !dynamic) fail(`${path.relative(out, file)} statically imports ${path.relative(out, target)}`);
	}
}

// A dev's client must find everything it needs in the copy.
const client = closure(path.join(out, "devtools", "client.luau"), false);
const inDevtools = (file) => path.relative(devtools, file).split(path.sep)[0].replace(/\.luau$/, "");
for (const file of client) if (file.startsWith(devtools) && serverOnly.has(inDevtools(file))) fail(`the dev client needs ${path.relative(out, file)}, which SERVER_ONLY removes`);

const size = (files) => files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
const inFolder = all.filter((f) => f.startsWith(devtools));
const removed = inFolder.filter((f) => serverOnly.has(inDevtools(f)));
const stillUnused = inFolder.filter((f) => !client.has(f) && !serverOnly.has(inDevtools(f)) && !f.endsWith("on-demand.luau"));
console.log(`devtools: ${inFolder.length} modules, ${size(inFolder)} bytes; off every client: ${removed.length} modules, ${size(removed)} bytes`);
console.log(`dev client closure: ${[...client].filter((f) => f.startsWith(devtools)).length} devtools modules`);
if (stillUnused.length) console.log(`in a dev's copy, not reached by the client: ${stillUnused.map((f) => path.relative(devtools, f)).join(", ")}`);
if (failed) process.exit(1);
console.log("ok");
