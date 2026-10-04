/**
 * DeepSeek API peak / off-peak pricing model.
 *
 * Everything the model needs at runtime arrives as a `pricing` document rather
 * than being compiled in: the host half refreshes that document from the
 * official pricing page, and the bundled snapshot (`snapshot.js`) only seeds it
 * for the first run and for offline fallback. See `parse.js` for the extractor
 * and `README.md` for the whole update path.
 *
 * Two guarantees hold regardless of where the data came from:
 *
 * 1. **Always Beijing time.** The schedule is defined in Beijing wall-clock
 *    time, so a user in Toronto, or anywhere else, must get the same answer as a
 *    user in Shanghai. Every calendar read goes through `Date.UTC` getters over
 *    a fixed +08:00 shift, never through local-time getters. Beijing has no DST.
 * 2. **调休上班日 are working days, not holidays.** The rule subtracts only
 *    法定节假日, so a Saturday the State Council turns into a working day keeps
 *    its peak windows — a plain Mon–Fri test would wrongly call it off-peak.
 *
 * This file is inlined into the browser half's reference copy, so it must stay
 * free of Node-only APIs and of `Date` local-time getters.
 */

/** Beijing is UTC+8 year-round; there is no daylight saving to account for. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Milliseconds in one day; used for Beijing-midnight arithmetic. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Peak windows as half-open `[startHour, endHour)` ranges in Beijing wall-clock
 * time. Used only when a pricing document carries no windows of its own.
 */
const DEFAULT_PEAK_WINDOWS = [
	{ startHour: 9, endHour: 12, label: "上午高峰" },
	{ startHour: 14, endHour: 18, label: "下午高峰" }
];

/**
 * 2026 statutory holidays (法定节假日), from 国办发明电〔2025〕7号
 * "国务院办公厅关于2026年部分节假日安排的通知"
 * (https://www.gov.cn/zhengce/content/202511/content_7047090.htm).
 * Runs are inclusive on both ends and use Beijing calendar dates.
 *
 * This is the one table the pricing page cannot supply: it publishes the rule
 * ("excluding Chinese statutory holidays") but never the dates. Refresh the runs
 * when the State Council publishes the next year's notice.
 */
const STATUTORY_HOLIDAY_RUNS_2026 = [
	{ month: 1, from: 1, to: 3, name: "元旦" },
	{ month: 2, from: 15, to: 23, name: "春节" },
	{ month: 4, from: 4, to: 6, name: "清明节" },
	{ month: 5, from: 1, to: 5, name: "劳动节" },
	{ month: 6, from: 19, to: 21, name: "端午节" },
	{ month: 9, from: 25, to: 27, name: "中秋节" },
	{ month: 10, from: 1, to: 7, name: "国庆节" }
];

/**
 * 2026 调休上班日: weekend days the same notice turns into working days.
 * They are working days, not holidays, so they keep their peak windows.
 */
const ADJUSTED_WORKDAYS_2026 = [
	[1, 4], [2, 14], [2, 28], [5, 9], [9, 20], [10, 10]
];

/** Year the shipped holiday table covers. */
const CALENDAR_YEAR = 2026;

/**
 * Memo for built calendars, keyed by the classification inputs. Bounded, and
 * cleared wholesale when it grows, because the inputs only change when
 * configuration does.
 */
const CALENDAR_CACHE = new Map();

/** Beijing calendar date key, `YYYY-MM-DD`; sorts lexicographically. */
function beijingDateKey(epochMs) {
	const d = new Date(epochMs + BEIJING_OFFSET_MS);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Beijing wall clock as plain calendar fields; `weekday` is 0 = Sunday. */
function beijingParts(epochMs) {
	const d = new Date(epochMs + BEIJING_OFFSET_MS);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds(),
		weekday: d.getUTCDay()
	};
}

/** Midnight opening a Beijing date, as an epoch millisecond. */
function beijingMidnight(year, month, day) {
	return Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS;
}

/** Normalize a document's windows, tolerating odd, empty, or missing entries. */
function normalizePeakWindows(windows) {
	if (!Array.isArray(windows)) return DEFAULT_PEAK_WINDOWS;
	const cleaned = windows
		.filter((w) => w !== null && typeof w === "object")
		.map((w) => ({
			startHour: Number(w.startHour),
			endHour: Number(w.endHour),
			label: typeof w.label === "string" && w.label.length > 0 ? w.label : "高峰"
		}))
		.filter((w) => Number.isFinite(w.startHour) && Number.isFinite(w.endHour) && w.endHour > w.startHour)
		.sort((a, b) => a.startHour - b.startHour);
	return cleaned.length > 0 ? cleaned : DEFAULT_PEAK_WINDOWS;
}

/** First finite number in the list, else 0. */
function pickNumber(...values) {
	for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
	return 0;
}

/** First non-empty string in the list, else undefined. */
function pickString(...values) {
	for (const value of values) if (typeof value === "string" && value.length > 0) return value;
	return undefined;
}

/**
 * Layering outcomes for one field, so mixed provenance is visible instead of
 * silent. A document can be live for its windows and snapshot-only for its
 * prices at the same time, and the panel must be able to say so.
 */
const SOURCE = {
	/** Recovered from the freshly fetched page. */
	live: "live",
	/** From the bundled snapshot: correct at capture time, possibly stale. */
	snapshot: "snapshot",
	/** The code's own default, because neither source supplied the field. */
	default: "default"
};

/**
 * Layer a live refresh over the bundled snapshot, field by field.
 *
 * Partial data is expected: a refresh may recover prices but not windows, or
 * windows but not prices. Every layer is optional and every field falls back
 * independently, so a bad fetch degrades the display instead of breaking it.
 *
 * The `sources` map reports which layer actually answered for each field. That is
 * not bookkeeping for its own sake: a document that carries a live `fetchedAt`
 * while its prices came from the snapshot would otherwise render as "current" and
 * show numbers from two different pages at once, with nothing to reveal it.
 *
 * @param live - newest successfully fetched document, or undefined.
 * @param bundled - the shipped snapshot.
 * @param overrides - user configuration, which always wins.
 */
function resolvePricing(live, bundled, overrides = {}) {
	const base = bundled !== null && typeof bundled === "object" ? bundled : {};
	const fresh = live !== null && typeof live === "object" ? live : {};

	const liveModels = Array.isArray(fresh.models) && fresh.models.length > 0 ? fresh.models : undefined;
	const baseModels = Array.isArray(base.models) && base.models.length > 0 ? base.models : undefined;
	const models = liveModels ?? baseModels ?? [];

	const liveWindows = Array.isArray(fresh.peakWindows) && fresh.peakWindows.length > 0 ? fresh.peakWindows : undefined;
	const baseWindows = Array.isArray(base.peakWindows) && base.peakWindows.length > 0 ? base.peakWindows : undefined;
	const configuredWindows = Array.isArray(overrides.peakWindows) && overrides.peakWindows.length > 0
		? overrides.peakWindows
		: undefined;

	const liveMultiplier = typeof fresh.peakMultiplier === "number" && Number.isFinite(fresh.peakMultiplier)
		? fresh.peakMultiplier
		: undefined;
	const baseMultiplier = typeof base.peakMultiplier === "number" && Number.isFinite(base.peakMultiplier)
		? base.peakMultiplier
		: undefined;
	const configuredMultiplier = typeof overrides.peakMultiplier === "number" && Number.isFinite(overrides.peakMultiplier)
		? overrides.peakMultiplier
		: undefined;

	const identifier = (liveValue, baseValue) => {
		if (liveValue !== undefined) return SOURCE.live;
		return baseValue !== undefined ? SOURCE.snapshot : SOURCE.default;
	};

	return {
		models,
		peakWindows: normalizePeakWindows(configuredWindows ?? liveWindows ?? baseWindows),
		peakMultiplier: pickNumber(configuredMultiplier, liveMultiplier, baseMultiplier, 2),
		ruleText: pickString(overrides.ruleText, fresh.ruleText, base.ruleText),
		sourceUrl: pickString(fresh.sourceUrl, base.sourceUrl),
		fetchedAt: typeof fresh.fetchedAt === "number" && Number.isFinite(fresh.fetchedAt) ? fresh.fetchedAt : undefined,
		note: pickString(fresh.note, base.note),
		/**
		 * Which layer answered for the fields the panel depends on. `windows` and
		 * `multiplier` default to the code when absent, which is the state worth
		 * surfacing: the schedule shown is an assumption, not a fact from the page.
		 */
		sources: {
			models: identifier(liveModels, baseModels),
			windows: configuredWindows !== undefined
				? SOURCE.live
				: identifier(liveWindows, baseWindows),
			multiplier: configuredMultiplier !== undefined
				? SOURCE.live
				: identifier(liveMultiplier, baseMultiplier)
		}
	};
}

/**
 * Build the date lookup: exactly the dates supplied, each classified.
 *
 * A 调休 entry carries `adjusted: true` so the classifier can flip a weekend date
 * into a working day. That is why this is a Map of classified dates rather than
 * a bare holiday set: on a 调休 Saturday the weekday test says "weekend" while
 * the notice says "go to work", and only the notice is right about pricing.
 *
 * @param holidays - explicit holiday dates replacing the shipped runs.
 * @param treatAdjustedWorkdaysAsPeak - honoured only with the shipped tables.
 * @param customHolidayRuns - runs replacing the shipped ones.
 */
function buildHolidayCalendar(holidays, treatAdjustedWorkdaysAsPeak = true, customHolidayRuns = undefined) {
	// Memoized: the panel reclassifies once a second and the transition search
	// asks ~60 times per tick, so rebuilding this table every call would burn CPU
	// for a value that only changes when configuration does.
	const cacheKey = `${treatAdjustedWorkdaysAsPeak}\u0000${JSON.stringify(holidays ?? null)}\u0000${JSON.stringify(customHolidayRuns ?? null)}`;
	const cached = CALENDAR_CACHE.get(cacheKey);
	if (cached !== undefined) return cached;

	const stat = new Map();
	const explicit = Array.isArray(holidays) ? holidays.filter((d) => typeof d === "string" && d.length > 0) : [];
	if (explicit.length > 0) {
		for (const date of explicit) stat.set(date, { name: "自定义", adjusted: false });
		return rememberCalendar(cacheKey, stat);
	}
	const runs = Array.isArray(customHolidayRuns) && customHolidayRuns.length > 0
		? customHolidayRuns
		: STATUTORY_HOLIDAY_RUNS_2026;
	for (const run of runs) {
		if (run === null || typeof run !== "object") continue;
		const month = Number(run.month);
		const from = Number(run.from);
		const to = Number(run.to);
		if (!Number.isFinite(month) || !Number.isFinite(from) || !Number.isFinite(to)) continue;
		// Day 0 of the next month is the last day of this one, which bounds a run
		// that would otherwise overrun a short month.
		const lastDay = new Date(Date.UTC(CALENDAR_YEAR, month, 0)).getUTCDate();
		for (let day = from; day <= Math.min(to, lastDay); day += 1) {
			stat.set(`${CALENDAR_YEAR}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, {
				name: typeof run.name === "string" ? run.name : "假期",
				adjusted: false
			});
		}
	}
	if (treatAdjustedWorkdaysAsPeak === true) {
		for (const [month, day] of ADJUSTED_WORKDAYS_2026) {
			stat.set(`${CALENDAR_YEAR}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, {
				name: "调休上班",
				adjusted: true
			});
		}
	}
	return rememberCalendar(cacheKey, stat);
}

/** Store a built calendar, keeping the memo small when config churns. */
function rememberCalendar(key, calendar) {
	if (CALENDAR_CACHE.size >= 8) CALENDAR_CACHE.clear();
	CALENDAR_CACHE.set(key, calendar);
	return calendar;
}

/**
 * Classify a Beijing date as a working day. A 调休 entry wins over the weekend
 * rule it would otherwise fall under; every remaining weekend is off.
 */
function isWorkingDayAt(epochMs, calendar) {
	const entry = calendar.get(beijingDateKey(epochMs));
	if (entry !== undefined) return entry.adjusted === true;
	const weekday = beijingParts(epochMs).weekday;
	return weekday !== 0 && weekday !== 6;
}

/** Is `epochMs` inside a peak window? Pure predicate over the Beijing calendar. */
function isPeakAt(epochMs, calendar, windows) {
	if (!isWorkingDayAt(epochMs, calendar)) return false;
	const p = beijingParts(epochMs);
	const minutes = p.hour * 60 + p.minute;
	return windows.some((w) => minutes >= w.startHour * 60 && minutes < w.endHour * 60);
}

/**
 * How far ahead the transition search looks, in days.
 *
 * This must cover the longest possible off-peak run, and the real bound is much
 * larger than it first looks: a 调休 Saturday is a working day, so 2026-02-14
 * ends at 18:00 and the very next instant starts Spring Festival, which runs to
 * 02-23 and is followed by an ordinary weekend — the next peak window is
 * 02-24 09:00, ten days later. Fourteen days clears that with room for a holiday
 * calendar that grows a long tail.
 */
const TRANSITION_HORIZON_DAYS = 14;

/**
 * The next instant at which the peak flag flips.
 *
 * The flag can only change at a window edge — 09:00, 12:00, 14:00 or 18:00 with
 * the shipped windows — because the hours between midnight and the first window
 * are off-peak on every kind of day. A Beijing midnight is therefore NOT a
 * transition: on a 调休 workday the state at 00:00 is unchanged, even though the
 * date and the weekday rule that applies to it change there.
 */
function findNextTransition(epochMs, calendar, windows) {
	const p = beijingParts(epochMs);
	const today = beijingMidnight(p.year, p.month, p.day);
	const current = isPeakAt(epochMs, calendar, windows);
	for (let offset = 0; offset <= TRANSITION_HORIZON_DAYS; offset += 1) {
		const midnight = today + offset * DAY_MS;
		for (const w of windows) {
			for (const candidate of [
				midnight + w.startHour * 60 * 60 * 1000,
				midnight + w.endHour * 60 * 60 * 1000
			]) {
				if (candidate > epochMs && isPeakAt(candidate, calendar, windows) !== current) return candidate;
			}
		}
	}
	// Unreachable for well-formed windows; a bounded fallback keeps the shape.
	return today + (TRANSITION_HORIZON_DAYS + 1) * DAY_MS;
}

/** Human label for the off-peak stretch an instant falls in. */
function offPeakLabel(p, workingDay, windows) {
	if (!workingDay) return "全天空闲";
	const minutes = p.hour * 60 + p.minute;
	const first = windows[0];
	const second = windows[1];
	if (first !== undefined && minutes < first.startHour * 60) return "早晨空闲";
	if (second !== undefined && minutes < second.startHour * 60) return "午间空闲";
	return "夜间空闲";
}

/**
 * Classify one instant into the pricing state the GUI shows.
 *
 * @param epochMs - the instant to classify.
 * @param pricing - a resolved document from `resolvePricing`.
 * @param options.holidays - explicit holiday dates; omit for the shipped runs.
 * @param options.treatAdjustedWorkdaysAsPeak - see buildHolidayCalendar.
 * @param options.customHolidayRuns - runs replacing the shipped ones.
 * @param options.model - model request name or table key to price against.
 */
function pricingStatus(epochMs, pricing, options = {}) {
	const p = beijingParts(epochMs);
	const dateKey = beijingDateKey(epochMs);
	const windows = normalizePeakWindows(pricing?.peakWindows);
	const peakMultiplier = typeof pricing?.peakMultiplier === "number" && pricing.peakMultiplier > 0
		? pricing.peakMultiplier
		: 2;
	const calendar = buildHolidayCalendar(
		options.holidays,
		options.treatAdjustedWorkdaysAsPeak,
		options.customHolidayRuns
	);
	const entry = calendar.get(dateKey);
	const workingDay = isWorkingDayAt(epochMs, calendar);
	const adjustedWorkday = entry !== undefined && entry.adjusted === true;
	const isWeekend = p.weekday === 0 || p.weekday === 6;

	const minutes = p.hour * 60 + p.minute;
	const activeWindow = workingDay
		? windows.find((w) => minutes >= w.startHour * 60 && minutes < w.endHour * 60)
		: undefined;
	const peak = activeWindow !== undefined;
	const nextTransitionMs = findNextTransition(epochMs, calendar, windows);
	const model = modelEntry(pricing, options.model);

	// Label the day's kind. A 调休 Saturday announces itself as such rather than
	// masquerading as an ordinary weekend or an ordinary weekday.
	const reason = adjustedWorkday
		? "调休上班日"
		: entry !== undefined
			? `${entry.name}假期`
			: isWeekend
				? (p.weekday === 0 ? "周日" : "周六")
				: (peak ? "工作日高峰时段" : "工作日非高峰时段");

	return {
		epochMs,
		dateKey,
		beijing: {
			hour: p.hour,
			minute: p.minute,
			second: p.second,
			weekday: p.weekday,
			clock: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`
		},
		peak,
		multiplier: peak ? peakMultiplier : 1,
		workingDay,
		windowLabel: peak ? activeWindow.label : offPeakLabel(p, workingDay, windows),
		reason,
		holidayName: entry !== undefined && entry.adjusted !== true ? entry.name : undefined,
		adjustedWorkday,
		nextTransitionMs,
		msUntilTransition: Math.max(0, nextTransitionMs - epochMs),
		windows: windows.map((w) => ({
			label: w.label,
			from: `${String(w.startHour).padStart(2, "0")}:00`,
			to: `${String(w.endHour).padStart(2, "0")}:00`,
			active: peak && w === activeWindow
		})),
		todayPeakHours: workingDay
			? windows.reduce((sum, w) => sum + (w.endHour - w.startHour), 0)
			: 0,
		model: model === undefined
			? undefined
			: {
				name: model.name,
				version: model.version,
				unit: model.unit,
				rates: peak ? model.peak : model.offPeak
			},
		calendarYear: CALENDAR_YEAR,
		usingShippedHolidays: !(Array.isArray(options.holidays) && options.holidays.length > 0)
	};
}

/** Look up a model row by request name or table key; defaults to the first row. */
function modelEntry(pricing, key) {
	const models = Array.isArray(pricing?.models) ? pricing.models : [];
	if (models.length === 0) return undefined;
	if (typeof key !== "string" || key.length === 0) return models[0];
	const lowered = key.toLowerCase();
	return models.find((m) =>
		String(m?.name).toLowerCase() === lowered || String(m?.key).toLowerCase() === lowered
	) ?? models[0];
}

/**
 * Human duration at the coarsest useful unit: `45秒`, `4分12秒`, `2小时03分`,
 * `9天14小时`.
 *
 * The days case is not decoration. A 调休 workday can sit directly against a long
 * Spring Festival, putting the next peak more than a week away, and reporting
 * that as "230小时22分" would be technically right and completely useless.
 */
function formatDuration(ms) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(total / 86400);
	const hours = Math.floor((total % 86400) / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (days > 0) return `${days}天${hours}小时`;
	if (hours > 0) return `${hours}小时${String(minutes).padStart(2, "0")}分`;
	if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
	return `${seconds}秒`;
}

/** `2` -> `×2`. */
function multiplierText(multiplier) {
	return `×${multiplier}`;
}

export {
	ADJUSTED_WORKDAYS_2026,
	SOURCE,
	BEIJING_OFFSET_MS,
	CALENDAR_YEAR,
	DAY_MS,
	DEFAULT_PEAK_WINDOWS,
	STATUTORY_HOLIDAY_RUNS_2026,
	TRANSITION_HORIZON_DAYS,
	beijingDateKey,
	beijingMidnight,
	beijingParts,
	buildHolidayCalendar,
	findNextTransition,
	formatDuration,
	isPeakAt,
	isWorkingDayAt,
	modelEntry,
	multiplierText,
	normalizePeakWindows,
	pricingStatus,
	resolvePricing
};
