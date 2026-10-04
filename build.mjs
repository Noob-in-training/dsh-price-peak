/**
 * Wrap the browser half into the bundle format the web client actually loads.
 *
 * dsh serves *built* client bundles, so `lib/client.js` must exist before launch.
 * This package deliberately has no bundler in its toolchain: the browser half is
 * plain JavaScript whose only runtime dependency is `react`, which the shell seeds
 * into `PLATFORM_MODULES`. The build step is therefore a wrapper rather than a
 * compiler, which also keeps the artifact reviewable by eye.
 *
 * The output shape is not invented here — it is what `@deepseek-ai/dsh-client-ui-goal`
 * ships in its own `lib/client.js`, and this file follows it:
 *
 *     window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => {...} });
 *
 * The factory is lazy: executing the bundle only registers it; the module body,
 * stylesheet insertion included, runs at materialization. Nothing happens until
 * the shell first needs the plugin.
 *
 * Usage: node build.mjs [--check]
 *   --check  exit non-zero if lib/client.js is missing or out of date
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const template = readFileSync(join(here, "src", "client.template.js"), "utf8");
const styles = readFileSync(join(here, "src", "client-styles.js"), "utf8");

/** Pull the CSS template literal out of the styles module without executing it. */
function extractCss(source) {
	const match = /const css = `([\s\S]*?)`;/.exec(source);
	if (match === null) throw new Error("build: no `const css = `…`;` found in src/client-styles.js");
	return match[1];
}

/**
 * Strip the template's ES-module surface and prepend the stylesheet.
 *
 * The template stays an ES module so it lints and runs directly under Node; the
 * factory body is plain declarations, so only the export statements have to go.
 * The CSS is inlined as a JSON string literal rather than kept in a second file,
 * which is what makes the bundle self-contained — no `styles` service to reach for.
 */
function toFactoryBody() {
	const stripped = template.replace(/^export \{[^}]*\};\s*$/gm, "").trim();
	if (/(^|\n)export /.test(stripped)) {
		throw new Error("build: src/client.template.js still contains an `export` statement");
	}
	if (!/^function register\(/m.test(stripped)) {
		throw new Error("build: src/client.template.js no longer defines `function register(`");
	}
	return `const css = ${JSON.stringify(extractCss(styles))};\n\n${stripped}`;
}

/** Indent a block by two tabs so the generated file reads as generated. */
const indent = (text) =>
	text.split("\n").map((line) => (line.length > 0 ? `\t\t${line}` : line)).join("\n");

function buildBundle() {
	const IND = "\t\t";
	const header = [
		"window.__ModuleLoader__.load({",
		`\tid: ${JSON.stringify(manifest.name)},`,
		"\tfactory: (require) => {",
		"\t\tvar module = { exports: {} };",
		"\t\tvar exports = module.exports;",
		"\t\tvar react = require(\"react\");"
	].join("\n");

	// The exports mirror a shipped client bundle: `apply` and `inject` are the
	// Cordis plugin surface the loader activates, and `toView` stays exported so
	// the view model can be tested against the built artifact rather than the source.
	const footer = [
		"",
		`${IND}exports.apply = apply;`,
		`${IND}exports.inject = inject;`,
		`${IND}exports.register = register;`,
		`${IND}exports.toView = toView;`,
		`${IND}return module.exports;`,
		"\t}",
		"});",
		""
	].join("\n");

	return `${header}\n${indent(toFactoryBody())}\n${footer}`;
}

const target = join(here, "lib", "client.js");
const generated = buildBundle();

if (process.argv.includes("--check")) {
	if (!existsSync(target)) {
		console.error(`build --check: ${target} is missing; run \`node build.mjs\``);
		process.exit(1);
	}
	if (readFileSync(target, "utf8") !== generated) {
		console.error("build --check: lib/client.js differs from src/; run `node build.mjs`");
		process.exit(1);
	}
	console.log("build --check: lib/client.js is up to date");
	process.exit(0);
}

mkdirSync(join(here, "lib"), { recursive: true });
writeFileSync(target, generated, "utf8");
console.log(`build: wrote ${target} (${generated.length} bytes)`);
