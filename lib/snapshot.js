/**
 * Bundled pricing snapshot: the seed for the first run and the fallback whenever
 * a refresh fails.
 *
 * These are the values the official page carried when this file was written. They
 * are intentionally NOT the source of truth — `index.js` refreshes the live page
 * and `resolvePricing` layers whatever it recovers over this document, field by
 * field. A stale snapshot therefore degrades to slightly old numbers rather than
 * to no display at all.
 *
 * The peak windows and the multiplier are deliberately absent: the live page
 * supplies them and `core.js` defaults are correct, so shipping a second copy
 * here would only create something else to drift.
 */

/** When these numbers were captured, shown in the panel's detail view. */
const SNAPSHOT_CAPTURED_AT = "2026-10-04";

const SNAPSHOT = {
	models: [
		{
			key: "flash",
			name: "deepseek-flash",
			version: "DeepSeek-V4.1-Flash",
			unit: "百万tokens",
			offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
			peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
		},
		{
			key: "v4-pro",
			name: "deepseek-v4-pro",
			version: "DeepSeek-V4-Pro-0813",
			unit: "百万tokens",
			offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
			peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 }
		}
	],
	sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
	note: `snapshot captured ${SNAPSHOT_CAPTURED_AT}`
};

export { SNAPSHOT, SNAPSHOT_CAPTURED_AT };
