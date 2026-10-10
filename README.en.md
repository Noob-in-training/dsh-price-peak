# dsh-price-peak

**DeepSeek peak / off-peak price badge** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
one persistent line above the composer showing the current price multiplier (×2 in a
peak window, ×1 off-peak), the **Beijing time** the schedule is judged against, and a
countdown to the next change.

```
×1   Beijing 02:52 · 国庆节假期 · all-day off-peak      → ×2 in 3d 6h        ● details
```

Clicking *details* expands the rate table (off-peak / peak columns), the peak windows,
the data source, and when it was last refreshed.

**What it does not do**, so you find out now rather than after installing: it does not
count tokens, compute session cost, or read your account balance. It answers exactly one
question — **what is the price multiplier right now?** For per-message ledgers and
balances, see [J-Chien/dsh-meter](https://github.com/J-Chien/dsh-meter) or
[TwotwoPiggy/dsh-balance](https://github.com/TwotwoPiggy/dsh-balance).

> 中文文档见 [README.md](README.md)（更详细，含踩坑记录）。

---

## Three reasons it might be worth installing

Every claim below is checkable in the code.

### 1. Prices are parsed from the official page, not hardcoded

There is no price number in `lib/core.js` or `lib/parse.js`. The only constant price
table is the 42-line `lib/snapshot.js`, which ships **no** peak windows and **no**
multiplier and is used only to seed the first run and to back up a failed fetch.

When DeepSeek changes its prices, the parsed values replace the snapshot field by
field — no release needed. Fetches are conditional (`ETag` / `If-Modified-Since`), so an
unchanged page costs one `304`.

### 2. 调休 working weekends count as working days

The official rule reads "Monday to Friday, **excluding Chinese statutory holidays**".
A 调休 workday (2026-02-14 is a Saturday) is *not* a statutory holiday, so it still has
peak windows. A naive Mon–Fri test reports ×1 on a Saturday that is actually ×2 — the
wrong answer at the moment it costs you most.

```
$ node preview.mjs --at 2026-02-14T10:00
  2026-02-14 10:00  ×2  高峰  调休上班日

$ node preview.mjs --at 2026-02-17T10:00
  2026-02-17 10:00  ×1  空闲  春节假期      [春节]
```

### 3. Beijing time is isolated, so your location cannot change the answer

Every calendar read goes through a fixed UTC+8, never through local-time getters. One
test asserts that four timezones (`Asia/Shanghai`, `America/Toronto`, `UTC`,
`Pacific/Kiritimati`) produce byte-identical output for the same instant. "Beijing 02:52"
means the same thing in Toronto and in Shanghai.

---

## What happens when the fetch fails

It degrades **per field** and shows you which source answered, rather than pretending.

```
Source     prices: bundled snapshot; peak windows: official page; multiplier: official page
⚠ The price table came from the bundled snapshot, not from this fetch.
```

```
Source     prices: bundled snapshot; peak windows: code default; multiplier: code default
⚠ The peak windows and multiplier could not be confirmed from the page; built-in
  defaults are in use, and they will not follow an official change.
```

The panel never disappears: a failed fetch keeps the previous reading, turns the health
dot amber, and records the reason in the expanded view.

---

## Install

This package declares a bundle (`package.json` → `dsh.bundle.patch` → `./cordis.patch.yml`),
so install it with DSH's own plugin manager: no file copying, no hand-editing the profile's
`cordis.patch.yml`.

1. Sidebar **Plugins** → **Add plugin**.
2. Enter `dsh-price-peak` (published on the npm registry, with the mainland China mirror as
   fallback), `github:Noob-in-training/dsh-price-peak`, or the absolute path of your local clone.
3. **Install**, then **Enable now**. On a profile with HMR (the desktop profile has it) the
   bundle applies in place: the host's `include:price-peak` row turns `active` and the browser
   half registers `price-peak` into `conversation.input.dock` — no restart.
4. If the bar does not appear, refresh the page first; restart the App only if it still does not
   (a profile without HMR applies patches at startup only).

```bash
# Preflight, from a clone (the committed bundle matches src/, so no build is needed)
node build.mjs --check      # artifact/source agreement
npm test                    # 87 tests (4 of them skip until `npm run probe:setup`)
node preview.mjs --fetch    # fetch the live page and print the current state
```

Where it lands: `~/.dsh/profiles/desktop/node_modules/dsh-price-peak/`, selected in
`~/.dsh/profiles/desktop/package.json` under `dsh.profile.bundles`; any config you edit
through the Plugins page is written to `~/.dsh/profiles/desktop/cordis.patch.yml`.
Uninstall from the same page.

Mounting the package by relative path (`~/.dsh/profiles/desktop/plugins/…` plus a manual
`insert` in the profile patch) still works but is the fallback path, not the managed one.

Full walkthrough, configuration table, and troubleshooting: [install.md](install.md)
(Chinese).

---

## How it works

```
official pricing page ──fetch (ETag)──► parse.js ──► layer ──► core.js ──► /price-peak/state ──► panel
                                            │                     ▲
                                            └── on failure keep    └── snapshot.js fallback
                                                the previous one
```

- The **host half** fetches, caches, and classifies, then serves `GET /price-peak/state`.
  The pricing page sends no CORS header, so the browser cannot fetch it directly.
- The **browser half** polls that same-origin route once a second and renders the dock
  entry. It holds no pricing or schedule logic, so there is exactly one implementation.
- `?refresh=1` forces a refresh, rate-limited to once a minute.

**No credentials are involved.** The only hosts contacted are
`api-docs.deepseek.com` (host half, fixed user-agent) and the local route from the
browser. Nothing is written to disk, no telemetry, no third parties.

---

## Known limitations

- **Chinese pricing page only.** The English page uses different labels (`MODEL`,
  `PRICING`, `Beijing time`) and quotes USD, so the extractor returns nothing for it and
  the code no longer tries.
- **The statutory holiday table covers 2026 only, and it cannot self-correct.** Once the
  year turns, a statutory holiday falling on a weekday is reported as a peak weekday —
  2027-01-01 is a Friday and a holiday, and would be priced at ×2. No fetch can fix this:
  the page publishes the rule, never the dates. So the panel warns that the current date
  is outside the table's coverage, the reading is marked stale, and you supply the year's
  dates through `customHolidayRuns` (which takes a `year`) or `holidays`. 2026's table
  (33 statutory days, 6 调休 workdays) comes from
  [国办发明电〔2025〕7号](https://www.gov.cn/zhengce/content/202511/content_7047090.htm).
- **Leap days follow the real calendar.** `2028-02-29` is accepted; `2027-02-29` and
  `2026-02-29` are rejected. A run that overruns a short month stops at that month's last
  day rather than spilling into the next.
- **A page redesign will break the extractor and the tests will not notice.** The test
  fixture is a frozen snapshot with no CI to re-capture it. The earliest warning is the
  panel's own source line turning into "bundled snapshot" or "code default".

## Development

```bash
npm run verify        # build consistency + all 87 tests — run before committing
npm run probe:setup   # links the app's node_modules so lib/index.js is importable
node build.mjs        # regenerate lib/client.js after editing src/
node preview-ui.mjs --open   # visual preview of the dock, 7 scenarios
```

`lib/client.js` is committed on purpose: a clone has to be installable as-is.
`build.mjs --check` fails when the artifact and `src/` disagree. See the Chinese README
for the design constraints that came out of real bugs (Cordis `apply`/`inject` shape, no
`styles` service, width fallbacks, fixed UTC+8, 调休 handling).

## License

MIT — see [LICENSE](LICENSE). The pricing page captured in `test/fixtures/` is DeepSeek's
content, included as a test fixture only; see [NOTICE](NOTICE). Not affiliated with or
endorsed by DeepSeek.
