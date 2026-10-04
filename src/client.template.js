/**
 * dsh-price-peak — browser half.
 *
 * Renders one dock entry above the composer: the current DeepSeek price
 * multiplier (×2 in a peak window, ×1 off-peak), the Beijing wall clock the
 * schedule is defined against, and a countdown to the next change. Clicking it
 * opens the rate table and the data-freshness detail.
 *
 * The half holds no pricing or schedule logic. It polls the host route for a
 * ready status document — parsed prices, peak windows, multiplier, holiday
 * classification, next transition — so there is exactly one implementation of
 * the schedule and it always reads Beijing time. The docs site carries no CORS
 * header, so the page could not fetch it directly even if it wanted to.
 *
 * `src/client.template.js` is the Cordis form of this file; `build.mjs` wraps it
 * into `lib/client.js`, the format the module system serves.
 */

/** Host route that answers the status document. */
const STATE_PATH = "/price-peak/state";

/** Poll cadence. One second keeps the clock and the countdown honest. */
const POLL_MS = 1000;

/** Abbreviate the per-token unit for the compact badge line. */
const UNIT_SHORT = "百万tok";

/** `2` -> `×2`, `1.5` -> `×1.5`. */
function multiplierLabel(multiplier) {
	return `×${multiplier}`;
}

/** `1234567` -> `2小时03分`, `829320000` -> `9天14小时`. Mirrors core.formatDuration. */
function durationText(ms) {
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

/** Group an integer with thin separators; `95` -> `1.2` style stay untouched. */
function numberText(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	return Number.isInteger(value) ? String(value) : String(value);
}

/**
 * Turn one server response into everything the view renders.
 *
 * A missing or malformed payload yields an "unknown" view rather than throwing:
 * the dock is ambient, and a panel that vanishes on a bad poll is worse than one
 * that says it does not know.
 *
 * @param payload - the parsed JSON body, or undefined when the poll failed.
 * @param error - transport error text, when the poll itself failed.
 * @param previous - the last good view, so a transient blip still shows numbers.
 */
function toView(payload, error, previous) {
	const usable = payload !== null && typeof payload === "object" && payload.status !== undefined;
	if (!usable) {
		// Keep the last good reading and flag it as possibly out of date. Its clock
		// is then a second or two behind, which beats going blank.
		if (previous !== undefined && previous.ok === true) {
			return { ...previous, error: error ?? "no data", stale: true };
		}
		return { ok: false, error: error ?? "no data", badge: "×?", tone: "unknown" };
	}
	const status = payload.status;
	const data = payload.data ?? {};
	const pricing = payload.pricing ?? {};
	const peak = status.peak === true;
	const nextPeak = !peak;
	return {
		ok: true,
		error,
		peak,
		tone: peak ? "peak" : "off",
		badge: multiplierLabel(status.multiplier ?? (peak ? 2 : 1)),
		clock: status.beijing?.clock ?? "—:—:—",
		dateKey: status.dateKey ?? "",
		reason: status.reason ?? "",
		windowLabel: status.windowLabel ?? "",
		nextPeak,
		nextLabel: nextPeak ? "距高峰" : "距空闲",
		nextIn: durationText(status.msUntilTransition ?? 0),
		windows: Array.isArray(status.windows) ? status.windows : [],
		model: status.model,
		models: Array.isArray(pricing.models) ? pricing.models : [],
		peakWindows: Array.isArray(pricing.peakWindows) ? pricing.peakWindows : [],
		peakMultiplier: pricing.peakMultiplier,
		ruleText: pricing.ruleText,
		sourceUrl: pricing.sourceUrl,
		stale: data.stale === true,
		live: data.live === true,
		ageMs: data.ageMs,
		lastError: data.lastError,
		liveUpdateEnabled: data.liveUpdateEnabled !== false,
		refreshMinutes: data.refreshMinutes,
		adjustedWorkday: status.adjustedWorkday === true,
		holidayName: status.holidayName
	};
}

/**
 * Mount the dock entry.
 *
 * The stylesheet is inserted straight into the document rather than through a
 * `styles` builtin, and removed by the effect's disposer. That is what the shipped
 * client bundles do (none of them reaches for a styles service), and it keeps this
 * half self-contained: `slots` stays the only service it asks for.
 *
 * @param ctx - client root context with an injected `slots` service.
 * @param React - the platform React runtime (no JSX in a served bundle).
 */
function register(ctx, React) {
	const c = {
		dock: "dppDock",
		bar: "dppBar",
		badge: "dppBadge",
		peak: "dppPeak",
		off: "dppOff",
		unknown: "dppUnknown",
		clock: "dppClock",
		reason: "dppReason",
		next: "dppNext",
		dot: "dppDot",
		dotStale: "dppDotStale",
		dotError: "dppDotError",
		toggle: "dppToggle",
		panel: "dppPanel",
		row: "dppRow",
		head: "dppHead",
		rule: "dppRule",
		warn: "dppWarn",
		err: "dppErr"
	};

	ctx.effect(() => {
		const node = document.createElement("style");
		node.dataset.dshPlugin = "dsh-price-peak";
		node.textContent = css;
		document.head.appendChild(node);
		return () => node.remove();
	}, "price-peak: stylesheet");

	/** Subscribe to the host route; returns the current view on each tick. */
	function usePriceState() {
		const [view, setView] = React.useState({ ok: false, badge: "×…", tone: "unknown" });
		React.useEffect(() => {
			let alive = true;
			let inFlight = false;
			const tick = async () => {
				// Skip overlapping polls: a slow host would otherwise queue requests.
				if (inFlight) return;
				inFlight = true;
				try {
					const response = await fetch(STATE_PATH, { headers: { accept: "application/json" } });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const payload = await response.json();
					if (alive) setView((previous) => toView(payload, undefined, previous));
				} catch (error) {
					if (alive) setView((previous) => toView(undefined, String(error?.message ?? error), previous));
				} finally {
					inFlight = false;
				}
			};
			void tick();
			const timer = setInterval(() => void tick(), POLL_MS);
			// Background tabs throttle timers, so re-sync the moment the tab is
			// visible again instead of waiting for the next throttled tick.
			const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
			document.addEventListener("visibilitychange", onVisible);
			return () => {
				alive = false;
				clearInterval(timer);
				document.removeEventListener("visibilitychange", onVisible);
			};
		}, []);
		return view;
	}

	/** One `label: value` row of the detail panel. */
	function Row(props) {
		return React.createElement("div", { className: c.row },
			React.createElement("span", null, props.label),
			React.createElement("span", { className: props.className }, props.value)
		);
	}

	/** The rate table for one model, current half highlighted by the badge. */
	function rateRows(view) {
		const models = view.models.length > 0 ? view.models : (view.model === undefined ? [] : [view.model]);
		const rows = [];
		for (const model of models) {
			if (model === undefined || model === null) continue;
			rows.push(React.createElement("div", { className: c.head, key: `h-${model.name}` },
				`${model.name}${model.version === undefined ? "" : ` · ${model.version}`}`));
			for (const [field, label] of [["cacheHit", "输入·缓存命中"], ["cacheMiss", "输入·缓存未命中"], ["output", "输出"]]) {
				const off = model.offPeak?.[field];
				const peak = model.peak?.[field];
				if (off === undefined || peak === undefined) continue;
				rows.push(React.createElement(Row, {
					key: `${model.name}-${field}`,
					label,
					value: `${numberText(off)} / ${numberText(peak)} 元`
				}));
			}
		}
		return rows;
	}

	/** The dock entry: badge line always, detail panel once expanded. */
	function PricePeakDock() {
		const [open, setOpen] = React.useState(false);
		const view = usePriceState();
		const toneClass = view.tone === "peak" ? c.peak : view.tone === "off" ? c.off : c.unknown;
		const dotClass = view.error !== undefined ? c.dotError : view.stale ? c.dotStale : c.dot;

		const bar = React.createElement("div", { className: c.bar },
			React.createElement("span", { className: `${c.badge} ${toneClass}` }, view.badge),
			React.createElement("span", { className: c.clock, title: "北京时间" }, `北京 ${view.clock}`),
			React.createElement("span", { className: c.reason },
				view.ok ? `${view.reason}${view.windowLabel.length > 0 ? ` · ${view.windowLabel}` : ""}` : "价格状态不可用"),
			view.ok ? React.createElement("span", { className: c.next }, `${view.nextLabel} ${view.nextIn}`) : null,
			React.createElement("span", { className: dotClass, title: view.error ?? (view.stale ? "数据可能已过期" : "数据已同步") }),
			React.createElement("button", {
				type: "button",
				className: c.toggle,
				"aria-expanded": open,
				"aria-label": open ? "收起价格详情" : "展开价格详情",
				onClick: () => setOpen((value) => !value)
			}, open ? "收起" : "详情")
		);

		if (!open) return React.createElement("div", { className: c.dock }, bar);

		const globalRows = [
			React.createElement(Row, {
				key: "now",
				label: "当前倍率",
				value: `${view.badge}　${view.peak ? "高峰时段" : "空闲时段"}`
			}),
			React.createElement(Row, { key: "bj", label: "北京时间", value: `${view.clock}（${view.dateKey}）` }),
			React.createElement(Row, { key: "next", label: `${view.nextLabel}（${view.nextPeak ? "×2" : "×1"}）`, value: view.nextIn }),
			React.createElement(Row, {
				key: "win",
				label: "高峰时段",
				value: view.peakWindows.map((w) => `${String(w.startHour).padStart(2, "0")}:00-${String(w.endHour).padStart(2, "0")}:00`).join("、") || "—"
			}),
			React.createElement(Row, {
				key: "unit",
				label: "单价单位",
				value: `${UNIT_SHORT}（空闲 / 高峰，元）`
			})
		];

		const dataRows = [
			React.createElement(Row, {
				key: "src",
				label: "数据来源",
				value: view.liveUpdateEnabled === false ? "仅内置快照" : view.live ? "官方定价页" : "内置快照"
			}),
			React.createElement(Row, {
				key: "age",
				label: "上次成功更新",
				value: view.ageMs === undefined ? "未知" : `${durationText(view.ageMs)}前`,
				className: view.stale ? c.warn : undefined
			}),
			React.createElement(Row, {
				key: "every",
				label: "刷新间隔",
				value: view.refreshMinutes === undefined ? "—" : `${view.refreshMinutes} 分钟`
			})
		];

		const notices = [];
		if (view.error !== undefined) {
			notices.push(React.createElement("div", { className: `${c.rule} ${c.err}`, key: "poll" }, `无法读取状态：${view.error}`));
		}
		if (view.lastError !== undefined && view.lastError !== null) {
			notices.push(React.createElement("div", { className: `${c.rule} ${c.err}`, key: "fetch" }, `抓取失败：${view.lastError}`));
		} else if (view.stale) {
			notices.push(React.createElement("div", { className: `${c.rule} ${c.warn}`, key: "stale" }, "数据可能已过期，显示的是最后一次成功抓取的结果。"));
		}
		if (view.ruleText !== undefined) {
			notices.push(React.createElement("div", { className: c.rule, key: "rule" }, view.ruleText));
		}
		if (view.adjustedWorkday) {
			notices.push(React.createElement("div", { className: c.rule, key: "adj" },
				"今天是调休上班日：按官方规则（仅排除法定节假日）仍按工作日计算峰谷。"));
		}

		const panel = React.createElement("div", { className: c.panel },
			globalRows,
			rateRows(view),
			dataRows,
			notices
		);

		return React.createElement("div", { className: c.dock }, bar, panel);
	}

	ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
		name: "conversation.input.dock",
		id: "price-peak",
		// Below the Goal bar and the todo line: ambient information, not a control.
		order: 30
	}, PricePeakDock));
}

/**
 * Required services. `slots` is the whole hard dependency: the status comes from
 * the host route over a plain same-origin fetch, not from a client service.
 */
const inject = ["slots"];

/**
 * Cordis plugin body for the browser half, called once the module is activated.
 * @param ctx - client root context.
 */
function apply(ctx) {
	register(ctx, react);
}

export { apply, inject, register, toView };
