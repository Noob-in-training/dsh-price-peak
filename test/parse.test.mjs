/**
 * Tests for the official pricing-page extractor.
 *
 * The fixture is the real page captured from api-docs.deepseek.com, so these
 * tests fail if the markup or wording drifts in a way the parser cannot follow —
 * which is exactly the signal that the live-update path needs attention.
 *
 * Run: node --test dsh-price-peak/test/parse.test.mjs
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { htmlToText, parseAmount, parseAndValidate, parsePricingPage } from "../lib/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "fixtures", "pricing-zh-cn.html"), "utf8");

test("htmlToText turns table structure into pipe-delimited text", () => {
	const text = htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>");
	assert.equal(text, "a|b\nc|d");
});

test("htmlToText drops script and style bodies", () => {
	const text = htmlToText("<p>keep</p><script>var x = 'drop';</script><style>.a{}</style>");
	assert.equal(text, "keep");
});

test("parseAmount reads currency-suffixed and bare numbers", () => {
	assert.equal(parseAmount("0.02元"), 0.02);
	assert.equal(parseAmount("4.5元"), 4.5);
	assert.equal(parseAmount("1元"), 1);
	assert.equal(parseAmount("$13.50"), 13.5);
	assert.equal(parseAmount("27"), 27);
	assert.equal(parseAmount("不支持"), undefined);
	assert.equal(parseAmount(undefined), undefined);
});

test("the real page yields both models with all three rates", () => {
	const doc = parseAndValidate(fixture, { sourceUrl: "fixture" });
	assert.notEqual(doc, undefined, "extractor recovered nothing from the fixture");
	assert.equal(doc.models.length, 2, "expected exactly the two shipped model columns");

	const flash = doc.models.find((m) => m.name === "deepseek-flash");
	const pro = doc.models.find((m) => m.name === "deepseek-v4-pro");
	assert.notEqual(flash, undefined, "deepseek-flash column missing");
	assert.notEqual(pro, undefined, "deepseek-v4-pro column missing");

	assert.deepEqual(flash.offPeak, { cacheHit: 0.02, cacheMiss: 1, output: 4 });
	assert.deepEqual(flash.peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 });
	assert.deepEqual(pro.offPeak, { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 });
	assert.deepEqual(pro.peak, { cacheHit: 0.3, cacheMiss: 9, output: 27 });
	assert.equal(flash.unit, "百万tokens");
});

test("the peak windows and multiplier come from the page's own note", () => {
	const doc = parseAndValidate(fixture, { sourceUrl: "fixture" });
	assert.deepEqual(doc.peakWindows, [
		{ startHour: 9, endHour: 12, label: "上午高峰" },
		{ startHour: 14, endHour: 18, label: "下午高峰" }
	]);
	assert.equal(doc.peakMultiplier, 2, "note says off-peak is half of peak, so peak is ×2");
	assert.match(doc.ruleText, /北京时间周一至周五/, "rule sentence should be captured verbatim");
	assert.match(doc.ruleText, /不含中国法定节假日/);
});

test("every peak rate is exactly the stated multiple of its off-peak rate", () => {
	// Cross-checks the parse against the page's own arithmetic claim, which is a
	// stronger check than comparing to numbers copied into the test.
	const doc = parseAndValidate(fixture, { sourceUrl: "fixture" });
	for (const model of doc.models) {
		for (const field of ["cacheHit", "cacheMiss", "output"]) {
			assert.equal(
				model.peak[field],
				model.offPeak[field] * doc.peakMultiplier,
				`${model.name}.${field}: peak should be ×${doc.peakMultiplier} off-peak`
			);
		}
	}
});

test("the footer's adjusted-workday trap is visible in the page text", () => {
	// The page excludes 法定节假日 but says nothing about 调休上班日, which stay
	// peak. Asserting the wording is present guards the assumption in core.js.
	const text = htmlToText(fixture);
	assert.match(text, /不含中国法定节假日/);
	assert.doesNotMatch(text, /调休/, "the page never mentions 调休; core.js owns that rule");
});

test("an unrelated page recovers nothing", () => {
	assert.equal(parseAndValidate("<html><body><p>hello</p></body></html>"), undefined);
	assert.equal(parseAndValidate(""), undefined);
});

test("a page with prices but no schedule keeps the prices only", () => {
	const html = `<table>
		<tr><td>模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
		<tr><td>输出长度</td><td>384K</td><td>384K</td></tr>
		<tr><td>价格</td><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
		<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
		<tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
		<tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>
		<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
		<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
		<tr><td>并发限制</td><td>2500</td><td>500</td></tr>
	</table>`;
	const doc = parseAndValidate(html, { sourceUrl: "synthetic" });
	assert.notEqual(doc, undefined);
	assert.equal(doc.models.length, 2);
	assert.equal(doc.peakWindows, undefined, "no note on this page, so no windows");
	assert.equal(doc.peakMultiplier, undefined, "and no multiplier");
	assert.deepEqual(doc.models[0].peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 });
});

test("a partially parsed model is dropped rather than shown wrong", () => {
	// Prices for one metric only: the model must not appear half-populated.
	const html = `<table>
		<tr><td>模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
		<tr><td>输出长度</td><td>384K</td><td>384K</td></tr>
		<tr><td>价格</td><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
		<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
		<tr><td>并发限制</td><td>2500</td><td>500</td></tr>
	</table>`;
	const doc = parseAndValidate(html, { sourceUrl: "synthetic" });
	assert.equal(doc, undefined, "nothing complete was recovered");
});

test("a refused multiplier is dropped instead of inverting the display", () => {
	const html = `<p>空闲时段价格为高峰时段价格的 0.5 倍</p>`;
	const doc = parsePricingPage(html, { sourceUrl: "synthetic" });
	assert.equal(doc.peakMultiplier, 0.5);
	assert.equal(parseAndValidate(html, { sourceUrl: "synthetic" }), undefined);
});

test("an ambiguous table is refused and says why", () => {
	// The same metric twice means the table no longer has the shape this parser
	// assumes. The document is dropped, and the reason is handed to the caller so the
	// panel can say "the page changed shape" rather than "nothing usable found" — the
	// reason used to be written onto the document that was then thrown away.
	//
	// The page carries a schedule note on purpose: `parsePricingPage` reports nothing
	// at all for a page that yields no prices AND no schedule, so an ambiguity is only
	// observable on a page that would otherwise have parsed.
	const html = `<p>北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段。空闲时段价格为高峰时段价格的一半。</p>
	<table>
		<tr><td>模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
		<tr><td>价格</td><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
		<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
		<tr><td>百万tokens输出</td><td>空闲时段</td><td>5元</td><td>14元</td></tr>
		<tr><td>高峰时段</td><td>9元</td><td>28.0元</td></tr>
		<tr><td>并发限制</td><td>2500</td><td>500</td></tr>
	</table>`;
	const reasons = [];
	assert.equal(parseAndValidate(html, { sourceUrl: "synthetic", onReject: (why) => reasons.push(why) }), undefined);
	assert.equal(reasons.length, 1, "exactly one refusal, one reason");
	assert.match(reasons[0], /ambiguous price rows/);
	assert.match(reasons[0], /output/, "and it names the metric that repeated");

	// A page with nothing to say is not a "refusal": there is no reason to report.
	const silent = [];
	assert.equal(parseAndValidate("<p>hello</p>", { onReject: (why) => silent.push(why) }), undefined);
	assert.deepEqual(silent, [], "an unrelated page states no reason");

	// A caller that passes no callback is unaffected.
	assert.equal(parseAndValidate(html, { sourceUrl: "synthetic" }), undefined);
});
