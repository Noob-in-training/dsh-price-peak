/**
 * Generate a standalone HTML preview of the dock entry.
 *
 * The real widget lives in a browser bundle that needs the DSH module system, a
 * React runtime, and the host route — none of which exist outside the App. So this
 * page reproduces the *rendering conditions* faithfully instead of mocking the
 * widget: the markup and classes come from the actual `component tree` the React
 * code produces (verified by `test/client-bundle.test.mjs`), and the design tokens
 * below are copied verbatim from the installed theme bundle so the colours, radii,
 * and spacing match the live App.
 *
 * Token provenance (read from `@deepseek-ai/dsh-client-ui-theme/lib/client.js`
 * and `dsh-client-ui-conversation/lib/client.js`):
 *   - light/dark alias values, the static palette, radii, and the menu surface
 *   - composer geometry: card max-width `min(calc(100% - 16px), 952px)`,
 *     dock inset 8px, side clearance 16px, stack gap 6px
 *
 * Usage: node preview-ui.mjs [--out path] [--open]
 */
import { readFileSync, writeFileSync } from "node:fs";

import { SNAPSHOT, SNAPSHOT_CAPTURED_AT } from "./lib/snapshot.js";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stylesSource = readFileSync(join(here, "src", "client-styles.js"), "utf8");
const templateSource = readFileSync(join(here, "src", "client.template.js"), "utf8");

/** The widget's own stylesheet, taken from the module that owns it. */
function widgetCss() {
	const match = /const css = `([\s\S]*?)`;/.exec(stylesSource);
	if (match === null) throw new Error("preview-ui: no `const css = `…`;` found in src/client-styles.js");
	return match[1];
}

/**
 * The class-name map, taken from the widget source.
 *
 * It is extracted rather than rewritten so a renamed class shows up as a broken
 * preview instead of a preview that quietly lies about the real markup.
 */
function classMap() {
	const block = /const c = \{([\s\S]*?)\n\t\};/.exec(templateSource);
	if (block === null) throw new Error("preview-ui: could not find the class map in src/client.template.js");
	const map = {};
	for (const line of block[1].split("\n")) {
		const pair = /^\s*([a-zA-Z]+):\s*"([^"]+)",?\s*$/.exec(line);
		if (pair !== null) map[pair[1]] = pair[2];
	}
	const required = ["dock", "bar", "badge", "peak", "off", "unknown", "clock", "reason", "next",
		"dot", "dotStale", "dotError", "toggle", "panel", "row", "head", "rule", "warn", "err"];
	const missing = required.filter((key) => map[key] === undefined);
	if (missing.length > 0) throw new Error(`preview-ui: class map is missing ${missing.join(", ")}`);
	return map;
}

/**
 * A status document shaped exactly like the host route's response, so the preview
 * shows the same numbers the real panel will. Times are Beijing wall clock.
 */
function state(multiplier, clock, reason, windowLabel, nextLabel, nextIn, extra = {}) {
	const peak = multiplier > 1;
	return {
		peak,
		multiplier,
		dateKey: extra.dateKey ?? "2026-10-08",
		beijing: { clock },
		reason,
		windowLabel,
		nextLabel,
		nextIn,
		nextPeak: !peak,
		adjustedWorkday: extra.adjustedWorkday === true,
		model: SNAPSHOT.models[0].name,
		sources: extra.sources,
		// From the shipped snapshot, not typed here: a preview that hardcodes prices
		// drifts from the snapshot it depicts, and "no price number appears in the
		// logic" is a claim this repository makes.
		rows: RATE_ROWS,
		data: extra.data ?? { live: true, stale: false, ageText: "12分", refreshMinutes: 360 }
	};
}

/** Rate rows for the first snapshot model, read from the snapshot itself. */
const RATE_ROWS = (() => {
	const model = SNAPSHOT.models[0];
	if (model === undefined) return [];
	return [
		["输入·缓存命中", `${model.offPeak.cacheHit} / ${model.peak.cacheHit} 元`],
		["输入·缓存未命中", `${model.offPeak.cacheMiss} / ${model.peak.cacheMiss} 元`],
		["输出", `${model.offPeak.output} / ${model.peak.output} 元`]
	];
})();

/** Model heading, also derived from the snapshot. */
const MODEL_HEADING = (() => {
	const model = SNAPSHOT.models[0];
	return model === undefined ? "—" : `${model.name} · ${model.version}`;
})();

const SCENARIOS = [
	{
		title: "高峰时段 —— ×2",
		note: "工作日上午 10:24。徽标转为警示色，倒计时指向 12:00 的空闲。",
		state: state(2, "10:24:07", "工作日高峰时段", "上午高峰", "距空闲", "1小时35分"),
		open: false
	},
	{
		title: "空闲时段 —— ×1",
		note: "国庆假期内的周一。倍率回到 ×1，倒计时指向假期结束后的第一个高峰。",
		state: state(1, "02:56:41", "国庆节假期", "全天空闲", "距高峰", "3天6小时", { dateKey: "2026-10-05" }),
		open: false
	},
	{
		title: "展开详情",
		note: "点「详情」后的样子：单价表（空闲 / 高峰）、峰谷时段、数据来源与刷新间隔。",
		state: state(2, "10:24:07", "工作日高峰时段", "上午高峰", "距空闲", "1小时35分"),
		open: true
	},
	{
		title: "数据过期 —— 圆点转黄",
		note: "抓取失败时不会消失：保留上次结果，标注可能过期，并写明原因。",
		state: state(1, "22:10:12", "工作日非高峰时段", "夜间空闲", "距高峰", "10小时50分", {
			dateKey: "2026-10-08",
			data: { live: true, stale: true, ageText: "2天4小时", refreshMinutes: 360, lastError: "fetch https://api-docs.deepseek.com/... failed: network timeout" }
		}),
		open: true
	},
	{
		title: "来源混用 —— 价格来自快照，时段来自页面",
		note: "价格表解析失败但页面注释解析成功。这是最危险的状态：数据看起来是当前的，实际是两个来源拼的。",
		state: state(3, "10:24:07", "工作日高峰时段", "上午高峰", "距空闲", "1小时35分", {
			sources: { models: "snapshot", windows: "live", multiplier: "live" }
		}),
		open: true
	},
	{
		title: "峰谷时段退化为代码默认",
		note: "连页面注释都没解析出来时，时段与倍率用的是代码里的默认值 —— 官方调整后不会自动跟上，界面明说这一点。",
		state: state(2, "10:24:07", "工作日高峰时段", "上午高峰", "距空闲", "1小时35分", {
			sources: { models: "snapshot", windows: "default", multiplier: "default" }
		}),
		open: true
	},
	{
		title: "接口不可用 —— ×?",
		note: "宿主路由未注册或首次轮询失败时的降级形态，面板仍然占位而不是闪没。",
		state: { failed: true },
		open: false
	}
];

/** Escape text for HTML interpolation. */
const esc = (text) => String(text)
	.replace(/&/g, "&amp;")
	.replace(/</g, "&lt;")
	.replace(/>/g, "&gt;")
	.replace(/"/g, "&quot;");

/**
 * Reproduce the component's provenance line. Kept in step with
 * `sourceText()` in src/client.template.js: when the layers disagree the row
 * names each field's source instead of pretending there is one.
 */
function sourceText(s) {
	if (s.sources === undefined) return "官方定价页";
	const labels = { live: "官方定价页", snapshot: "内置快照", default: "代码默认" };
	const parts = [
		["价格", s.sources.models],
		["峰谷时段", s.sources.windows],
		["倍率", s.sources.multiplier]
	].filter(([, value]) => value !== undefined);
	if (parts.length === 0) return "官方定价页";
	if (new Set(parts.map(([, value]) => value)).size <= 1) return labels[parts[0][1]] ?? "—";
	return parts.map(([label, value]) => `${label}：${labels[value] ?? value}`).join("；");
}

/** One `label: value` row. */
function row(c, label, value, className = "") {
	return `<div class="${c.row}"><span>${esc(label)}</span><span class="${className}">${esc(value)}</span></div>`;
}

/** The dock entry markup for one scenario. */
function renderDock(c, scenario) {
	const s = scenario.state;
	if (s.failed === true) {
		return `<div class="${c.dock}"><div class="${c.bar}">
	<span class="${c.badge} ${c.unknown}">×?</span>
	<span class="${c.clock}" title="北京时间">北京 —:—:—</span>
	<span class="${c.reason}">价格状态不可用</span>
	<span class="${c.dotError}" title="HTTP 500"></span>
	<button type="button" class="${c.toggle}">详情</button>
</div></div>`;
	}

	const tone = s.peak ? c.peak : c.off;
	const dot = s.data.lastError !== undefined ? c.dotStale : s.data.stale ? c.dotStale : c.dot;
	const bar = `<div class="${c.bar}">
	<span class="${c.badge} ${tone}">×${s.multiplier}</span>
	<span class="${c.clock}" title="北京时间">北京 ${esc(s.beijing.clock)}</span>
	<span class="${c.reason}">${esc(s.reason)}${s.windowLabel.length > 0 ? ` · ${esc(s.windowLabel)}` : ""}</span>
	<span class="${c.next}">${esc(s.nextLabel)} ${esc(s.nextIn)}</span>
	<span class="${dot}" title="${s.data.stale ? "数据可能已过期" : "数据已同步"}"></span>
	<button type="button" class="${c.toggle}">${scenario.open ? "收起" : "详情"}</button>
</div>`;

	if (!scenario.open) return `<div class="${c.dock}">${bar}</div>`;

	const rows = [
		row(c, "当前倍率", `×${s.multiplier}　${s.peak ? "高峰时段" : "空闲时段"}`),
		row(c, "北京时间", `${s.beijing.clock}（${s.dateKey}）`),
		row(c, `${s.nextLabel}（${s.nextPeak ? "×2" : "×1"}）`, s.nextIn),
		row(c, "高峰时段", "09:00-12:00、14:00-18:00"),
		row(c, "单价单位", "百万tok（空闲 / 高峰，元）"),
		`<div class="${c.head}">${esc(MODEL_HEADING)}</div>`,
		...s.rows.map(([label, value]) => row(c, label, value)),
		row(c, "数据来源", sourceText(s)),
		row(c, "上次成功更新", `${s.data.ageText}前`, s.data.stale ? c.warn : ""),
		row(c, "刷新间隔", `${s.data.refreshMinutes} 分钟`)
	];
	const notices = [];
	if (s.sources !== undefined) {
		const assumed = [
			s.sources.windows === "default" ? "峰谷时段" : undefined,
			s.sources.multiplier === "default" ? "倍率" : undefined
		].filter(Boolean);
		if (assumed.length > 0) {
			notices.push(`<div class="${c.rule} ${c.warn}">${esc(assumed.join("、"))}无法从页面确认，正在使用内置默认值；官方调整后这里不会自动跟上。</div>`);
		}
		if (s.sources.models === "snapshot") {
			notices.push(`<div class="${c.rule} ${c.warn}">价格表来自内置快照，不是本次抓取的结果。</div>`);
		}
	}
	if (s.data.lastError !== undefined) {
		notices.push(`<div class="${c.rule} ${c.err}">抓取失败：${esc(s.data.lastError)}</div>`);
	}
	notices.push(`<div class="${c.rule}">北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。</div>`);
	if (s.adjustedWorkday) {
		notices.push(`<div class="${c.rule}">今天是调休上班日：按官方规则（仅排除法定节假日）仍按工作日计算峰谷。</div>`);
	}
	return `<div class="${c.dock}">${bar}<div class="${c.panel}">${rows.join("")}${notices.join("")}</div></div>`;
}

/**
 * The composer card the dock sits above, drawn with the real geometry tokens so
 * the vertical rhythm and the width alignment are honest.
 */
function renderComposer() {
	return `<div class="composer">
	<div class="composerCard">
		<div class="composerHint">给 DeepSeek 发消息…</div>
		<div class="composerRow"><span class="composerPill">deepseek-flash</span><span class="composerSpacer"></span><span class="composerSend">↑</span></div>
	</div>
</div>`;
}

const c = classMap();

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-price-peak 界面预览</title>
<style>
/* ── Theme tokens ─────────────────────────────────────────────────────────────
   Copied verbatim from @deepseek-ai/dsh-client-ui-theme/lib/client.js. Light is
   the default; the dark block mirrors what the App applies under [data-theme]. */
:root{
	--dsw-static-neutral-bluish-00:#fff; --dsw-static-neutral-bluish-50:#f9fafb;
	--dsw-static-neutral-bluish-60:#f5f6f7; --dsw-static-neutral-bluish-75:#f1f3f5;
	--dsw-static-neutral-bluish-100:#ebeef2; --dsw-static-neutral-bluish-150:#e9ecf2;
	--dsw-static-neutral-bluish-200:#e1e5ee; --dsw-static-neutral-bluish-300:#cfd3d6;
	--dsw-static-neutral-bluish-400:#adb2b8; --dsw-static-neutral-bluish-500:#979da6;
	--dsw-static-neutral-bluish-600:#81858c; --dsw-static-neutral-bluish-700:#61666b;
	--dsw-static-neutral-bluish-750:#43454a; --dsw-static-neutral-bluish-850:#212123;
	--dsw-static-neutral-bluish-875:#1a1c20; --dsw-static-neutral-bluish-950:#16181d;
	--dsw-static-neutral-bluish-1000:#0f1115;
	--dsw-static-green-500:#22c55e; --dsw-static-amber-500:#f59e0b;
	--dsw-static-red-400:#f87171; --dsw-static-red-600:#dc2626;
	--dsw-static-neutral-300:#d4d4d4; --dsw-static-neutral-600:#545557;

	--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-60);
	--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-00);
	--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-00);
	--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-150);
	--dsw-alias-border-l1:#0000000a;
	--dsw-alias-interactive-bg-hover:#2631480f;
	--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);
	--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-950);
	--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);
	--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);
	--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);
	--dsw-alias-state-success-primary:var(--dsw-static-green-500);
	--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);
	--dsw-alias-state-error-primary:var(--dsw-static-red-600);
	--dsw-alias-state-idle-primary:var(--dsw-static-neutral-300);
	--dsw-specific-menu:#f8f9faf0;
	--dsw-menu-backdrop-filter:blur(40px) saturate(150%);
	--dsw-radius-xs:4px; --dsw-radius-sm:8px; --dsw-radius-md:12px;
	--dsw-radius-lg:16px; --dsw-radius-xl:20px; --dsw-radius-panel:28px;
	--dsw-elevation-panel:0 0 0 .5px #00000014, 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005;

	/* Composer geometry, from dsh-client-ui-conversation. */
	--dsh-chat-content-width:min(calc(100% - 32px), 920px);
	--dsh-composer-card-max-width:min(calc(100% - 16px), 952px);
	--dsh-composer-dock-inset:8px;
	--dsh-composer-side-clearance:16px;
	--dsh-composer-stack-gap:6px;
}
:root[data-theme="dark"]{
	--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);
	--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-875);
	--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-850);
	--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-700);
	--dsw-alias-border-l1:#ffffff0f;
	--dsw-alias-interactive-bg-hover:#ffffff14;
	--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);
	--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);
	--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);
	--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);
	--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);
	--dsw-alias-state-error-primary:var(--dsw-static-red-400);
	--dsw-alias-state-idle-primary:var(--dsw-static-neutral-600);
	--dsw-specific-menu:#303136f0;
}

*{box-sizing:border-box}
body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
	font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;
	padding:28px 20px 80px}
.wrap{max-width:1020px;margin:0 auto}
h1{font-size:19px;font-weight:650;margin:0 0 6px}
.lede{color:var(--dsw-alias-label-secondary);margin:0 0 4px}
.provenance{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7;margin:0 0 22px}
.bar{display:flex;gap:10px;align-items:center;margin:0 0 24px;flex-wrap:wrap}
button.ctl{font:inherit;font-size:13px;padding:6px 13px;border-radius:999px;cursor:pointer;
	border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
	color:var(--dsw-alias-label-primary)}
button.ctl:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hint{color:var(--dsw-alias-label-tertiary);font-size:12px}
section{margin:0 0 30px}
h2{font-size:14px;font-weight:600;margin:0 0 3px}
.note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0 0 10px}
/* A stand-in for the conversation column, so the dock is seen where it lives. */
.stage{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);
	background:var(--dsw-alias-bg-base);padding:26px 0 30px}
.composer{width:var(--dsh-chat-content-width);margin:0 auto;display:flex;flex-direction:column;
	gap:var(--dsh-composer-stack-gap)}
.composerCard{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);
	background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);
	padding:12px 14px 8px;display:flex;flex-direction:column;gap:10px}
.composerHint{color:var(--dsw-alias-label-caption);font-size:13px}
.composerRow{display:flex;align-items:center;gap:8px}
.composerPill{font-size:11px;color:var(--dsw-alias-label-secondary);
	border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 8px}
.composerSpacer{flex:1}
.composerSend{width:24px;height:24px;border-radius:999px;display:grid;place-items:center;
	background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px}
${widgetCss()}
</style>
</head>
<body>
<div class="wrap">
	<h1>dsh-price-peak · 界面预览</h1>
	<p class="lede">输入框上方那条信息条的实际样式，以及展开后的详情面板。</p>
	<p class="provenance">
		配色与圆角取自已安装的 <code>@deepseek-ai/dsh-client-ui-theme</code>，输入框几何值取自
		<code>dsh-client-ui-conversation</code>（卡片 <code>min(calc(100% - 16px), 952px)</code>、
		内缩 8px）。标记由组件真实的类名映射生成，改类名会让这里显示异常而不是悄悄失真。
		生成时间：${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC；价格取自内置快照（${SNAPSHOT_CAPTURED_AT}）
	</p>
	<div class="bar">
		<button class="ctl" id="theme">切换深色 / 浅色</button>
		<span class="hint">真机里跟随你的主题设置；这里默认浅色。</span>
	</div>
${SCENARIOS.map((scenario) => `	<section>
		<h2>${esc(scenario.title)}</h2>
		<p class="note">${esc(scenario.note)}</p>
		<div class="stage">
			${renderComposer()}
			${renderDock(c, scenario)}
		</div>
	</section>`).join("\n")}
</div>
<script>
document.getElementById("theme").addEventListener("click", () => {
	const root = document.documentElement;
	root.dataset.theme = root.dataset.theme === "dark" ? "" : "dark";
});
</script>
</body>
</html>
`;

const outFlag = process.argv.indexOf("--out");
const target = outFlag === -1 ? join(here, "preview-ui.html") : process.argv[outFlag + 1];
writeFileSync(target, html, "utf8");
console.log(`preview-ui: wrote ${target} (${Buffer.byteLength(html)} bytes, ${SCENARIOS.length} scenarios)`);

if (process.argv.includes("--open")) {
	// `open` on macOS, `xdg-open` on Linux, `start` on Windows. Failing to launch a
	// browser is not an error: the path is printed either way.
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	const launched = spawnSync(opener, [target], { stdio: "ignore", shell: process.platform === "win32" });
	console.log(launched.status === 0
		? "preview-ui: opened in your browser"
		: `preview-ui: could not open automatically — open file://${target}`);
} else {
	console.log(`preview-ui: open it in a browser — file://${target}`);
}
