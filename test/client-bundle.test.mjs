/**
 * Tests for the built browser half (`lib/client.js`).
 *
 * These run the artifact the shell actually loads, not the source template. That
 * matters here: the bundle is produced by a hand-written wrapper, so a wrapper bug
 * would otherwise only surface as a blank panel in the browser. Node can host it
 * because the bundle's entire platform surface is the `window.__ModuleLoader__`
 * registration plus one `require("react")`.
 *
 * Run: node --test dsh-price-peak/test/client-bundle.test.mjs
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "lib", "client.js");

/**
 * A DOM just large enough for the stylesheet effect: `createElement` returns a
 * plain record, and `head.appendChild` / `Element.remove` keep `styleNodes` in
 * step so insertion and cleanup are both observable.
 */
const styleNodes = [];

function installDom() {
	styleNodes.length = 0;
	const makeNode = (tag) => ({
		tagName: tag,
		dataset: {},
		textContent: "",
		remove() {
			const index = styleNodes.indexOf(this);
			if (index !== -1) styleNodes.splice(index, 1);
		}
	});
	globalThis.document = {
		head: {
			appendChild: (node) => styleNodes.push(node)
		},
		createElement: makeNode,
		addEventListener: () => {},
		removeEventListener: () => {},
		visibilityState: "visible"
	};
	return styleNodes;
}

/**
 * Load the bundle once, with a minimal browser-shaped environment.
 *
 * Node caches ES modules by URL, so the bundle's top-level registration runs
 * exactly once per process — which is faithful to the browser, where the loader
 * also registers a package a single time. The captured registration is therefore
 * shared, and each test builds its own factory instance from it.
 */
let cached;

async function loadBundle() {
	if (cached !== undefined) return cached;
	const registrations = [];
	globalThis.window = {
		__ModuleLoader__: {
			load: (registration) => registrations.push(registration)
		}
	};
	await import(pathToFileURL(bundlePath).href);
	assert.equal(registrations.length, 1, "the bundle must register exactly one module");
	const registration = registrations[0];
	const react = {
		createElement: (type, props, ...children) => ({ type, props, children }),
		useState: (value) => [value, () => {}],
		useEffect: () => {}
	};
	cached = {
		registration,
		react,
		// A fresh factory call per test, so no export object is shared between them.
		exports: registration.factory((specifier) => {
			if (specifier === "react") return react;
			throw new Error(`unexpected require(${specifier})`);
		})
	};
	return cached;
}

test("the bundle is syntactically valid and registers under the package name", async () => {
	const source = readFileSync(bundlePath, "utf8");
	assert.match(source, /^window\.__ModuleLoader__\.load\(\{/, "must open with the loader call");
	assert.match(source, /id: "dsh-price-peak"/, "must register under the package name");
	const { registration } = await loadBundle();
	assert.equal(registration.id, "dsh-price-peak");
	assert.equal(typeof registration.factory, "function");
});

test("the bundle embeds its stylesheet instead of reaching for a styles service", () => {
	// No shipped client bundle uses a `styles` service; they inline their CSS. The
	// assertion guards that choice, because depending on a service that is not
	// there would fail silently as an unstyled panel.
	const source = readFileSync(bundlePath, "utf8");
	assert.match(source, /factory: \(require\) => \{/, "the module body lives inside the factory");
	assert.match(source, /const css = "/, "the stylesheet is inlined as a literal");
	assert.equal(source.includes("ctx.get(\"styles\")"), false, "no styles service lookup");
	assert.equal(source.includes("styles.insert("), false, "and no styles builtin call");
});

test("the exported surface is the Cordis plugin shape plus testable helpers", async () => {
	const { exports } = await loadBundle();
	assert.equal(typeof exports.apply, "function", "apply is what the loader activates");
	assert.deepEqual(exports.inject, ["slots"], "slots is the only hard dependency");
	assert.equal(typeof exports.register, "function");
	assert.equal(typeof exports.toView, "function", "the view model stays unit-testable");
});

test("apply() mounts one dock entry and inserts a removable stylesheet", async () => {
	const { exports } = await loadBundle();
	installDom();
	const registered = [];
	const injected = [];
	const effects = [];
	const ctx = {
		// Record the disposer so the unload path can be exercised.
		effect: (fn, label) => {
			const disposer = fn();
			effects.push({ label, disposer: typeof disposer === "function" ? disposer : () => {} });
			return effects[effects.length - 1].disposer;
		},
		slots: {
			inject: (key, callback) => {
				injected.push(key);
				callback();
			},
			register: (options, component) => {
				registered.push({ options, component });
			}
		}
	};
	exports.apply(ctx);

	assert.deepEqual(injected, ["conversation.input.dock"], "must wait for the composer dock slot");
	assert.equal(registered.length, 1, "must register exactly one entry");
	assert.equal(registered[0].options.name, "conversation.input.dock");
	assert.equal(registered[0].options.id, "price-peak", "a private id, so shipped entries are untouched");
	assert.equal(registered[0].options.order, 30, "below the goal bar and the todo line");
	assert.equal(typeof registered[0].component, "function");

	assert.equal(effects.length, 1, "one effect owns the stylesheet");
	assert.match(effects[0].label, /stylesheet/);
	assert.equal(styleNodes.length, 1, "the stylesheet was appended once");
	assert.match(styleNodes[0].textContent, /\.dppBar\{/, "and carries the dock classes the component uses");
	assert.equal(styleNodes[0].dataset.dshPlugin, "dsh-price-peak");

	// Unload must not leave the sheet behind.
	effects[0].disposer();
	assert.equal(styleNodes.length, 0, "the stylesheet is removed with the plugin");
});

test("the component renders without throwing", async () => {
	const { exports } = await loadBundle();
	installDom();
	const registered = [];
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		slots: { inject: (_k, cb) => cb(), register: (options, component) => registered.push({ options, component }) }
	};
	exports.apply(ctx);
	// useState is stubbed to return its initial value, so this exercises the
	// collapsed render path end to end.
	const tree = registered[0].component({});
	assert.notEqual(tree, undefined);
	assert.equal(tree.type, "div");
	assert.equal(tree.props.className, "dppDock");
});

test("toView classifies a peak payload", async () => {
	const { exports } = await loadBundle();
	const view = exports.toView({
		status: {
			peak: true,
			multiplier: 2,
			dateKey: "2026-10-08",
			beijing: { clock: "10:30:00" },
			reason: "工作日高峰时段",
			windowLabel: "上午高峰",
			msUntilTransition: 5400000,
			windows: [],
			model: { name: "deepseek-flash" }
		},
		pricing: { models: [{ name: "deepseek-flash" }], peakWindows: [{ startHour: 9, endHour: 12 }], peakMultiplier: 2 },
		data: { live: true, stale: false, ageMs: 60000, refreshMinutes: 360 }
	});
	assert.equal(view.ok, true);
	assert.equal(view.tone, "peak");
	assert.equal(view.badge, "×2");
	assert.equal(view.clock, "10:30:00");
	assert.equal(view.nextPeak, false, "a peak reading counts down to off-peak");
	assert.equal(view.nextLabel, "距空闲");
	assert.equal(view.nextIn, "1小时30分");
	assert.equal(view.stale, false);
});

test("toView classifies an off-peak payload and counts down to the peak", async () => {
	const { exports } = await loadBundle();
	const view = exports.toView({
		status: {
			peak: false,
			multiplier: 1,
			dateKey: "2026-10-10",
			beijing: { clock: "12:00:00" },
			reason: "周六",
			windowLabel: "全天空闲",
			msUntilTransition: 169200000,
			model: { name: "deepseek-flash" }
		},
		pricing: { models: [], peakWindows: [] },
		data: { live: true, stale: false, ageMs: 1000 }
	});
	assert.equal(view.tone, "off");
	assert.equal(view.badge, "×1");
	assert.equal(view.nextPeak, true);
	assert.equal(view.nextLabel, "距高峰");
	assert.equal(view.nextIn, "1天23小时", "a long gap reads in days, not hours");
});

test("toView carries the out-of-coverage calendar year through", async () => {
	const { exports } = await loadBundle();
	const view = exports.toView({
		status: {
			peak: true, multiplier: 2, beijing: { clock: "10:00:00" }, reason: "r",
			msUntilTransition: 1000, outsideCalendarCoverage: true, calendarYear: 2026
		},
		pricing: { models: [], peakWindows: [] },
		data: { live: true, stale: true }
	});
	assert.equal(view.outsideCalendarCoverage, true);
	assert.equal(view.calendarYear, 2026, "the panel names the year the table covers");
});

test("toView carries per-field provenance through to the panel", async () => {
	const { exports } = await loadBundle();
	const view = exports.toView({
		status: { peak: true, multiplier: 3, beijing: { clock: "10:00:00" }, reason: "r", msUntilTransition: 1000 },
		// The dangerous mixture: the schedule is live, the prices are not.
		pricing: { models: [], peakWindows: [], sources: { models: "snapshot", windows: "live", multiplier: "live" } },
		data: { live: true, stale: false, ageMs: 0 }
	});
	assert.deepEqual(view.sources, { models: "snapshot", windows: "live", multiplier: "live" });
});

test("a payload without provenance still renders", async () => {
	const { exports } = await loadBundle();
	const view = exports.toView({
		status: { peak: false, multiplier: 1, beijing: { clock: "10:00:00" }, reason: "r", msUntilTransition: 1000 },
		pricing: { models: [] },
		data: { live: false, stale: true }
	});
	assert.equal(view.sources, undefined, "absent provenance must not become a rendered object");
});

test("the price formatter is digit-exact and independent of the viewer's locale", async () => {
	const { exports } = await loadBundle();
	assert.equal(exports.numberText(0.02), "0.02");
	assert.equal(exports.numberText(13.5), "13.5", "a half-rate does not round");
	assert.equal(exports.numberText(27), "27");
	assert.equal(exports.numberText(0), "0");
	assert.equal(exports.numberText(Number.NaN), "—");
	assert.equal(exports.numberText(undefined), "—");
	assert.equal(exports.numberText("4"), "—", "a string is not a price");

	// The reason this is not `toLocaleString()`: its defaults round to three
	// fraction digits (0.0005 -> "0.001", 0.00005 -> "0") and vary by locale. A
	// price rendered as 0 is a wrong price, and a locale-dependent formatter makes
	// this suite environment-dependent too.
	assert.notEqual(exports.numberText(0.00005), (0.00005).toLocaleString(),
		"the formatter must not silently round to zero the way toLocaleString can");
	assert.equal(exports.numberText(0.00005), "0.00005", "however small, the digits survive");
	assert.equal(exports.numberText(4032), "4032", "and no grouping separators are inserted");
});

test("a failed poll keeps the last reading instead of blanking the panel", async () => {
	const { exports } = await loadBundle();
	const good = exports.toView({
		status: { peak: true, multiplier: 2, beijing: { clock: "10:00:00" }, reason: "r", msUntilTransition: 1000 },
		pricing: {},
		data: { live: true, stale: false }
	});
	const failed = exports.toView(undefined, "HTTP 500", good);
	assert.equal(failed.ok, true, "the previous reading survives");
	assert.equal(failed.badge, "×2");
	assert.equal(failed.clock, "10:00:00");
	assert.equal(failed.error, "HTTP 500");
	assert.equal(failed.stale, true, "and is flagged as possibly out of date");
});

test("a failed first poll reports an unknown state rather than throwing", async () => {
	const { exports } = await loadBundle();
	const view = exports.toView(undefined, "offline");
	assert.equal(view.ok, false);
	assert.equal(view.badge, "×?");
	assert.equal(view.tone, "unknown");
	assert.equal(view.error, "offline");
});

test("a malformed payload is treated as no payload", async () => {
	const { exports } = await loadBundle();
	for (const payload of [null, 42, "text", {}, { data: {} }]) {
		const view = exports.toView(payload, undefined, undefined);
		assert.equal(view.ok, false, `${JSON.stringify(payload)} must not read as usable`);
	}
});
