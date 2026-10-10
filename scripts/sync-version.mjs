/**
 * Keep the version the host half announces to the docs site in step with
 * `package.json`.
 *
 * `lib/index.js` names the package version a second time, in `USER_AGENT`, and
 * nothing regenerates that file: `build.mjs` only writes `lib/client.js`. Left
 * alone, a `npm version patch` would ship a plugin that tells the pricing page
 * it is the previous release — which is what happened to 0.1.2.
 *
 * `npm version` runs this as its `version` lifecycle script, after the manifest
 * is bumped and before the release commit is made, so the commit always carries
 * both versions in step. Running it by hand is harmless and idempotent.
 *
 * `test/host.test.mjs` still asserts the two agree, so a future refactor that
 * moves or renames the constant fails loudly here and there.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const target = join(root, "lib", "index.js");
const source = readFileSync(target, "utf8");
const expected = `const USER_AGENT = "${name}/${version}";`;
const rewritten = source.replace(/const USER_AGENT = "[^"]*";/, expected);

if (rewritten === source && !source.includes(expected)) {
	// The constant moved or was renamed; fail the release rather than shipping a
	// version nobody rewrote.
	console.error(`sync-version: no USER_AGENT constant found in ${target}`);
	process.exit(1);
}

if (rewritten !== source) writeFileSync(target, rewritten);
console.log(`sync-version: USER_AGENT = ${name}/${version}${rewritten === source ? " (already)" : ""}`);
