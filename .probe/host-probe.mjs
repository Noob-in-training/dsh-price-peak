/**
 * Exercise lib/index.js for real, from a location where its bare specifier resolves.
 *
 * `@deepseek-ai/schemastery` is a peer of the app rather than a dependency of this
 * plugin, and ESM resolves bare specifiers from the importing file's directory
 * upward — so `lib/index.js` cannot be imported from the repository alone. The
 * repository-root `node_modules` symlink (created by `npm run probe:setup`, and
 * git-ignored) supplies it, which is what allows the host half's real behaviour to
 * be tested instead of regexing over its source text.
 *
 * Request on argv[2], JSON response on stdout:
 *   { sourceUrl?, timeoutMs?, liveUpdate?, refreshMinutes?, waitMs?, queries? }
 *     -> { states: [{ status, body }] }
 */
import { apply, STATE_PATH } from "../lib/index.js";

const request = JSON.parse(process.argv[2] ?? "{}");
const routes = [];

apply({
	effect: (fn) => { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
	webServer: { register: (route) => { routes.push(route); return () => {}; } },
	timer: { interval: () => () => {} },
	provide: () => () => {}
}, {
	liveUpdate: request.liveUpdate !== false,
	refreshMinutes: request.refreshMinutes ?? 360,
	timeoutMs: request.timeoutMs ?? 15000,
	sourceUrl: request.sourceUrl ?? "",
	holidays: request.holidays ?? [],
	customHolidayRuns: request.customHolidayRuns ?? [],
	treatAdjustedWorkdaysAsPeak: request.treatAdjustedWorkdaysAsPeak !== false,
	peakMultiplier: request.peakMultiplier ?? 0,
	model: request.model ?? ""
});

await new Promise((resolve) => setTimeout(resolve, request.waitMs ?? 0));

// Echo the config actually handed to apply, so a probe that silently ignores its
// own arguments cannot be mistaken for a passing test.
const appliedConfig = { sourceUrl: request.sourceUrl ?? "" };

const route = routes.find((r) => r.path === STATE_PATH);
if (route === undefined) {
	process.stdout.write(JSON.stringify({ error: "state route was not registered" }));
	process.exit(0);
}

const states = [];
for (const query of request.queries ?? [""]) {
	let status = 0;
	let body = "";
	await route.handler({ url: STATE_PATH + query, method: "GET" }, {
		writeHead: (code) => { status = code; },
		end: (payload) => { body = payload; }
	});
	states.push({ status, body: JSON.parse(body) });
}
process.stdout.write(JSON.stringify({ appliedConfig, states }));
