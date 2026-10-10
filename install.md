# 安装 dsh-price-peak

在输入框上方显示 DeepSeek 当前的**价格倍率**（高峰 ×2 / 空闲 ×1）、**北京时间**，
以及距离下次切换的倒计时。价格与峰谷规则由宿主半区从官方定价页定时刷新。

改动只落在你的 profile 目录里，不动 App 本体（`/Applications/DeepSeek Harness.app`），
所以 App 升级不会覆盖它。

---

## 前置检查

先在插件目录里把测试和构建跑一遍。装上再排查要慢得多：

先用 git 取一份代码（下面的命令都在仓库根目录里执行）：

```bash
git clone https://github.com/Noob-in-training/dsh-price-peak
cd dsh-price-peak
```

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
# 如果你已经有本地副本，把下面这行换成你的路径
cd dsh-price-peak
"$NODE" --test test/core.test.mjs test/parse.test.mjs test/host.test.mjs test/client-bundle.test.mjs
"$NODE" build.mjs --check     # lib/client.js 是否与 src/ 同步
"$NODE" preview.mjs --fetch   # 联网抓一次官方页面，打印当前状态
```

三项都应通过。`preview.mjs --fetch` 的输出里，`数据来源` 应该是
`https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`。

> 第 2 项在**刚克隆下来时就应该通过**：仓库里入库的 `lib/client.js` 与 `src/` 是同步的，
> 所以不需要先构建。它失败只有一种情况 —— 你改过 `src/` 却没重新构建，此时运行
> `node build.mjs` 即可。`npm run verify` 会把这一检查和全部测试一起跑。

---

## 安装

本包声明了组合包（`package.json` → `dsh.bundle.patch` → `./cordis.patch.yml`），
所以用 DeepSeek Harness **自带的插件管理**来装：不复制文件、不手工编辑 profile 的
`cordis.patch.yml`。启停、配置、卸载都在同一个页面里，App 升级也不会覆盖。

### 方式 A：插件页 / `plugin_manager`（推荐）

1. 侧栏 **插件** → **添加插件**。
2. 填入下面之一，然后 **安装**：
   - `github:Noob-in-training/dsh-price-peak` —— 组合包版本的仓库推到 GitHub 后用这个；
   - `/Users/<你>/…/dsh-price-peak` —— 本地克隆的**绝对路径**（官方支持的 spec 形式）。
3. 装完点 **立即启用**。profile 启用了 HMR 时**就地生效，不用重启**：宿主的
   `include:price-peak` 行转为 `active`，浏览器半区同时把 `price-peak` 注册进
   `conversation.input.dock`，输入框上方那条信息条直接出现。
4. 若信息条没出现，先刷新页面；仍然没有就重启 App（未启用 HMR 的 profile
   只在启动时应用 patch）。

Agent 会话里等价的动作是 `plugin_manager` 工具的 `install_bundle`（`spec` 同上），
它同样要求 `danger-full-access` 或本次调用的批准。

用 GitHub spec 时，`git ls-remote` 会在 pnpm 之前先探一次仓库连通性；装的是本地路径时
跳过这一步。本包没有 `prepare` 脚本，所以不会触发 pnpm 的构建脚本拦截。

### 插件到底装在哪

组合包由 profile 的 pnpm 项目持有，位置都在这几个地方 —— 排查时按这个顺序看：

| 路径 | 是什么 |
|---|---|
| `~/.dsh/profiles/desktop/node_modules/dsh-price-peak/` | 包装在这里（pnpm 装的依赖） |
| `~/.dsh/profiles/desktop/package.json` → `dsh.profile.bundles` | 选中了哪些组合包 |
| `<包内>/cordis.patch.yml` | 本包声明自己那一行（组合包层） |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | profile 自己的 patch 层：插件页把你改的行开关/配置写在这里 |
| `~/.dsh/profiles/node_modules/` | 各 profile 共享的解析根，App 自带的包在这 |
| `~/.dsh/profiles/desktop/.plugin-manager/logs/` | 每次 pnpm 运行的完整输出 |
| `~/.dsh/profiles/desktop/plugins/` | **不是** DSH 的概念：只有方式 B 手工挂载时才会出现 |

**升级**：卸载再从插件页装一次（安装界面里也写着：装上之后暂不支持自动更新）。
**卸载**：在插件页点卸载 —— 它先取消选择、再跑 `pnpm remove`，profile 里不会留下手写配置。

### 方式 B：手工挂载（组合包机制不可用时）

只有在不能用插件页（例如要挂一份没声明 `dsh.bundle` 的改版）时才走这条。下面命令写
`~/.dsh/`，超出会话的工作区写权限，需要在授权提示里批准（或改成本机终端执行）。

```bash
PROFILE=~/.dsh/profiles/desktop
SRC=/绝对路径/dsh-price-peak
TARGET="$PROFILE/plugins/dsh-price-peak"

mkdir -p "$PROFILE/plugins"
# Remove first, then copy. Plain `cp -R` onto an existing install nests the source
# inside itself (`dsh-price-peak/src/index.js`) and leaves the old files behind, so
# a re-install silently mixes two versions. Verify the path before deleting.
[ -n "$TARGET" ] && [ "$TARGET" != "/" ] && rm -rf "$TARGET"
cp -R "$SRC" "$TARGET"
```

然后编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在**文件末尾**追加：

```yaml
- insert:
    - id: price-peak
      name: './plugins/dsh-price-peak/index.js'
      config:
        liveUpdate: true
        refreshMinutes: 360
```

`install/cordis.patch.yml` 里有带全部选项注释的完整版本，直接抄也可以。

两种方式**不要同时用**：行 id 都是 `price-peak`，同时存在会得到两个同名行。

最后确认它挂上了；没出现就先刷新页面，再重启 App。

---

## 验证

装好后打开一个会话，输入框上方应出现一条细信息条：

```
×1   北京 02:52 · 国庆节假期 · 全天空闲        距高峰 3天6小时   ● 详情
```

点「详情」展开可以看到：单价表（空闲/高峰两列）、高峰时段、数据来源、上次成功更新时间。

如果没出现，按顺序查：

1. **路由是否活着** —— 在浏览器里打开 `http://127.0.0.1:19387/price-peak/state`
   （端口以你实际启动的为准）。应返回一段 JSON。返回 404 说明插件没加载。
2. **宿主是否报错** —— 看启动它的那个终端窗口，插件加载失败会在那里打印。
3. **客户端 bundle 是否被扫到** —— 需要 `package.json` 里同时有
   `exports["./client"]` 和 `dsh.client.platform === "web"`；本仓库两者都已具备。
4. **行是否挂上** —— 插件页里 `dsh-price-peak` 卡片的 `price-peak` 行应显示为运行中
   （Host fiber 阶段 `active`）。报找不到模块时，先确认 `~/.dsh/profiles/desktop/package.json`
   的 `dependencies` 里有 `dsh-price-peak`，且它出现在 `dsh.profile.bundles` 里；
   方式 B 的 `./plugins/…` 路径是相对 profile 目录解析的，可与包名区分开。

---

## 配置项

改插件页里本包的 `config`（它写的就是 profile 的 `cordis.patch.yml`）。启用 HMR 时
改动即刻生效，否则重启后生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `liveUpdate` | `true` | 是否联网刷新官方定价页。`false` 则只用内置快照。 |
| `refreshMinutes` | `360` | 刷新间隔，5–10080 分钟。 |
| `timeoutMs` | `15000` | 单次抓取超时。 |
| `sourceUrl` | `''` | 填了则**只用**这一个地址（严格覆盖），失败就是失败。留空则用官方中文页。 |
| `holidays` | `[]` | 额外法定节假日 `YYYY-MM-DD`，**替换**内置 2026 年表。 |
| `customHolidayRuns` | `[]` | 额外假期区间 `{ month, from, to, name }`，同样替换内置表。 |
| `treatAdjustedWorkdaysAsPeak` | `true` | 调休上班日是否算高峰。 |
| `peakMultiplier` | `0` | 覆盖倍率；0 表示采用页面上的数值。 |
| `model` | `''` | 详情面板按哪个模型计价；留空用第一行。 |

### 宿主行为测试需要一次 `probe:setup`

`test/host.test.mjs` 里有 4 个测试会真正调用 `apply` 并读取路由响应 —— 这是唯一覆盖
「配置 → 抓取 → 状态文档」整条链路的测试。但 `lib/index.js` 依赖 `@deepseek-ai/schemastery`
（App 的 peer 依赖，不是本插件的依赖），ESM 只能从**导入方所在目录向上**解析，所以直接从
仓库里 import 会失败。跑一次：

```bash
npm run probe:setup   # 建立指向 App node_modules 的软链
```

**没跑这一步时，那 4 个测试会静默跳过并仍然显示 ✔** —— 全新克隆 `npm test` 是 77/77，
但耗时只有几十毫秒而不是二十秒，因为探测根本没执行。这是已知的信任缺口，不是通过。

### 上游页面改版了怎么办

`test/fixtures/pricing-zh-cn.html` 是**冻结**的页面快照，不会自己更新。上游改版后：

1. 重新抓取：`curl -sS https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ -o test/fixtures/pricing-zh-cn.html`
2. 跑 `npm test` —— 解析器测试现在会按新页面判定，失败处就是需要改的提取逻辑
3. 改 `lib/parse.js` 让测试通过，必要时更新 `lib/snapshot.js` 里的兜底价格

没有 CI 会自动做这件事，所以**面板上的来源标注是最早的预警**：它变成「内置快照」
或「代码默认」就说明解析器已经跟不上页面了。

### 关于 `treatAdjustedWorkdaysAsPeak`

官方规则只写了「不含中国法定节假日」。调休上班日（例如 2026-02-14 这个周六）
**不是**法定节假日，所以按字面规则它仍然是高峰。默认 `true` 遵循这个读法；
如果你认为 DeepSeek 实际按普通周末计费，改成 `false` 即可。

---

## 数据怎么更新

```
官方定价页 ──fetch(ETag)──► parse.js ──► 覆盖 ──► core.js ──► /price-peak/state ──► 面板
                                │                    ▲
                                └── 失败则保留上一次    └── 内置快照 snapshot.js 兜底
```

- 价格表、高峰时段、倍率、规则文字**都从页面解析**，页面变了就会跟着变，无需改代码。
- 抓取带 `ETag` / `If-Modified-Since`，页面没变时只花一个 304。
- 抓取或解析失败**不会**让面板消失：保留上一次成功的结果，并把信息条上的圆点标成
  黄色，详情里写明失败原因。
- `?refresh=1` 可以强制刷新，但有 60 秒下限，避免刷新页面变成对文档站的请求风暴。

### 唯一需要人工跟进的表：法定节假日日期

定价页公布了规则，但**不公布**节假日日期（国务院每年单独发通知）。所以内置了
2026 年的 33 天法定节假日和 6 个调休上班日，来源是
[国办发明电〔2025〕7号](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)。

国务院公布 2027 年安排后，两种更新方式，无需改代码：

- 在 `holidays` 里列出该年的所有法定节假日日期；
- 或在 `customHolidayRuns` 里按区间写。

两者都会替换内置表。调休上班日表目前是常量，需要更新时改
`lib/core.js` 里的 `ADJUSTED_WORKDAYS_2026`。

---

## 卸载

方式 A：插件页里点该组合包的**卸载** —— 取消选择、跑 `pnpm remove`，配置随包一起走。

方式 B（手工挂载）才需要手工清理：

```bash
rm -rf ~/.dsh/profiles/desktop/plugins/dsh-price-peak
```

再从 `cordis.patch.yml` 里删掉那个 `insert` 块，重启即可。插件不写任何其他位置。

---

## 已知限制

- **节假日日期需要人工跟进**（见上）。规则文本里若出现「法定节假日」，插件无法自行
  得知具体日期。
- **官方页面改版可能让解析失败。** 解析器读的是渲染后的表格文本而不是样式，
  所以换样式不会影响；但如果表格结构重排，`parse.js` 需要跟着更新。
  `test/parse.test.mjs` 用的是真实抓取的页面快照，一旦解析不出来就会失败——
  **注意**：夹具是冻结的快照，不会自动感知上游改版；需要你重新抓取才会重新有效。
- **部分解析失败会按字段降级**，界面会标明每个字段的来源；若显示「代码默认」，
  说明峰谷时段没能从页面确认，官方调整后不会自动跟上。见 README「部分解析失败时会发生什么」。
- **只支持中文定价页。** 英文页标签不同，解析器返回空，所以它不是兜底来源。
- 面板每秒轮询一次本地路由。数据量 < 4 KiB 且有测试守着，但如果你在意后台开销，
  可以把 `POLL_MS` 调大后重新 `node build.mjs`。
