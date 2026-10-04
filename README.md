# dsh-price-peak

在 DeepSeek Harness 的输入框上方显示**当前价格倍率**：高峰时段 ×2，空闲时段 ×1。
同时给出**北京时间**（不管你人在多伦多还是别处）和距离下次切换的倒计时。

价格表与峰谷规则**从官方定价页实时抓取解析**，页面变了就跟着变；
抓不到时退回内置快照，并在界面上标出「可能已过期」，而不是消失。

```
×1   北京 02:52 · 国庆节假期 · 全天空闲      距高峰 3天6小时        ● 详情
```

点「详情」展开单价表（空闲 / 高峰两列）、高峰时段、数据来源与上次更新时间。

---

## 为什么时间是北京时间

峰谷时段是按北京时间定义的，所以显示和判定都固定在 **UTC+8**：

- 所有日历读取都走 `Date.UTC` 加固定 +08:00 偏移，**从不**用本地时区 getter；
- 北京全年无夏令时，不需要处理 DST；
- 有一条测试在 `Asia/Shanghai`、`America/Toronto`、`UTC`、`Pacific/Kiritimati`
  四个时区下对同一时刻断言输出完全一致。

所以在多伦多看到的「北京 02:52」和在上海看到的完全一样。

## 为什么价格能跟着官方变

```
官方定价页 ──fetch(ETag)──► parse.js ──► 覆盖 ──► core.js ──► /price-peak/state ──► 面板
                                │                    ▲
                                └── 失败则保留上一次    └── snapshot.js 兜底
```

- **价格表、高峰时段、倍率、规则文字都从页面解析**，不是写死在代码里。
- 解析器读的是渲染后的**表格文本**而不是样式，所以换配色换布局不影响；
  但表格若重排，`parse.js` 需要更新 —— `test/parse.test.mjs` 用的是真实抓取的
  页面快照，解析不出来就会失败，这就是提醒信号。
- **唯一需要人工跟进的表：法定节假日日期。** 定价页公布了规则（"不含中国法定节假日"）
  但不公布日期，国务院每年单独发通知。内置了 2026 年的 33 天和 6 个调休上班日，
  可通过 `holidays` / `customHolidayRuns` 配置替换，无需改代码。

## 部分解析失败时会发生什么

页面解析是**按字段独立**的：价格表、峰谷时段、倍率分别提取，各自回退。所以可能出现
「价格来自内置快照、峰谷时段来自页面」这种混用状态。**不处理就会静默出错** ——
数据看起来是当前的，实际是两个来源拼的。

因此 `resolvePricing` 为每个字段记录来源（`live` / `snapshot` / `default`），界面据此显示：

```
数据来源   价格：内置快照；峰谷时段：官方定价页；倍率：官方定价页
⚠ 价格表来自内置快照，不是本次抓取的结果。

数据来源   价格：内置快照；峰谷时段：代码默认；倍率：代码默认
⚠ 峰谷时段、倍率无法从页面确认，正在使用内置默认值；官方调整后这里不会自动跟上。
```

第二种状态尤其重要：内置快照**不含**峰谷时段，所以一旦页面注释解析失败，时段就退回代码里的
默认值（9:00-12:00 / 14:00-18:00）。官方若调整时段，这里不会自动跟上 —— 面板必须说清楚，
而不是继续标榜「官方定价页」。

## 一个容易搞错的地方：调休上班日

官方规则只排除**法定节假日**。调休上班日（如 2026-02-14 这个周六）**不是**法定节假日，
所以按字面规则它仍按工作日计峰谷。默认 `treatAdjustedWorkdaysAsPeak: true` 遵循这个读法。

这个坑的连带后果：2026-02-14 这天 18:00 结束高峰后，紧接着是 9 天春节加周末，
**下一次高峰在 10 天后的 02-24 09:00**。倒计时逻辑因此按 14 天视界搜索切换点，
并且时长会显示成「9天14小时」而不是「230小时22分」。

## 目录

```
index.js                  包根入口（profile 按相对路径挂载用）
build.mjs                 把 src/ 包成 lib/client.js
preview.mjs               不装也能看效果；--fetch 联网抓一次
lib/index.js              宿主半区：抓取、缓存、/price-peak/state 路由
lib/core.js               峰谷模型（北京时间、节假日、倍率、切换点）
lib/parse.js              官方定价页解析器
lib/snapshot.js           内置兜底数据
lib/client.js             ← 构建产物（已入库），浏览器实际加载的就是它
src/client.template.js    浏览器半区源码（ESM，可直接 node --check）
src/client-styles.js      样式（构建时内联进 bundle）
test/                     四个测试套件，64 项
test/fixtures/            官方定价页的真实快照，解析器测试用
install.md                安装步骤与排查
install/cordis.patch.yml  带注释的配置模板
```

## 开发说明

### 为什么产物 `lib/client.js` 入库

dsh 启动时加载的是**已构建**的客户端 bundle，所以克隆下来必须能直接装。忽略它会
让每个用 GitHub 的人拿到一个要自己发现构建步骤才不报错的插件。

代价是"生成物可能和源码漂移"。这一点由 `build.mjs --check` 兜住：产物与 `src/`
不一致时它会失败，而它是测试套件的一部分。**提交前跑 `npm run verify`。**

### 为什么构建是"包装"而不是"编译"

浏览器半区是纯 JavaScript，唯一的运行时依赖是 `react`，而它由 shell 作为平台模块
注入。所以 `build.mjs` 只做三件事：读取模板、内联样式表、套上
`window.__ModuleLoader__.load({ id, factory })` 外壳——和官方
`@deepseek-ai/dsh-client-ui-goal` 的产物同一形态。没有 bundler，因此产物可以直接
用眼睛审。

### 改代码时的几个约束（都是真机上踩出来的）

| 约束 | 原因 |
|---|---|
| 客户端 bundle 必须导出 `apply` 和 `inject` | 这是 Cordis 加载器认的插件面；写成 `define` 之类的自定义入口不会被调用 |
| 不要依赖 `styles` 服务 | 250 个已装包里没有任何客户端 bundle 用它；官方做法是把 CSS 内联进 bundle，用 `document.createElement("style")` 并在 `ctx.effect` 的清理函数里移除 |
| 宽度必须自带有效兜底 | `max-width: calc(var(--token) - 32px)` 在变量缺失时**整条声明失效**，元素会铺满整行 |
| 日历只能走固定 UTC+8 | 峰谷按北京时间定义，用本地时区 getter 会让你在多伦多看到错的判定 |
| 调休上班日算工作日 | 官方规则只排除法定节假日 |

### 加功能

- **新数据源**：改 `lib/parse.js`，并往 `test/fixtures/` 放新页面的真实快照。解析器
  测试跑的是真实 HTML，页面改版会让它失败——这就是提醒信号。
- **新界面元素**：改 `src/client.template.js`，然后 `node build.mjs`。
  `node preview-ui.mjs --open` 可以不装就看外观。
- **新配置项**：加到 `lib/index.js` 的 `Config` schema 和 `install/cordis.patch.yml` 注释里。

### 上游维护点

官方定价页改版会让 `lib/parse.js` 失效；测试会先失败，不会静默出错。
法定节假日日期每年需人工更新（见「已知限制」）。

## 常用命令

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
cd ~/Documents/workspace/uoftwork/dsh-custom/dsh-price-peak

npm run verify                    # 构建一致性 + 全部测试（提交前跑这个）
"$NODE" build.mjs                 # 改过 src/ 之后必须重新构建
"$NODE" preview.mjs --fetch       # 联网抓取并打印当前状态（数据预览）
"$NODE" preview.mjs --day 2026-02-14   # 打印某天逐小时的峰谷
"$NODE" preview-ui.mjs --open     # 生成并打开界面预览页（外观预览）
```

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目从 DeepSeek 官方定价页读取数据，与 DeepSeek 官方无关，也未经其背书。


### 两种预览的区别

| | 看什么 | 怎么用 |
|---|---|---|
| `preview.mjs` | **数据与判定**：倍率、峰谷、切换倒计时、节假日分类 | 终端命令；`--fetch` 会真的抓官方页面 |
| `preview-ui.mjs` | **外观**：信息条与详情面板的排版、配色、深色模式 | 生成独立 HTML，浏览器打开；不需要安装 |

界面预览页含 5 个场景：高峰 ×2、空闲 ×1、展开详情、数据过期（圆点转黄）、
接口不可用（×?）。配色与圆角取自已安装的 `@deepseek-ai/dsh-client-ui-theme`，
输入框几何值取自 `dsh-client-ui-conversation`（卡片 `min(calc(100% - 16px), 952px)`、
内缩 8px）。类名映射直接从组件源码抽取 —— 改名会让预览显示异常，而不是悄悄失真。

**这个预览页已经赚回成本了**：它抓出一个真布局 bug —— `.dppDock` 一开始写成
`display:flex`，而 flex 默认 `row`，导致详情面板和信息条**并排**而不是上下堆叠。
对齐参考实现 `dsh-client-ui-goal` 的 `.dock` 后修正。这个 bug 看代码发现不了，
装进 App 才会看见。

## 宽度上的两个陷阱（真机上踩到的）

`.dppBar` / `.dppPanel` 想和输入框卡片同宽，指向 `--dsh-composer-card-max-width`。
这个变量在 conversation body 上的定义是 `calc(var(--dsh-chat-content-width) + 32px)`，
而 content width 是 `clamp(680px, 对话列宽 × 0.64, 920px)`。两条踩过的坑：

1. **`max-width: calc(var(--token) - 32px)` 在变量缺失时整条声明失效**，元素直接铺满
   整行（`max-width: none`）。所以这里不再用 `calc()` 参与，且每个宽度都写了**自身有效**
   的兜底：`var(--dsh-composer-card-max-width, 952px)`。
2. **不要依赖外层列宽的变量。** 槽位渲染在哪里不由本插件决定，一旦变量所在作用域不覆盖
   到你，宽度就失控。兜底值应当是**上限**，而不是指望它会被覆盖。

`.dppDock` 的列宽仍沿用 goal bar 的公式（clearance 与 inset token），但那些 token 也都
加了兜底值。

## 已知限制

- 法定节假日日期需人工跟进（见上）。
- 定价页若大改表格结构，解析器需要更新；测试会先失败。
- 英文页面的解析兜底较弱；中文页是首选。
- 面板每秒轮询一次本地路由（数据 < 4 KiB，有测试守着上限）；介意后台开销的话
  调大 `src/client.template.js` 里的 `POLL_MS` 后重新构建。
