/**
 * Unit tests for the peak/off-peak pricing core.
 *
 * Run: node --test dsh-price-peak/test/core.test.mjs
 *
 * Every expectation is written as an explicit Beijing wall-clock time. The `bj`
 * helper converts through a fixed +08:00 offset rather than the host timezone,
 * so these assertions hold on any machine — which is the point of the module.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	BEIJING_OFFSET_MS,
	TRANSITION_HORIZON_DAYS,
	buildHolidayCalendar,
	formatDuration,
	isPeakAt,
	modelEntry,
	multiplierText,
	pricingStatus,
	resolvePricing,
	SOURCE
} from "../lib/core.js";

/** A Beijing wall-clock instant, as epoch ms. Month is 1-based. */
const bj = (year, month, day, hour = 0, minute = 0, second = 0) =>
	Date.UTC(year, month - 1, day, hour, minute, second) - BEIJING_OFFSET_MS;

/** A pricing document shaped like a parsed official page. */
const PRICING = {
	models: [
		{
			key: "flash",
			name: "deepseek-flash",
			unit: "百万tokens",
			offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
			peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
		}
	],
	peakWindows: [
		{ startHour: 9, endHour: 12, label: "上午高峰" },
		{ startHour: 14, endHour: 18, label: "下午高峰" }
	],
	peakMultiplier: 2
};

/** Status with the standard document. */
const status = (epochMs, options = {}) => pricingStatus(epochMs, PRICING, options);

/** Beijing `HH:MM` of a transition instant. */
const hhmm = (epochMs) => {
	const s = status(epochMs);
	return `${String(s.beijing.hour).padStart(2, "0")}:${String(s.beijing.minute).padStart(2, "0")}`;
};

// ── Beijing-time independence ────────────────────────────────────────────────
// 2026-01-05 Mon, 01-09 Fri, 01-10 Sat, 01-11 Sun are ordinary dates outside
// every holiday run, so they isolate the weekday/weekend rules.

test("classification depends only on Beijing time, never on the host clock", () => {
	// The same instant, whatever the machine's TZ is set to, must classify
	// identically: that is what makes the display correct in Toronto.
	const instant = Date.UTC(2026, 0, 5, 4, 30); // 12:30 Beijing, 23:30 Toronto (Jan 4)
	const original = process.env.TZ;
	try {
		const results = [];
		for (const zone of ["Asia/Shanghai", "America/Toronto", "UTC", "Pacific/Kiritimati"]) {
			process.env.TZ = zone;
			results.push(JSON.stringify(status(instant)));
		}
		assert.equal(new Set(results).size, 1, "every timezone must produce the same status");
	} finally {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	}
});

test("the reported clock is Beijing wall time, not local time", () => {
	// 2026-01-05T04:30Z is 12:30 in Beijing and 23:30 on Jan 4 in Toronto.
	const s = status(Date.UTC(2026, 0, 5, 4, 30));
	assert.equal(s.beijing.hour, 12);
	assert.equal(s.beijing.minute, 30);
	assert.equal(s.dateKey, "2026-01-05", "the Beijing date, not the Toronto one");
});

// ── Windows ──────────────────────────────────────────────────────────────────

test("weekday inside a peak window is peak ×2", () => {
	for (const [hour, label] of [[9, "上午高峰"], [10, "上午高峰"], [14, "下午高峰"], [17, "下午高峰"]]) {
		const s = status(bj(2026, 1, 5, hour, 30));
		assert.equal(s.peak, true, `${hour}:30 should be peak`);
		assert.equal(s.multiplier, 2);
		assert.equal(s.windowLabel, label);
		assert.equal(s.reason, "工作日高峰时段");
	}
});

test("window edges are half-open: 09:00 in, 12:00 out, 14:00 in, 18:00 out", () => {
	assert.equal(status(bj(2026, 1, 5, 8, 59)).peak, false);
	assert.equal(status(bj(2026, 1, 5, 9, 0)).peak, true);
	assert.equal(status(bj(2026, 1, 5, 11, 59)).peak, true);
	assert.equal(status(bj(2026, 1, 5, 12, 0)).peak, false);
	assert.equal(status(bj(2026, 1, 5, 13, 59)).peak, false);
	assert.equal(status(bj(2026, 1, 5, 14, 0)).peak, true);
	assert.equal(status(bj(2026, 1, 5, 17, 59)).peak, true);
	assert.equal(status(bj(2026, 1, 5, 18, 0)).peak, false);
});

test("off-peak stretches get their own labels", () => {
	assert.equal(status(bj(2026, 1, 5, 7, 0)).windowLabel, "早晨空闲");
	assert.equal(status(bj(2026, 1, 5, 12, 30)).windowLabel, "午间空闲");
	assert.equal(status(bj(2026, 1, 5, 20, 0)).windowLabel, "夜间空闲");
	assert.equal(status(bj(2026, 1, 5, 20, 0)).multiplier, 1);
});

test("weekends are off-peak all day", () => {
	for (const day of [10, 11]) {
		for (const hour of [0, 10, 15, 23]) {
			const s = status(bj(2026, 1, day, hour, 0));
			assert.equal(s.peak, false, `2026-01-${day} ${hour}:00 should be off-peak`);
			assert.equal(s.windowLabel, "全天空闲");
			assert.equal(s.multiplier, 1);
		}
	}
	assert.equal(status(bj(2026, 1, 10, 10, 0)).reason, "周六");
	assert.equal(status(bj(2026, 1, 11, 10, 0)).reason, "周日");
});

// ── The 调休 trap ────────────────────────────────────────────────────────────

test("法定节假日 is off-peak even on a weekday", () => {
	// 2026-02-17 is a Tuesday inside 春节 (Feb 15-23).
	const s = status(bj(2026, 2, 17, 10, 0));
	assert.equal(s.peak, false);
	assert.equal(s.multiplier, 1);
	assert.equal(s.reason, "春节假期");
	assert.equal(s.holidayName, "春节");

	assert.equal(status(bj(2026, 5, 5, 15, 0)).peak, false, "劳动节 Tuesday");
	assert.equal(status(bj(2026, 10, 1, 10, 0)).reason, "国庆节假期");
});

test("调休上班日 keeps PEAK windows: a working Saturday is not a holiday", () => {
	// 2026-02-14 is a Saturday the notice turns into a working day. It is not a
	// statutory holiday, so the pricing rule keeps its peak windows.
	const morning = status(bj(2026, 2, 14, 10, 0));
	assert.equal(morning.peak, true, "调休 Saturday must stay peak");
	assert.equal(morning.multiplier, 2);
	assert.equal(morning.reason, "调休上班日");

	assert.equal(status(bj(2026, 2, 14, 15, 0)).peak, true);
	assert.equal(status(bj(2026, 2, 14, 3, 0)).peak, false, "its overnight hours are still off-peak");

	for (const [month, day] of [[1, 4], [2, 28], [5, 9], [9, 20], [10, 10]]) {
		assert.equal(status(bj(2026, month, day, 10, 0)).peak, true, `调休 ${month}-${day} should be peak`);
	}
});

test("treatAdjustedWorkdaysAsPeak:false demotes 调休 days to ordinary weekends", () => {
	const calendar = buildHolidayCalendar(undefined, false);
	assert.equal(status(bj(2026, 2, 14, 10, 0), { treatAdjustedWorkdaysAsPeak: false }).peak, false);
	assert.equal(calendar.has("2026-02-14"), false, "no 调休 entry at all in this mode");
	assert.equal(calendar.has("2026-02-17"), true, "statutory runs are unaffected by the switch");
});

test("an explicit holiday list replaces the shipped table wholesale", () => {
	// `holidays` and `customHolidayRuns` are alternatives, not layers. If an
	// explicit list merely joined the shipped table, a user entering next year's
	// dates would silently keep this year's holidays too — and there is no way to
	// express "only these dates".
	const options = { holidays: ["2026-01-05"] };
	assert.equal(status(bj(2026, 1, 5, 10, 0), options).peak, false, "the listed date is a holiday");
	assert.equal(status(bj(2026, 1, 5, 10, 0), options).usingShippedHolidays, false);
	assert.equal(status(bj(2026, 2, 17, 10, 0), options).peak, true, "Spring Festival is gone with the table");
	// The 调休 table belongs to the shipped notice, which was just replaced, so its
	// workdays go too. That is coherent — but it must be a consequence of replacing
	// the table, never of adding one unrelated date.
	assert.equal(status(bj(2026, 2, 14, 10, 0), options).reason, "周六");
});

test("adding a holiday does not quietly disable the 调休 table by accident", () => {
	// The bug this guards: `holidays` used to return early, before the 调休 loop, so
	// one unrelated date turned every working Saturday into off-peak. With the list
	// semantics above, 调休 goes only when the whole shipped table goes — which is
	// what the previous test asserts. What must not happen is the table surviving a
	// replacement.
	const replaced = { holidays: ["2026-12-25"] };
	assert.equal(status(bj(2026, 12, 25, 10, 0), replaced).peak, false, "the new date applies");
	assert.equal(status(bj(2026, 2, 17, 10, 0), replaced).peak, true, "and the shipped table is replaced");

	// A custom run list behaves the same way.
	const runs = { customHolidayRuns: [{ year: 2026, month: 12, from: 25, to: 26, name: "圣诞" }] };
	assert.equal(status(bj(2026, 12, 25, 10, 0), runs).peak, false);
	assert.equal(status(bj(2026, 2, 14, 10, 0), runs).peak, false, "its 调休 entry goes with the table");
});

test("a holiday run can name its own year, so next year needs no code change", () => {
	// CALENDAR_YEAR used to key every run, so a run meant for 2027 produced 2026
	// keys and the documented "no code change next year" path simply did not work.
	const nextYear = { customHolidayRuns: [{ year: 2027, month: 1, from: 1, to: 3, name: "元旦" }] };
	assert.equal(status(bj(2027, 1, 1, 10, 0), nextYear).peak, false, "2027-01-01 is a holiday");
	assert.equal(status(bj(2027, 1, 1, 10, 0), nextYear).reason, "元旦假期");
	assert.equal(status(bj(2027, 1, 4, 10, 0), nextYear).peak, true, "and a plain Monday is peak");

	// Without a year the run lands in the shipped calendar's year, as documented.
	const thisYear = { customHolidayRuns: [{ month: 12, from: 25, to: 26, name: "圣诞" }] };
	assert.equal(status(bj(2026, 12, 25, 10, 0), thisYear).peak, false);
});

test("a holiday run longer than the search horizon reports no transition", () => {
	// The 14-day horizon covers the shipped calendar. A user-configured run can
	// exceed it, and the old fallback returned an invented instant where the peak
	// flag does not change — a countdown to nothing.
	const longRun = { customHolidayRuns: [{ year: 2026, month: 4, from: 1, to: 30, name: "长假" }] };
	const s = status(bj(2026, 4, 15, 10, 0), longRun);
	assert.equal(s.peak, false, "the whole of April is off-peak");
	assert.equal(s.nextTransitionMs, null, "no flip inside the horizon");
	assert.equal(s.msUntilTransition, null, "so no duration may be reported either");
});

test("custom holiday runs replace the shipped runs", () => {
	const options = { customHolidayRuns: [{ month: 3, from: 2, to: 4, name: "测试假" }] };
	assert.equal(status(bj(2026, 3, 3, 10, 0), options).peak, false);
	assert.equal(status(bj(2026, 3, 3, 10, 0), options).reason, "测试假假期");
	assert.equal(status(bj(2026, 2, 17, 10, 0), options).peak, true, "shipped runs are gone");
});

// ── Transitions ──────────────────────────────────────────────────────────────

test("midday off-peak points at the 14:00 restart, not the noon boundary", () => {
	const s = status(bj(2026, 1, 5, 12, 30));
	assert.equal(s.peak, false);
	assert.equal(hhmm(s.nextTransitionMs), "14:00");
	assert.equal(formatDuration(s.msUntilTransition), "1小时30分");
});

test("each state points at the next real flip", () => {
	const cases = [
		[7, 0, "09:00"], // before the morning window
		[10, 0, "12:00"], // inside the morning window
		[13, 0, "14:00"], // after lunch
		[15, 0, "18:00"], // inside the afternoon window
		[20, 0, "09:00"] // evening → the next working day's morning window
	];
	for (const [hour, minute, expected] of cases) {
		const s = status(bj(2026, 1, 5, hour, minute));
		assert.equal(hhmm(s.nextTransitionMs), expected, `${hour}:${minute} → ${expected}`);
		assert.equal(status(s.nextTransitionMs).peak, !s.peak, "transition must flip the flag");
	}
});

test("Friday evening jumps the weekend to Monday morning", () => {
	const s = status(bj(2026, 1, 9, 19, 0)); // Friday 19:00
	assert.equal(s.peak, false);
	const next = status(s.nextTransitionMs);
	assert.equal(hhmm(s.nextTransitionMs), "09:00");
	assert.equal(next.beijing.weekday, 1, "next transition lands on Monday");
	assert.equal(next.dateKey, "2026-01-12");
	assert.equal(next.peak, true);
});

test("a whole weekend is off-peak, and Monday morning resumes the peak", () => {
	for (const t of [bj(2026, 1, 10, 0, 0), bj(2026, 1, 10, 12, 0), bj(2026, 1, 11, 23, 59)]) {
		assert.equal(status(t).peak, false);
	}
	// Saturday noon points three days ahead, at Monday 09:00. This is the case a
	// three-day candidate window used to miss.
	const s = status(bj(2026, 1, 10, 12, 0));
	assert.equal(s.nextTransitionMs, bj(2026, 1, 12, 9, 0));
});

test("a 调休 workday keeps working-day windows, and midnight is not a transition", () => {
	const sunday = status(bj(2026, 1, 4, 10, 0));
	assert.equal(sunday.beijing.weekday, 0, "still a Sunday by calendar");
	assert.equal(sunday.peak, true, "but a working day by notice");

	// From New Year's Day the next flip is 01-04 09:00, not 01-04 00:00: the
	// state either side of that midnight is off-peak, so it is not a boundary.
	const s = status(bj(2026, 1, 1, 0, 0));
	assert.equal(s.nextTransitionMs, bj(2026, 1, 4, 9, 0));
	assert.equal(status(bj(2026, 1, 3, 10, 0)).peak, false, "the Saturday between is off-peak");
});

test("a holiday run landing on a weekend still resolves its transition", () => {
	// 劳动节 2026-05-01(Fri)..05-05(Tue); the next peak starts Wed 05-06 09:00.
	const s = status(bj(2026, 5, 5, 20, 0));
	assert.equal(s.peak, false);
	assert.equal(hhmm(s.nextTransitionMs), "09:00");
	assert.equal(status(s.nextTransitionMs).dateKey, "2026-05-06");
	assert.equal(status(s.nextTransitionMs).peak, true);
});

test("every reported transition instant really flips the flag", () => {
	// Sample all of 2026 at an awkward cadence so instants land at many
	// sub-minute offsets, then assert the invariant directly for each one.
	const calendar = buildHolidayCalendar();
	const limit = (TRANSITION_HORIZON_DAYS + 1) * 24 * 60 * 60 * 1000;
	for (let t = bj(2026, 1, 1, 0, 0) + 37000; t < bj(2027, 1, 1, 0, 0); t += 6311000) {
		const s = status(t);
		assert.equal(
			isPeakAt(s.nextTransitionMs, calendar, PRICING.peakWindows),
			!s.peak,
			`bad transition from ${s.dateKey} ${s.beijing.clock}`
		);
		assert.ok(s.nextTransitionMs > t, "a transition is always in the future");
		assert.ok(s.nextTransitionMs - t <= limit, "and lands inside the search horizon");
	}
});

test("a 调休 Saturday glued to Spring Festival looks ten days ahead", () => {
	// The case that set the horizon: 2026-02-14 is a working Saturday that ends
	// at 18:00, and Spring Festival runs 02-15..02-23, so the next peak window is
	// 02-24 09:00. A four-day window returned a fabricated instant instead.
	const s = status(bj(2026, 2, 14, 18, 38));
	assert.equal(s.peak, false);
	assert.equal(s.reason, "调休上班日");
	assert.equal(status(s.nextTransitionMs).dateKey, "2026-02-24");
	assert.equal(status(s.nextTransitionMs).peak, true);
	assert.equal(hhmm(s.nextTransitionMs), "09:00");
	assert.equal(formatDuration(s.msUntilTransition), "9天14小时");
});

test("peak windows do not leak into the next calendar day", () => {
	assert.equal(status(bj(2026, 1, 5, 23, 0)).peak, false);
	assert.equal(status(bj(2026, 1, 5, 23, 0)).dateKey, "2026-01-05");
	assert.equal(status(bj(2026, 1, 6, 0, 0)).dateKey, "2026-01-06");
});

test("isPeakAt agrees with pricingStatus on a sampled grid", () => {
	const calendar = buildHolidayCalendar();
	for (let day = 1; day <= 31; day += 1) {
		for (let hour = 0; hour < 24; hour += 1) {
			const t = bj(2026, 3, day, hour, 30);
			assert.equal(
				isPeakAt(t, calendar, PRICING.peakWindows),
				status(t).peak,
				`mismatch at 2026-03-${day} ${hour}:30`
			);
		}
	}
});

// ── Live-data layering ───────────────────────────────────────────────────────

test("resolvePricing lets a live document override the bundled snapshot", () => {
	const bundled = {
		models: [{ key: "old", name: "deepseek-old", offPeak: {}, peak: {} }],
		peakWindows: [{ startHour: 1, endHour: 2, label: "旧" }],
		peakMultiplier: 4,
		ruleText: "old rule"
	};
	const live = {
		models: PRICING.models,
		peakWindows: PRICING.peakWindows,
		peakMultiplier: 2,
		ruleText: "new rule",
		fetchedAt: 123
	};
	const resolved = resolvePricing(live, bundled);
	assert.equal(resolved.models[0].name, "deepseek-flash");
	assert.equal(resolved.peakMultiplier, 2);
	assert.equal(resolved.ruleText, "new rule");
	assert.equal(resolved.fetchedAt, 123);
	assert.deepEqual(resolved.peakWindows, PRICING.peakWindows);
});

test("resolvePricing falls back per field when the live document is partial", () => {
	const bundled = {
		models: PRICING.models,
		peakWindows: PRICING.peakWindows,
		peakMultiplier: 2,
		ruleText: "bundled rule"
	};
	// A refresh that recovered only the multiplier must not erase the models or
	// the windows.
	const resolved = resolvePricing({ peakMultiplier: 3 }, bundled);
	assert.equal(resolved.models.length, 1);
	assert.deepEqual(resolved.peakWindows, PRICING.peakWindows);
	assert.equal(resolved.peakMultiplier, 3);
	assert.equal(resolved.ruleText, "bundled rule");
});

test("resolvePricing lets user overrides beat both layers", () => {
	const bundled = { models: PRICING.models, peakWindows: PRICING.peakWindows, peakMultiplier: 2 };
	const live = { peakMultiplier: 3, peakWindows: [{ startHour: 5, endHour: 6, label: "自定" }] };
	const resolved = resolvePricing(live, bundled, { peakMultiplier: 1.5 });
	assert.equal(resolved.peakMultiplier, 1.5);
	assert.deepEqual(resolved.peakWindows, [{ startHour: 5, endHour: 6, label: "自定" }]);
});

test("resolvePricing reports which layer answered for each field", () => {
	// A document can be live for its schedule and snapshot-only for its prices at
	// the same time. Without provenance the panel presents that mixture as one
	// current reading, which is how a silent wrong number reaches a user.
	const bundled = {
		models: PRICING.models,
		peakWindows: PRICING.peakWindows,
		peakMultiplier: 2
	};

	// Prices missing from the live layer, schedule present: the dangerous case.
	const mixed = resolvePricing(
		{ peakWindows: [{ startHour: 10, endHour: 11, label: "页面窗口" }], peakMultiplier: 3, fetchedAt: 1 },
		bundled
	);
	assert.equal(mixed.sources.models, "snapshot", "prices fell back to the snapshot");
	assert.equal(mixed.sources.windows, "live", "while the schedule came from the page");
	assert.equal(mixed.sources.multiplier, "live");
	assert.equal(mixed.peakMultiplier, 3, "and the page multiplier is what renders");

	// Everything live.
	const full = resolvePricing(
		{ models: PRICING.models, peakWindows: PRICING.peakWindows, peakMultiplier: 2, fetchedAt: 1 },
		bundled
	);
	assert.deepEqual(full.sources, { models: "live", windows: "live", multiplier: "live" });

	// Nothing live, snapshot carries a schedule: every field is the snapshot's.
	const snapshotWithSchedule = resolvePricing(undefined, bundled);
	assert.deepEqual(snapshotWithSchedule.sources, {
		models: "snapshot",
		windows: "snapshot",
		multiplier: "snapshot"
	});

	// The state that actually ships: the real snapshot carries prices only, so the
	// schedule is the code's own assumption and the panel must warn about it.
	const snapshotOnly = resolvePricing(undefined, { models: PRICING.models });
	assert.equal(snapshotOnly.sources.models, "snapshot");
	assert.equal(snapshotOnly.sources.windows, "default", "the shipped snapshot has no windows");
	assert.equal(snapshotOnly.sources.multiplier, "default");

	// Nothing at all.
	assert.deepEqual(resolvePricing(undefined, undefined).sources, {
		models: "default",
		windows: "default",
		multiplier: "default"
	});
});

test("a configured override counts as authoritative, not as a fallback", () => {
	const resolved = resolvePricing(undefined, { models: PRICING.models }, {
		peakWindows: [{ startHour: 5, endHour: 6, label: "自定" }],
		peakMultiplier: 1.5
	});
	assert.equal(resolved.sources.windows, "live", "a user-supplied window is not an assumption");
	assert.equal(resolved.sources.multiplier, "live");
});

test("resolvePricing survives empty or malformed layers", () => {
	const resolved = resolvePricing(undefined, undefined);
	assert.deepEqual(resolved.models, []);
	assert.equal(resolved.peakMultiplier, 2, "sane default rather than 0");
	assert.deepEqual(resolved.peakWindows, [
		{ startHour: 9, endHour: 12, label: "上午高峰" },
		{ startHour: 14, endHour: 18, label: "下午高峰" }
	]);
});

test("a live window change moves the peak window", () => {
	const moved = { ...PRICING, peakWindows: [{ startHour: 10, endHour: 11, label: "新窗口" }] };
	assert.equal(pricingStatus(bj(2026, 1, 5, 9, 30), moved).peak, false);
	assert.equal(pricingStatus(bj(2026, 1, 5, 10, 30), moved).peak, true);
	assert.equal(pricingStatus(bj(2026, 1, 5, 10, 30), moved).windowLabel, "新窗口");
});

test("a live multiplier change moves the badge", () => {
	const tripled = { ...PRICING, peakMultiplier: 3 };
	assert.equal(pricingStatus(bj(2026, 1, 5, 10, 0), tripled).multiplier, 3);
	assert.equal(pricingStatus(bj(2026, 1, 5, 20, 0), tripled).multiplier, 1, "off-peak stays ×1");
});

test("the status prices the selected model, and defaults to the first", () => {
	const both = {
		...PRICING,
		models: [
			PRICING.models[0],
			{
				key: "pro",
				name: "deepseek-v4-pro",
				unit: "百万tokens",
				offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
				peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 }
			}
		]
	};
	const peakPro = pricingStatus(bj(2026, 1, 5, 10, 0), both, { model: "deepseek-v4-pro" });
	assert.deepEqual(peakPro.model.rates, { cacheHit: 0.3, cacheMiss: 9, output: 27 });
	const offPeakPro = pricingStatus(bj(2026, 1, 5, 20, 0), both, { model: "deepseek-v4-pro" });
	assert.deepEqual(offPeakPro.model.rates, { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 });
	assert.equal(pricingStatus(bj(2026, 1, 5, 10, 0), both).model.name, "deepseek-flash", "first row by default");
	assert.equal(pricingStatus(bj(2026, 1, 5, 10, 0), both, { model: "nope" }).model.name, "deepseek-flash");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

test("modelEntry resolves by request name and by key", () => {
	const pricing = {
		models: [
			{ key: "flash", name: "deepseek-flash" },
			{ key: "v4-pro", name: "deepseek-v4-pro" }
		]
	};
	assert.equal(modelEntry(pricing, "deepseek-flash").key, "flash");
	assert.equal(modelEntry(pricing, "deepseek-v4-pro").key, "v4-pro");
	assert.equal(modelEntry(pricing, "flash").key, "flash");
	assert.equal(modelEntry(pricing, "unknown").key, "flash", "unknown falls back to the first row");
	assert.equal(modelEntry({ models: [] }, "flash"), undefined);
});

test("formatDuration covers seconds, minutes, hours, and days", () => {
	assert.equal(formatDuration(45000), "45秒");
	assert.equal(formatDuration(252000), "4分12秒");
	assert.equal(formatDuration(7380000), "2小时03分");
	assert.equal(formatDuration(829320000), "9天14小时", "a long holiday gap reads in days");
	assert.equal(formatDuration(-5000), "0秒");
});

test("multiplierText renders the badge", () => {
	assert.equal(multiplierText(2), "×2");
	assert.equal(multiplierText(1), "×1");
	assert.equal(multiplierText(1.5), "×1.5");
});

test("the shipped holiday table has the documented 33 statutory days", () => {
	const calendar = buildHolidayCalendar();
	const statutory = [...calendar.values()].filter((e) => e.adjusted !== true);
	assert.equal(statutory.length, 33, "3+9+3+5+3+3+7 statutory days in 2026");
	assert.equal(calendar.get("2026-01-01").name, "元旦");
	assert.equal(calendar.get("2026-01-03").name, "元旦");
	assert.equal(calendar.get("2026-01-04").adjusted, true, "Jan 4 is an adjusted workday, not a holiday");
});
