/**
 * dsh-price-peak — host half.
 *
 * Owns everything that needs the network or the machine's clock, and serves the
 * result to the browser half over a same-origin route:
 *
 *   1. **Refresh.** Fetches the official DeepSeek pricing page with a conditional
 *      request (ETag / Last-Modified), parses it (`parse.js`), and layers what it
 *      recovers over the bundled snapshot and the plugin config (`core.js`).
 *      The page carries no CORS header, so the browser cannot do this itself.
 *   2. **Classify.** Computes the peak/off-peak status in Beijing time and puts
 *      it on the wire, so the browser never duplicates the schedule logic.
 *   3. **Serve.** `GET /price-peak/state` returns that status as JSON; add
 *      `?refresh=1` to force a fetch, rate-limited so a reload loop cannot hammer
 *      the docs site.
 *
 * Failure is designed to be quiet: a fetch or parse failure keeps the previous
 * document, records why, and reports `stale` — the panel shows old numbers with
 * a warning rather than disappearing.
 *
 * A host-owned HTTP route is used instead of the package-private `host.call`
 * channel because both halves run against the same origin and a plain fetch needs
 * no extra contract to stay working.
 */
import z from "@deepseek-ai/schemastery";

import {
	buildHolidayCalendar,
	formatDuration,
	pricingStatus,
	resolvePricing
} from "./core.js";
import { PRICING_URL, parseAndValidate } from "./parse.js";
import { SNAPSHOT } from "./snapshot.js";

/** Loader diagnostic name. */
const name = "price-peak";

/** Route the browser half reads; kept in one place so both halves agree. */
const STATE_PATH = "/price-peak/state";

/** Services the route needs. A web-less composition simply gets no panel data. */
const inject = ["timer", "webServer"];

/** Default refresh cadence: six hours. Prices move on the scale of weeks. */
const DEFAULT_REFRESH_MINUTES = 360;

/** Minimum gap between forced refreshes, so a reload storm is harmless. */
const FORCED_REFRESH_FLOOR_MS = 60 * 1000;

/** Beyond this multiple of the refresh interval, data is called stale. */
const STALE_INTERVAL_MULTIPLE = 2.5;

const Config = z.object({
	/** Set false to stop fetching and run purely from the bundled snapshot. */
	liveUpdate: z.boolean().default(true),
	/** Minutes between refreshes. */
	refreshMinutes: z.number().step(1).min(5).max(10080).default(DEFAULT_REFRESH_MINUTES),
	/** Milliseconds allowed for one page fetch. */
	timeoutMs: z.number().step(500).min(1000).max(60000).default(15000),
	/** Override the pricing page URL (mirrors, tests, a pinned copy). */
	sourceUrl: z.string().default(""),
	/**
	 * Extra holiday dates as `YYYY-MM-DD`, replacing the shipped runs. A real
	 * calendar date is required: an impossible one (`2026-02-30`) or a typo would
	 * otherwise be accepted and silently match nothing.
	 */
	holidays: z.array(z.string().pattern(/^\d{4}-\d{1,2}-\d{1,2}$/)).default([]),
	/**
	 * Extra holiday runs, replacing the shipped runs. `year` is optional and
	 * defaults to the shipped calendar's year; `month` is bounded because 13
	 * produces a key no date can ever equal.
	 */
	customHolidayRuns: z.array(z.object({
		year: z.number().step(1).min(1970).max(2100),
		month: z.number().step(1).min(1).max(12),
		from: z.number().step(1).min(1).max(31),
		to: z.number().step(1).min(1).max(31),
		name: z.string().default("假期")
	})).default([]),
	/**
	 * Whether a 调休上班日 keeps its peak windows. True follows the official rule
	 * ("excluding statutory holidays" only); false treats it as a normal weekend.
	 */
	treatAdjustedWorkdaysAsPeak: z.boolean().default(true),
	/** Override the peak multiplier; 0 means "use whatever the page says". */
	peakMultiplier: z.number().min(0).default(0),
	/** Model to price in the detail view; empty means the first row. */
	model: z.string().default("")
});

/** Read one response header as a string, whatever the fetch implementation returns. */
const headerOf = (response, key) => response.headers?.get?.(key) ?? undefined;

/** Clamp a number into a range, ignoring a value that is not finite. */
const clamp = (value, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min);

/**
 * Resolve the effective URL list.
 *
 * A configured `sourceUrl` is a strict override: it is the only URL tried, so a
 * user pointing at a mirror or a pinned copy gets exactly that source and sees it
 * fail. Otherwise there is exactly one source, the Chinese pricing page.
 *
 * The English sibling used to be listed as a fallback. It never worked — every
 * extractor keys on Chinese labels (`模型`, `价格`, `空闲时段`) — so it was dead
 * weight that the documentation described as a working fallback, and the English
 * page quotes USD while the panel prints 元. Parsing it properly is a real piece
 * of work (label map plus a currency field); until then it is not claimed.
 */
function urlsOf(config) {
	return typeof config.sourceUrl === "string" && config.sourceUrl.length > 0
		? [config.sourceUrl]
		: [PRICING_URL];
}

/**
 * Fetch and parse the pricing page.
 *
 * @returns `{ document, notModified, etag, lastModified, url }` on success, or
 *          `{ document: undefined, error }` — never throws, because a refresh
 *          failure must not take the plugin down.
 */
async function fetchPricing(config, previous) {
	const headers = { "accept": "text/html", "user-agent": "dsh-price-peak/0.1.0" };
	// Conditional request: an unchanged page costs one 304 instead of a reparse.
	if (previous?.etag !== undefined) headers["if-none-match"] = previous.etag;
	if (previous?.lastModified !== undefined) headers["if-modified-since"] = previous.lastModified;

	const urls = urlsOf(config);
	const preferred = urls[0];
	let lastError;
	for (const url of urls) {
		let response;
		try {
			response = await fetch(url, {
				method: "GET",
				redirect: "follow",
				headers,
				signal: AbortSignal.timeout(config.timeoutMs)
			});
		} catch (error) {
			lastError = `fetch ${url} failed: ${error}`;
			continue;
		}
		if (response.status === 304) {
			return { document: undefined, notModified: true, url, fellBack: url !== preferred };
		}
		if (!response.ok) {
			lastError = `${url} answered HTTP ${response.status}`;
			continue;
		}
		let html;
		try {
			html = await response.text();
		} catch (error) {
			lastError = `reading ${url} failed: ${error}`;
			continue;
		}
		const document = parseAndValidate(html, { sourceUrl: url, fetchedAt: Date.now() });
		if (document === undefined) {
			lastError = `no usable pricing table found at ${url}`;
			continue;
		}
		return {
			document,
			notModified: false,
			etag: headerOf(response, "etag"),
			lastModified: headerOf(response, "last-modified"),
			url,
			fellBack: url !== preferred
		};
	}
	return { document: undefined, error: lastError ?? "no pricing source configured" };
}

/**
 * @param ctx - host root context.
 * @param config - this plugin's row config, validated by `Config`.
 */
function apply(ctx, config) {
	const refreshMs = clamp(config.refreshMinutes, 5, 10080) * 60 * 1000;
	const timeoutMs = clamp(config.timeoutMs, 1000, 60000);

	/** Newest parsed page, kept only in memory: one fetch per App run is fine. */
	let live;
	/** Cache validators for the conditional request. */
	let validators;
	/** True when the answered source is not the preferred one. */
	let usedFallback = false;
	/** Why the last refresh failed, surfaced so the panel can explain itself. */
	let lastError;
	let lastAttemptAt;

	const settings = {
		liveUpdate: config.liveUpdate !== false,
		refreshMinutes: clamp(config.refreshMinutes, 5, 10080),
		timeoutMs,
		// Carried through to the fetch: `sourceUrl` is the ONLY thing that decides
		// which URL is requested, and omitting it here made the documented strict
		// override a no-op — `urlsOf` saw `undefined` and quietly used the official
		// page instead. The unit test for the override passed because it called
		// `fetchPricing` with a hand-built config, never through `apply`.
		sourceUrl: typeof config.sourceUrl === "string" ? config.sourceUrl : "",
		liveUpdateEnabled: config.liveUpdate !== false,
		holidays: Array.isArray(config.holidays) ? config.holidays : [],
		customHolidayRuns: Array.isArray(config.customHolidayRuns) ? config.customHolidayRuns : [],
		treatAdjustedWorkdaysAsPeak: config.treatAdjustedWorkdaysAsPeak !== false,
		peakMultiplier: config.peakMultiplier > 0 ? config.peakMultiplier : undefined,
		model: typeof config.model === "string" ? config.model : ""
	};

	const effective = () => resolvePricing(live, SNAPSHOT, {
		peakMultiplier: settings.peakMultiplier
	});

	/** One refresh attempt, serialized so overlapping ticks cannot stack up. */
	let refreshing;
	const refresh = (reason) => {
		if (!settings.liveUpdateEnabled) return Promise.resolve({ skipped: "live update disabled" });
		if (refreshing !== undefined) return refreshing;
		refreshing = (async () => {
			lastAttemptAt = Date.now();
			try {
				const result = await fetchPricing({ ...settings }, validators); // settings carries every fetch input
				// Whether the answered source is the preferred one. With no configured
				// override this is true when the English page answered because the
				// Chinese one was unusable — worth surfacing, not worth hiding.
				usedFallback = result.fellBack === true;
				if (result.notModified) {
					lastError = undefined;
					// A 304 still proves the source is current, so bump the stamp the
					// panel reads as "last checked".
					if (live !== undefined) live = { ...live, fetchedAt: Date.now() };
					else live = { fetchedAt: Date.now(), sourceUrl: result.url };
					return { refreshed: false, notModified: true, reason };
				}
				if (result.document === undefined) {
					lastError = result.error;
					return { refreshed: false, error: result.error, reason };
				}
				live = result.document;
				validators = { etag: result.etag, lastModified: result.lastModified };
				lastError = undefined;
				return { refreshed: true, url: result.url, reason };
			} finally {
				refreshing = undefined;
			}
		})();
		return refreshing;
	};

	/** Snapshot the current state for one instant; this is what the route serves. */
	function snapshotAt(now) {
		const pricing = effective();
		const status = pricingStatus(now, pricing, {
			holidays: settings.holidays,
			customHolidayRuns: settings.customHolidayRuns,
			treatAdjustedWorkdaysAsPeak: settings.treatAdjustedWorkdaysAsPeak,
			model: settings.model
		});
		const fetchedAt = pricing.fetchedAt;
		const ageMs = fetchedAt === undefined ? undefined : Math.max(0, now - fetchedAt);
		// Two independent reasons to distrust the data, and treating only the first
		// as "stale" is how a panel keeps a green "up to date" dot through a network
		// outage: age alone leaves it green for refreshMs × 2.5 (15 h by default)
		// while every refresh is failing.
		const tooOld = ageMs === undefined || ageMs > refreshMs * STALE_INTERVAL_MULTIPLE;
		const stale = tooOld || lastError !== undefined;
		return {
			generatedAt: now,
			status,
			pricing: {
				models: pricing.models,
				peakWindows: pricing.peakWindows,
				peakMultiplier: pricing.peakMultiplier,
				ruleText: pricing.ruleText,
				sourceUrl: pricing.sourceUrl,
				// Per-field provenance. The panel needs it to say when the schedule it
				// shows is an assumption rather than something the page actually said.
				sources: pricing.sources
			},
			data: {
				live: fetchedAt !== undefined,
				fetchedAt,
				ageMs,
				stale,
				usedFallbackSource: usedFallback,
				lastError,
				lastAttemptAt,
				refreshMinutes: settings.refreshMinutes,
				liveUpdateEnabled: settings.liveUpdateEnabled,
				snapshotOnly: !settings.liveUpdateEnabled
			},
			holidayCalendarSize: buildHolidayCalendar(
				settings.holidays,
				settings.treatAdjustedWorkdaysAsPeak,
				settings.customHolidayRuns
			).size
		};
	}

	const json = (res, code, body) => {
		const payload = JSON.stringify(body);
		res.writeHead(code, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(payload),
			"cache-control": "no-store"
		});
		res.end(payload);
	};

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: STATE_PATH,
		handler: async (req, res) => {
			const url = new URL(req.url ?? STATE_PATH, "http://localhost");
			const forced = url.searchParams.get("refresh") === "1";
			// A forced refresh is rate-limited, so reloading the page in a loop
			// cannot turn into a request storm against the docs site.
			if (forced && (lastAttemptAt === undefined || Date.now() - lastAttemptAt > FORCED_REFRESH_FLOOR_MS)) {
				await refresh("forced");
			}
			try {
				json(res, 200, snapshotAt(Date.now()));
			} catch (error) {
				json(res, 500, { error: String(error) });
			}
		}
	}), "price-peak: state route");

	// Refresh on start, then on the configured cadence. `ctx.timer` ties both the
	// pending promise and the interval to this plugin's lifetime.
	ctx.effect(() => {
		void refresh("startup");
		return ctx.timer.interval(() => void refresh("scheduled"), refreshMs);
	}, "price-peak: refresh loop");

	// Expose the same snapshot to other host plugins and to tests.
	ctx.provide("pricePeak", {
		state: () => snapshotAt(Date.now()),
		refresh,
		/** Duration text for a millisecond count, re-exported for callers. */
		formatDuration
	});
}

export { Config, FORCED_REFRESH_FLOOR_MS, STATE_PATH, apply, fetchPricing, inject, name };
