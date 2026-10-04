# 安装 dsh-price-peak

在输入框上方显示 DeepSeek 当前的**价格倍率**（高峰 ×2 / 空闲 ×1）、**北京时间**，
以及距离下次切换的倒计时。价格与峰谷规则由宿主半区从官方定价页定时刷新。

改动只落在你的 profile 目录里，不动 App 本体（`/Applications/DeepSeek Harness.app`），
所以 App 升级不会覆盖它。

---

## 前置检查

先在插件目录里把测试和构建跑一遍。装上再排查要慢得多：

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
cd ~/Documents/workspace/uoftwork/dsh-custom/dsh-price-peak
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

以下命令会写入 `~/.dsh/`，超出当前会话的工作区写权限，因此需要你在弹出的
授权提示里批准（或改成本机终端执行）。

```bash
PROFILE=~/.dsh/profiles/desktop
SRC=~/Documents/workspace/uoftwork/dsh-custom/dsh-price-peak

mkdir -p "$PROFILE/plugins"
# index.js 是包根入口，lib/ 是宿主与客户端产物，两者都要。
cp -R "$SRC" "$PROFILE/plugins/dsh-price-peak"
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

最后**重启 App**。客户端 bundle 是启动时扫描的，热加载不会把它带进来。

---

## 验证

重启后打开一个会话，输入框上方应出现一条细信息条：

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
4. **相对路径是否解析对了** —— `./plugins/dsh-price-peak/index.js` 是相对 profile
   目录解析的。若 App 报找不到模块，改用绝对路径 `/Users/<你>/.dsh/profiles/desktop/plugins/dsh-price-peak/index.js` 试一次。

---

## 配置项

改 `cordis.patch.yml` 里的 `config` 后重启生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `liveUpdate` | `true` | 是否联网刷新官方定价页。`false` 则只用内置快照。 |
| `refreshMinutes` | `360` | 刷新间隔，5–10080 分钟。 |
| `timeoutMs` | `15000` | 单次抓取超时。 |
| `sourceUrl` | `''` | 填了则**只用**这一个地址（严格覆盖）。留空则依次尝试官方中英文页面。 |
| `holidays` | `[]` | 额外法定节假日 `YYYY-MM-DD`，**替换**内置 2026 年表。 |
| `customHolidayRuns` | `[]` | 额外假期区间 `{ month, from, to, name }`，同样替换内置表。 |
| `treatAdjustedWorkdaysAsPeak` | `true` | 调休上班日是否算高峰。 |
| `peakMultiplier` | `0` | 覆盖倍率；0 表示采用页面上的数值。 |
| `model` | `''` | 详情面板按哪个模型计价；留空用第一行。 |

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
  这正是提醒信号。
- **部分解析失败会按字段降级**，界面会标明每个字段的来源；若显示「代码默认」，
  说明峰谷时段没能从页面确认，官方调整后不会自动跟上。见 README「部分解析失败时会发生什么」。
- **定价页的英文版解析兜底较弱。** 中文页是首选；仅在 `sourceUrl` 留空时才会回退到英文页，
  回退发生时 `data.usedFallbackSource` 为 `true`。
- 面板每秒轮询一次本地路由。数据量 < 4 KiB 且有测试守着，但如果你在意后台开销，
  可以把 `POLL_MS` 调大后重新 `node build.mjs`。
