/**
 * Preview the panel's numbers without installing anything.
 *
 * Prints the current state, then a rendered day, then the notable days of 2026 —
 * including the ones that are easy to get wrong. Useful both as a sanity check
 * before installation and as the fastest way to see whether DeepSeek has changed
 * its schedule.
 *
 * Usage:
 *   node preview.mjs                      current state + a sample of 2026
 *   node preview.mjs --at 2026-02-14T10:00 Beijing time to inspect
 *   node preview.mjs --day 2026-01-05     every hour of one Beijing day
 *   node preview.mjs --fetch              refresh from the official page first
 */
import { formatDuration, pricingStatus, resolvePricing, BEIJING_OFFSET_MS } from "./lib/core.js";
import { PRICING_URL, parseAndValidate } from "./lib/parse.js";
import { SNAPSHOT, SNAPSHOT_CAPTURED_AT } from "./lib/snapshot.js";

/** `2026-01-05T10:30` in Beijing, as epoch ms. */
function parseBeijing(text) {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(text);
	if (match === null) throw new Error(`expected YYYY-MM-DD[THH:MM] in Beijing time, got "${text}"`);
	return Date.UTC(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		Number(match[4] ?? 0),
		Number(match[5] ?? 0)
	) - BEIJING_OFFSET_MS;
}

const args = process.argv.slice(2);
const flag = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};

/** Layer a live fetch over the snapshot when asked; otherwise run snapshot-only. */
async function loadPricing(wantFetch) {
	if (!wantFetch) return { pricing: resolvePricing(undefined, SNAPSHOT, {}), source: `bundled snapshot (${SNAPSHOT_CAPTURED_AT})` };
	for (const url of [PRICING_URL]) {
		try {
			const response = await fetch(url, {
				headers: { accept: "text/html", "user-agent": "dsh-price-peak-preview/0.1.0" },
				signal: AbortSignal.timeout(15000)
			});
			if (!response.ok) {
				console.error(`  ${url} -> HTTP ${response.status}`);
				continue;
			}
			const live = parseAndValidate(await response.text(), { sourceUrl: url, fetchedAt: Date.now() });
			if (live === undefined) {
				console.error(`  ${url} -> no usable table`);
				continue;
			}
			return { pricing: resolvePricing(live, SNAPSHOT, {}), source: url };
		} catch (error) {
			console.error(`  ${url} -> ${error}`);
		}
	}
	console.error("  falling back to the bundled snapshot");
	return { pricing: resolvePricing(undefined, SNAPSHOT, {}), source: `bundled snapshot (${SNAPSHOT_CAPTURED_AT})` };
}

/** One aligned line describing one instant. */
function line(epochMs, pricing) {
	const s = pricingStatus(epochMs, pricing);
	const badge = `×${s.multiplier}`;
	const next = `→ ×${s.peak ? 1 : 2} in ${formatDuration(s.msUntilTransition)}`;
	const holiday = s.holidayName === undefined ? "" : ` [${s.holidayName}]`;
	return `  ${s.dateKey} ${s.beijing.clock.slice(0, 5)}  ${badge.padEnd(3)} ${s.peak ? "高峰" : "空闲"}  ${s.reason.padEnd(9)}${holiday.padEnd(6)} ${next}`;
}

const { pricing, source } = await loadPricing(args.includes("--fetch"));

console.log("DeepSeek 峰谷价格 · 预览");
console.log(`  数据来源: ${source}`);
console.log(`  高峰倍率: ×${pricing.peakMultiplier}   高峰时段: ${pricing.peakWindows.map((w) => `${w.startHour}:00-${w.endHour}:00`).join(" / ")} (北京时间)`);
console.log(`  模型: ${pricing.models.map((m) => m.name).join(", ") || "(none)"}`);
if (pricing.ruleText !== undefined) console.log(`  规则: ${pricing.ruleText}`);
console.log();

const at = flag("--at");
if (at !== undefined) {
	console.log("指定时刻:");
	console.log(line(parseBeijing(at), pricing));
	process.exit(0);
}

const day = flag("--day");
if (day !== undefined) {
	const start = parseBeijing(day);
	console.log(`全天逐小时 (${day}, 北京时间):`);
	for (let hour = 0; hour < 24; hour += 1) console.log(line(start + hour * 3600000, pricing));
	process.exit(0);
}

console.log("当前:");
console.log(line(Date.now(), pricing));
console.log();

console.log("2026 年需要特别注意的日子:");
const notable = [
	["2026-01-01T10:00", "元旦假期中的工作日"],
	["2026-01-04T10:00", "调休上班的周日 —— 应为高峰"],
	["2026-02-14T10:00", "调休上班的周六 —— 应为高峰"],
	["2026-02-14T18:30", "紧接春节，下一次高峰在 10 天后"],
	["2026-02-17T10:00", "春节假期中的工作日 —— 应为空闲"],
	["2026-05-05T15:00", "劳动节最后一天 —— 应为空闲"],
	["2026-09-25T10:00", "中秋节 —— 应为空闲"],
	["2026-10-01T10:00", "国庆节 —— 应为空闲"],
	["2026-10-10T10:00", "调休上班的周六 —— 应为高峰"]
];
for (const [when, why] of notable) {
	console.log(`\n  ${why}`);
	console.log(line(parseBeijing(when), pricing));
}
