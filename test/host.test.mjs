/**
 * Tests for the host half's data path.
 *
 * `lib/index.js` cannot be imported directly from here: it imports
 * `@deepseek-ai/schemastery` for its Config schema, and ESM resolves bare
 * specifiers from the importing file's directory, which has no `node_modules`.
 * That is a property of the packaging, not a defect — see `install.md`.
 *
 * What is covered here is the part that can go silently wrong: the fetch and
 * parse path, and the wire document the browser half consumes. `node --check`
 * covers the rest of the host file's syntax, and the end-to-end path is verified
 * after installation.
 *
 * Run: node --test dsh-price-peak/test/host.test.mjs
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePricing, pricingStatus } from "../lib/core.js";
import { PRICING_URLS, parseAndValidate } from "../lib/parse.js";
import { SNAPSHOT } from "../lib/snapshot.js";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "lib", "index.js");
const fixture = readFileSync(join(here, "fixtures", "pricing-zh-cn.html"), "utf8");
const nodeBin = process.execPath;

test("the host half is syntactically valid", () => {
	const result = spawnSync(nodeBin, ["--check", hostPath], { encoding: "utf8" });
	assert.equal(result.status, 0, `node --check failed:\n${result.stderr}`);
});

test("the host half declares the services its route needs", () => {
	const source = readFileSync(hostPath, "utf8");
	// Without webServer there is no route and the panel would poll a 404 forever;
	// without timer the refresh loop would have to fall back to globals.
	assert.match(source, /const inject = \["timer", "webServer"\]/);
	assert.match(source, /const name = "price-peak"/);
	assert.match(source, /const STATE_PATH = "\/price-peak\/state"/);
	assert.match(source, /ctx\.webServer\.register\(\{/);
});

test("the snapshot parses and resolves without a live document", () => {
	const resolved = resolvePricing(undefined, SNAPSHOT);
	assert.equal(resolved.models.length, 2, "both shipped models survive");
	assert.equal(resolved.peakMultiplier, 2, "the default multiplier applies");
	assert.deepEqual(resolved.peakWindows, [
		{ startHour: 9, endHour: 12, label: "上午高峰" },
		{ startHour: 14, endHour: 18, label: "下午高峰" }
	]);
	// End to end: a snapshot-only install still classifies correctly.
	const status = pricingStatus(Date.UTC(2026, 0, 5, 2, 0), resolved); // Mon 10:00 Beijing
	assert.equal(status.peak, true);
	assert.equal(status.multiplier, 2);
	assert.equal(status.model.name, "deepseek-flash");
});

test("a parsed live page layers over the snapshot field by field", () => {
	const live = parseAndValidate(fixture, { sourceUrl: PRICING_URLS[0], fetchedAt: 1791000000000 });
	assert.notEqual(live, undefined);
	const resolved = resolvePricing(live, SNAPSHOT);
	assert.equal(resolved.fetchedAt, 1791000000000, "the freshness stamp comes from the live document");
	assert.equal(resolved.sourceUrl, PRICING_URLS[0]);
	assert.equal(resolved.peakMultiplier, 2, "and from the page's own note");
	assert.equal(resolved.models.length, 2);
});

test("a live-only document still produces a usable state", () => {
	// The bundled snapshot is a fallback, not a prerequisite: if a future release
	// drops it, a successful fetch must be enough on its own.
	const live = parseAndValidate(fixture, { sourceUrl: PRICING_URLS[0], fetchedAt: Date.now() });
	const resolved = resolvePricing(live, undefined);
	assert.equal(resolved.models.length, 2);
	assert.equal(resolved.peakMultiplier, 2);
	const status = pricingStatus(Date.UTC(2026, 0, 5, 6, 0), resolved); // Mon 14:00 Beijing
	assert.equal(status.peak, true);
	assert.deepEqual(status.model.rates, { cacheHit: 0.04, cacheMiss: 2, output: 8 });
});

test("the wire document carries everything the panel renders", () => {
	// Rebuild what the route serializes, then assert the keys the browser half
	// reads are present. This is the contract between the two halves, and the one
	// place a rename would break silently.
	const pricing = resolvePricing(
		parseAndValidate(fixture, { sourceUrl: PRICING_URLS[0], fetchedAt: Date.now() }),
		SNAPSHOT
	);
	const status = pricingStatus(Date.now(), pricing);
	const wire = {
		generatedAt: Date.now(),
		status,
		pricing: {
			models: pricing.models,
			peakWindows: pricing.peakWindows,
			peakMultiplier: pricing.peakMultiplier,
			ruleText: pricing.ruleText,
			sourceUrl: pricing.sourceUrl
		},
		data: { live: true, fetchedAt: pricing.fetchedAt, ageMs: 0, stale: false }
	};

	assert.equal(typeof wire.status.peak, "boolean");
	assert.equal(typeof wire.status.multiplier, "number");
	assert.equal(typeof wire.status.reason, "string");
	assert.match(wire.status.beijing.clock, /^\d{2}:\d{2}:\d{2}$/, "the panel prints this verbatim");
	assert.equal(typeof wire.status.msUntilTransition, "number");
	assert.match(wire.status.dateKey, /^\d{4}-\d{2}-\d{2}$/);
	assert.equal(Array.isArray(wire.status.windows), true);
	assert.equal(wire.pricing.models.length, 2);
	assert.equal(Array.isArray(wire.pricing.peakWindows), true);
	assert.equal(typeof wire.pricing.peakMultiplier, "number");
	assert.equal(typeof wire.pricing.ruleText, "string");
	assert.equal(typeof wire.data.stale, "boolean");

	// JSON round-trip, because that is how it actually travels.
	const roundTripped = JSON.parse(JSON.stringify(wire));
	assert.deepEqual(roundTripped.status.beijing, status.beijing);
});

test("the wire document stays small enough to poll once a second", () => {
	// The panel polls this route every second; a bloated payload would be real
	// traffic on every open session.
	const pricing = resolvePricing(undefined, SNAPSHOT);
	const wire = { generatedAt: Date.now(), status: pricingStatus(Date.now(), pricing), pricing, data: {} };
	const bytes = Buffer.byteLength(JSON.stringify(wire));
	assert.ok(bytes < 4096, `status document is ${bytes} bytes; keep it under 4 KiB`);
});

test("forced refreshes are rate-limited in the route handler", () => {
	const source = readFileSync(hostPath, "utf8");
	assert.match(source, /FORCED_REFRESH_FLOOR_MS = 60 \* 1000/, "a reload storm must not hit the docs site");
	assert.match(source, /searchParams\.get\("refresh"\) === "1"/, "the manual override is explicit");
});

test("a failed refresh keeps the previous document and records why", () => {
	const source = readFileSync(hostPath, "utf8");
	// The two behaviours that make failure quiet rather than fatal.
	assert.match(source, /lastError = result\.error/, "the reason is retained for the panel");
	assert.match(source, /if \(result\.document === undefined\) \{/, "and the previous document is left in place");
});

test("a configured sourceUrl is a strict override, never a silent fallback", () => {
	// This was a real ambiguity caught during installation: with `sourceUrl` set to
	// an unreachable host the plugin quietly answered from the official page instead
	// and reported `live: true`, which contradicted the documented meaning of the
	// option. A user pointing at a mirror or a pinned copy must see that source fail.
	const source = readFileSync(hostPath, "utf8");
	assert.match(
		source,
		/return typeof config\.sourceUrl === "string" && config\.sourceUrl\.length > 0\s*\n\s*\? \[config\.sourceUrl\]\s*\n\s*: PRICING_URLS;/,
		"an override must replace the URL list rather than head it"
	);
	assert.match(source, /usedFallback = result\.fellBack === true/, "and a fallback must be recorded");
	assert.match(source, /usedFallbackSource: usedFallback/, "and surfaced on the wire");
});

test("fetchPricing tries only the configured URL when one is set", async () => {
	// Runs the real module from the profile, because that is the only place its
	// bare specifiers resolve. Skipped when no profile is installed.
	const profile = join(homedir(), ".dsh", "profiles", "desktop");
	const entry = join(profile, "plugins", "dsh-price-peak", "index.js");
	if (!existsSync(entry)) return; // not installed on this machine

	const probe = `
		const { fetchPricing } = await import(${JSON.stringify(entry)});
		const out = await fetchPricing(
			{ sourceUrl: "https://pricing.invalid.example/nope", timeoutMs: 4000 },
			undefined
		);
		process.stdout.write(JSON.stringify({
			hasDocument: out.document !== undefined,
			error: out.error ?? null,
			url: out.url ?? null
		}));
	`;
	const result = spawnSync(nodeBin, ["--input-type=module", "-e", probe], {
		cwd: profile,
		encoding: "utf8",
		timeout: 30000
	});
	assert.equal(result.status, 0, `probe failed: ${result.stderr}`);
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.hasDocument, false, "an unreachable override must not yield a document");
	assert.match(String(parsed.error), /pricing\.invalid\.example/, "and the error must name the override");
	assert.equal(parsed.url, null, "and no other source may have answered");
});
