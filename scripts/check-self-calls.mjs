// Flags compiled Luau functions whose first two lines call the function itself (like `ownerOf` calling `ownerOf`,
// the framework 0.3.2 "stack overflow" in Manage). Usage: node scripts/check-self-calls.mjs out (after bun run build).
// Known false positives: a table field calling the global of the same name, a later-reassigned local, a parameter.
import fs from "node:fs";
import path from "node:path";
let hits = 0;
function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(file);
		else if (file.endsWith(".luau")) {
			const lines = fs.readFileSync(file, "utf8").split("\n");
			for (let i = 0; i < lines.length; i++) {
				const m = lines[i].match(/^\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*function\s*\(/);
				if (!m) continue;
				for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
					const line = lines[j].trim();
					if (line.startsWith("--")) continue;
					const at = line.indexOf(m[1] + "(");
					const before = at > 0 ? line[at - 1] : " ";
					if (at >= 0 && !/[\w.:]/.test(before)) {
						console.log(`${file}:${j + 1}: ${line}`);
						hits++;
					}
				}
			}
		}
	}
}
walk(process.argv[2]);
console.log(`self-calls in a function's first lines: ${hits}`);
