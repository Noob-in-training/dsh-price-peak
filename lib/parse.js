/**
 * Extractor for the official DeepSeek pricing page.
 *
 * The page is a Docusaurus build that ships its content server-side, so the
 * price table is present in the raw HTML and no JavaScript needs to run. It also
 * carries no CORS header, which is why this runs in the host half rather than in
 * the browser: the host fetches, this module parses, and the client half reads
 * the result from the local route (see `index.js`).
 *
 * The extractor is deliberately tolerant. It reads the *rendered text* of the
 * table rather than its markup, so a styling change does not break it, and every
 * field is optional: whatever it cannot recover is simply absent from the
 * result, and `resolvePricing` in `core.js` falls back per field. What it must
 * never do is return a confidently wrong number, so every recovered value is
 * sanity-checked against the shape the official table can have.
 */

/**
 * The official pricing page this parser understands.
 *
 * Only the Chinese page: every extractor keys on its labels (`模型`, `价格`,
 * `空闲时段`, `北京时间`), so the English sibling parses to nothing. It used to be
 * listed as a fallback, which was documented behaviour that could never happen.
 */
const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";

/** Fallback when the page does not state one; the table is per million tokens. */
const DEFAULT_UNIT = "百万tokens";

/**
 * The rate fields a complete model row must carry, in MATCH order: the first
 * pattern that accepts a flattened row label names the field.
 *
 * `缓存未命中` is tested before `缓存命中` on purpose — the miss label contains the
 * hit label's phrase, so the reverse order would file every miss row as a hit. The
 * patterns used to live here unused while `fieldOfLabel` carried its own copy, which
 * made one ordering trap to remember in two places.
 */
const ROW_LABELS = [
	{ field: "cacheMiss", pattern: /缓存未命中|cache\s*miss/i },
	{ field: "cacheHit", pattern: /缓存命中|cache\s*hit/i },
	{ field: "output", pattern: /输出|output/i }
];

/**
 * Flatten HTML into pipe-delimited text: a cell ends with `|`, a row or block
 * element ends with a newline, and tags collapse to nothing. Table structure is
 * what the price extractor walks, so it has to survive this step intact.
 */
function htmlToText(html) {
	return String(html)
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<\/t[dh]\s*>/gi, "|")
		.replace(/<\/tr\s*>/gi, "\n")
		.replace(/<\/(?:p|div|h[1-6]|li|table|section)\s*>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/[ \t\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{2,}/g, "\n")
		.replace(/\|{2,}/g, "|")
		.replace(/\|\s*\n/g, "\n")
		.trim();
}

/** `0.02元` / `$0.14` / `1` -> a finite number, or undefined. */
function parseAmount(raw) {
	if (typeof raw !== "string") return undefined;
	const match = /-?\d+(?:\.\d+)?/.exec(raw.replace(/,/g, ""));
	if (match === null) return undefined;
	const value = Number(match[0]);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Categorize one row label into a rate field, or undefined when unrelated. */
function fieldOfLabel(label) {
	if (label === undefined) return undefined;
	return ROW_LABELS.find(({ pattern }) => pattern.test(label))?.field;
}

/**
 * Recover the model columns from the header row.
 *
 * Flattened, that row reads `模型|deepseek-flash(1)|deepseek-v4-pro` and sits on a
 * line of its own, so only that line is read. The rows below it also hold
 * `deepseek-`-shaped values — `模型版本` carries `DeepSeek-V4.1-Flash` — which a
 * wider match would turn into phantom columns.
 */
function parseModels(text) {
	const header = /^模型\|[^\n]*/m.exec(text);
	if (header === null) return [];
	const names = [];
	for (const cell of header[0].split("|")) {
		const name = cell.replace(/\(\d+\)/g, "").trim();
		if (/^deepseek-[a-z0-9][a-z0-9.-]*$/i.test(name)) names.push(name);
	}
	return names.map((name) => ({ key: name.replace(/^deepseek-/, ""), name }));
}

/**
 * Recover per-model prices.
 *
 * Flattened, a price row reads
 * `百万tokens输入 （缓存命中）|空闲时段|0.02元|0.15元` followed by
 * `高峰时段|0.04元|0.30元`, with footnote markers on some cells and the `<br>`
 * inside a label collapsed to a space. One regex walks the whole block, and each
 * match is labelled by the metric named in its first cell.
 */
function parseRates(text, models) {
	const byModel = models.map(() => ({}));
	/** Metrics seen twice; see the duplicate guard below. */
	const ambiguous = new Set();
	const block = /价格\(?\d*\)?\|[\s\S]{0,2600}?并发限制/.exec(text);
	if (block === null) return byModel;

	// A literal, deliberately: building this with `String.raw` leaves `\s` as a
	// backslash followed by an "s", which silently never matches.
	//
	// The separator before `高峰时段` is OPTIONAL, and that is load-bearing. In
	// the flattened table the second model's off-peak price ends its row, so what
	// follows it is a newline and then the peak label with no `|` in between.
	// Making the pipe optional is what lets those two halves join; adding `\s*`
	// in front of a still-required pipe does not help, because a required
	// character class that matches nothing matches nothing at all.
	const rowPattern = /(百万tokens输入\s*(?:（[^）]*）|\([^)]*\))?|百万tokens输出|输出|输入)\s*\|\s*空闲时段\s*\|\s*([^|\n]*)\|\s*([^|\n]*)\s*\|?\s*高峰时段\s*\|\s*([^|\n]*)\|\s*([^|\n]*)/g;

	for (const match of block[0].matchAll(rowPattern)) {
		const field = fieldOfLabel(match[1]);
		if (field === undefined) continue;
		const offValues = [parseAmount(match[2]), parseAmount(match[3])];
		const peakValues = [parseAmount(match[4]), parseAmount(match[5])];
		for (let i = 0; i < models.length; i += 1) {
			const off = offValues[i];
			const peak = peakValues[i];
			if (off === undefined || peak === undefined) continue;
			// A second row for the same metric is ambiguous: it means the table no
			// longer has the shape this parser assumes, and picking either value
			// would be a guess presented as a reading. Drop the metric instead.
			if (byModel[i][field] !== undefined) {
				byModel[i][field] = undefined;
				ambiguous.add(`${models[i]?.name ?? i}:${field}`);
				continue;
			}
			byModel[i][field] = { off, peak };
		}
	}
	byModel.ambiguous = ambiguous;
	return byModel;
}

/** Fold the `{ off, peak }` pairs into the `{ offPeak, peak }` model shape. */
function foldRates(byModel, models, unit) {
	const folded = [];
	for (let i = 0; i < models.length; i += 1) {
		const rates = byModel[i] ?? {};
		const offPeak = {};
		const peak = {};
		let complete = true;
		for (const { field } of ROW_LABELS) {
			const pair = rates[field];
			if (pair === undefined) {
				complete = false;
				continue;
			}
			offPeak[field] = pair.off;
			peak[field] = pair.peak;
		}
		if (!complete) continue;
		folded.push({ ...models[i], unit, offPeak, peak });
	}
	return folded;
}

/**
 * Recover the peak windows from the explanatory note, e.g.
 * "北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段".
 */
function parsePeakWindows(text) {
	// Chinese only. The English page phrases this as "Peak hours are 01:00 - 04:00 and
	// 06:00 - 10:00 UTC", which no pattern here matches, and matching it would be
	// worse than not: the extractor would produce peak WINDOWS while the price table
	// still failed, so the panel would show the page's schedule against the bundled
	// snapshot's prices and call the mixture current.
	const source = /北京时间[\s\S]{0,200}?为高峰时段/.exec(text);
	if (source === null) return undefined;
	const windows = [];
	const pattern = /(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~]\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
	for (const match of source[0].matchAll(pattern)) {
		const startHour = Number(match[1]);
		const endHour = Number(match[3]);
		if (Number(match[2]) !== 0 || Number(match[4]) !== 0) continue;
		if (!(startHour >= 0 && startHour < 24 && endHour > startHour && endHour <= 24)) continue;
		windows.push({ startHour, endHour, label: startHour < 12 ? "上午高峰" : "下午高峰" });
	}
	const unique = [];
	for (const w of windows) {
		if (!unique.some((u) => u.startHour === w.startHour && u.endHour === w.endHour)) unique.push(w);
	}
	return unique.length > 0 ? unique.sort((a, b) => a.startHour - b.startHour) : undefined;
}

/**
 * Recover the "peak is N× off-peak" multiplier from the note.
 *
 * The page states the relationship from the off-peak side — "空闲时段价格为高峰
 * 时段价格的一半" — so "half" must be inverted into a peak multiplier of 2; it
 * would be wrong to read it as a multiplier of 0.5. The English page says
 * "half" too, and an explicit "N times" is taken at face value.
 */
function parseMultiplier(text) {
	if (/空闲时段价格为高峰时段价格的一半/.test(text)) return 2;
	const zh = /空闲时段价格为高峰时段价格的\s*(\d+(?:\.\d+)?)\s*倍/.exec(text);
	if (zh !== null) return Number(zh[1]);
	// No English branch, for the same reason as the windows above: the English note
	// reads "Off-peak rates are half of the peak rates", and accepting the half of it
	// that this could match would again produce a partially live document.
}

/** The sentence describing the schedule, for display and debugging. */
function parseRuleText(text) {
	const match = /北京时间[^。]{0,220}。/.exec(text);
	return match === null ? undefined : match[0].replace(/\s+/g, " ").trim();
}

/**
 * Parse one pricing page.
 *
 * @param html - raw HTML of the official pricing page.
 * @param options.sourceUrl - recorded on the result for the freshness display.
 * @param options.fetchedAt - epoch ms of the fetch; defaults to now.
 * @returns a pricing document, or undefined when nothing usable was recovered.
 */
function parsePricingPage(html, options = {}) {
	const text = htmlToText(html);
	const models = parseModels(text);
	const unit = DEFAULT_UNIT; // the official table is always per million tokens
	const byModel = parseRates(text, models);
	const folded = foldRates(byModel, models, unit);
	const windows = parsePeakWindows(text);
	const peakMultiplier = parseMultiplier(text);
	const ruleText = parseRuleText(text);

	if (folded.length === 0 && windows === undefined && peakMultiplier === undefined) return undefined;

	return {
		models: folded,
		...(byModel.ambiguous !== undefined && byModel.ambiguous.size > 0
			? { ambiguous: [...byModel.ambiguous] }
			: {}),
		...(windows === undefined ? {} : { peakWindows: windows }),
		...(peakMultiplier === undefined ? {} : { peakMultiplier }),
		...(ruleText === undefined ? {} : { ruleText }),
		...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl }),
		fetchedAt: typeof options.fetchedAt === "number" ? options.fetchedAt : Date.now()
	};
}

/**
 * Parse, then reject documents that would corrupt the display.
 *
 * A half-parsed model — prices present but no output rate — is dropped rather
 * than shown, the multiplier must be at least 1, and a metric that appeared twice
 * rejects the whole document: an ambiguous table means the page no longer has the
 * shape this parser understands, and picking a row would be a guess printed as a
 * reading. When nothing survives, the caller keeps its previous snapshot.
 *
 * @param html - raw HTML of the official pricing page.
 * @param options.sourceUrl - recorded on the result for the freshness display.
 * @param options.fetchedAt - epoch ms of the fetch; defaults to now.
 * @param options.onReject - called with the reason when a page is refused, so the
 *        caller can say why instead of reporting a bare "nothing usable". A refusal
 *        with no stated reason (an unrelated page) does not call it.
 * @returns a pricing document, or undefined when nothing usable was recovered.
 */
function parseAndValidate(html, options = {}) {
	const parsed = parsePricingPage(html, options);
	if (parsed === undefined) return undefined;
	if (parsed.ambiguous !== undefined && parsed.ambiguous.length > 0) {
		options.onReject?.(`ambiguous price rows: ${parsed.ambiguous.join(", ")}`);
		return undefined;
	}
	const models = (parsed.models ?? []).filter((m) =>
		m.offPeak !== undefined
		&& m.peak !== undefined
		&& ["cacheHit", "cacheMiss", "output"].every((f) =>
			typeof m.offPeak[f] === "number" && typeof m.peak[f] === "number"
		)
	);
	const windows = Array.isArray(parsed.peakWindows)
		? parsed.peakWindows.filter((w) => w.endHour > w.startHour)
		: undefined;
	const valid = {
		...parsed,
		models,
		...(windows === undefined ? {} : { peakWindows: windows })
	};
	if (typeof valid.peakMultiplier === "number" && valid.peakMultiplier < 1) delete valid.peakMultiplier;
	if (valid.models.length === 0 && valid.peakWindows === undefined && valid.peakMultiplier === undefined) return undefined;
	return valid;
}

export {
	DEFAULT_UNIT,
	PRICING_URL,
	ROW_LABELS,
	htmlToText,
	parseAmount,
	parseAndValidate,
	parseMultiplier,
	parsePeakWindows,
	parsePricingPage
};
