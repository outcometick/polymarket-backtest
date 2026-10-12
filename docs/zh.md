<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# outcometick 回测 · Python

**用普通 Python 写的 Polymarket 逐笔回测引擎。** 任意二元市场——选举、体育、加密货币，只要是两个结果的市场——用你自己录下的盘口数据
（Polymarket 原生的 CLOB 帧，或表格）就能回测；也可以先用一天免费的真实归档上手。策略按盘口逐个事件重放，按当时挂着的深度逐档成交，
每个市场只在有结果凭据时以 1 美元 / 0 美元结算，每笔成交都扣平台的吃单手续费。在自己电脑上、在 notebook 里就能跑，不依赖其它包。
做市策略可以挂限价单：排队模型按 Polymarket 实际的撮合记录方式建立，报告给出成交后的价格走势，看这些成交值不值。

[English](index.md) · **简体中文** · [文档站](https://outcometick.github.io/polymarket-backtest/)（英文） · [给 AI agent 的说明](https://outcometick.github.io/polymarket-backtest/agents.html)（英文） · [方法说明](methodology.md)（英文） · [我们怎么验证](verification.md)（英文） ·
JavaScript / TypeScript 版：[polymarket-backtest-js](https://github.com/outcometick/polymarket-backtest-js)

> 开源（MIT），由 [outcometick.com](https://outcometick.com/zh) 维护。它另外提供现成的 Polymarket 与 Predict.fun 加密涨跌市场逐笔归档，
> 以及在它机器上跑同一个策略的[托管回测](https://outcometick.com/zh/backtest)——这两样都不是必需的。[详见下文。](#outcometickcom-上还有什么)

```bash
pip install outcometick        # Python 3.10+，不需要别的
```

```python
from outcometick import Strategy, Order
from outcometick.backtest import run, load_sample


class Favourite(Strategy):
    """最后一分钟买热门一侧，前提是它还没被定价成必赢。"""

    def on_market_open(self, ctx, market):
        self.close, self.done = market.close_ts_ms, False

    def on_tick(self, ctx, tick):
        if self.done or self.close - ctx.now > 60_000:
            return None
        book = ctx.book()
        up, down = book.best("UP"), book.best("DOWN")
        if up is None or down is None:
            return None
        self.done = True
        side, price = ("UP", up) if up >= down else ("DOWN", down)
        if not 0.55 <= price <= 0.95:
            return None
        return Order(side=side, notional=50, limit=0.95)


result = run(Favourite, load_sample())   # 一天真实归档，只下载一次，不需要 key
print(result.summary())
result.plot()                            # 需要 matplotlib
result.trades_df()                       # 全部成交（需要 pandas）
```

上面跑的是一天免费归档，不需要你自己的数据。想在自己录下的市场上跑同一个类（任意 Polymarket 二元市场），把数据换成你的：

```python
from outcometick.backtest import run, Dataset

result = run(Favourite, "my-polymarket-data")                      # 你录下的 markets.json + CLOB 帧
result = run(Favourite, Dataset.from_frames(gamma_markets, frames))   # 或者直接从内存传入
```

格式和结算规则见下文[用你自己的数据](#用你自己的数据任意-polymarket-二元市场)。

解码一天的数据会用满所有 CPU 核，结果与单进程逐字节相同。传 `workers=8`（或你的核数），各市场也会并行回放——逐笔成交、合计、日志都不变，
前提是策略把状态放在实例上，这本来就是 market 模式的契约（如果检测到状态放在类上或参数里，会改用单进程回放）。在 8 核笔记本上，
免费样本日（289 个市场、761 万个事件）用 `workers=8` 第一次跑约 30 秒，之后约 5 秒。解码结果会缓存，之后再跑这一天立刻开始。
[notebooks/quickstart.ipynb](https://github.com/outcometick/polymarket-backtest/blob/main/notebooks/quickstart.ipynb) 是一个带运行结果的完整示例。

## 它做对了什么

**结算按平台规则，不做近似。** 市场只在有结果凭据时兑付 1 美元或 0 美元：用你自己的数据时，凭据是 Gamma 的结算状态、
`market_resolved` 帧或你给出的结果，几处必须一致；用归档里的加密市场时，按该市场实际使用的 Chainlink 结算流上的官方结果——瞬时流、
30 秒 TWAP 或 60 秒 TWAP，用哪条写在市场自己的配置里（`twapLookbackSeconds`），不按日期推。Predict.fun 平局按 50:50 兑付。
读不出结果的市场会被剔除并在报告里列出，绝不靠猜来结算。

**每个市场两本盘口。** UP 和 DOWN 是两个代币，各有自己的买卖档位。买 UP 吃 UP 的卖档，平仓卖进 UP 的买档。
（Predict.fun 每个市场只发布一本盘口，所以它的 DOWN 一侧是 UP 的镜像。）

**按当时挂着的深度逐档成交。** 订单对着那一毫秒重建出的盘口逐档成交，盘口里没有的数量记为未成交，不会按最优价全部成交。
设置 `latency_ms` 后，订单按它实际到达时的盘口成交，限价照样保护它。

**按市场收平台吃单费。** Polymarket 向吃单方收取 `C × rate × p × (1 − p)`，每个市场的费率表都在归档里，每一笔模拟成交都会扣。
报告写明用了哪种手续费模型、有多少个市场读不到费率表。有一点是估算，报告里也写明了：平台按每笔撮合的挂单分别取整，
归档里只有档位，所以这里按吃掉的每个档位计算并取整。

**挂单按平台真实的撮合方式排队。** `Order(..., tif="gtc")` 按限价挂着，排在该价位已可见的量后面。排队模型建立在对归档的三条实测事实上，
而不是套用一个通用交易所：盘口是**镜像**的（UP 在 q 的买单和 DOWN 在 1 − q 的卖单是同一个队列，只是发布了两次）；每笔成交
**只打印一次、而且打在吃单方的代币上**（所以 DOWN 的买家吃掉挂着的 UP 买单——也就是铸造撮合——同样会推进 UP 买单的排队；只看单个代币的模型会漏掉大约一半的消耗）；
成交记录可能**晚于**它引起的盘口变化到达。所以一笔成交只有价格触达挂单时才能让它成交，而且先从同一份量里扣掉成交前不久被盘口移除的量
（按那部分量原来的价位扣）；新挂单在一个很短的滞后窗口内忽略所有成交，撤单后在这个窗口内仍会暴露。下单延迟和撤单延迟分开设置
（`latency_ms`、`cancel_latency_ms`），挂单成交不收手续费（不计返佣），两个引擎逐笔一致。报告加上做市最看重的指标：成交率、入队时和成交时的
前方排队量、排队时长，以及每笔成交后 1 秒 / 10 秒 / 60 秒和到结算的价格走势——逆向选择有多严重，直接看数字。

**会承认自己过拟合的参数扫描。** `sweep(Strategy, data, {"enter_at_s": [30, 60, 120], "px_max": [0.9, 0.95]}, holdout=0.3)`
跑遍所有组合，用前面的日子给它们排名，再把排名靠前的组合放到从没参与排名的后几天上重放，并排对照。网格搜索总能找到一个「最优」，
样本外那一栏才告诉你它找到的是真优势还是噪声。`.table()` 给出 DataFrame，`.heatmap(x, y)` 画热力图。
`cell_workers=8` 让 8 个组合在不同进程上同时跑，结果与逐个跑逐字节相同（样本日 16 个组合：逐个跑 377 秒，8 核 77 秒）。

**结构上就看不到未来。** 事件一条一条地交给策略，当天剩下的数据不在内存里；市场的 `outcome` 在 `on_settle` 之前不可见。
session 模式下，时间上重叠的市场按同一条时间线交错重放，跨市场保留的状态不会跑到时钟前面去。

**和托管回测用同一个引擎。** 这里的重放引擎和我们沙箱跑 Python 策略的引擎是同一份文件；归档解码和报告从命令行与托管队列使用的
JavaScript 版本移植而来，在公开样本和专门构造的边界归档上逐事件、逐笔对照过。详见[我们怎么验证](verification.md)。

**为二元市场设计的报告。** Brier 分数、按入场价分桶的校准、每份合约的边际、峰值占用资金、滑点面板，以及同样下单规模的朴素基准：
一直买 UP、一直买 DOWN、开盘时一直买热门。如果策略连「买热门」都跑不赢，报告第一页就会告诉你。

**对数据坦白。** 盘口由按固定节奏采集的快照和增量重建；不抽稀的最优买卖价流只能删掉已被越过的档位，不能凭空添加。
每个没能重放的市场日都会列出原因。细节见[方法说明](methodology.md)。

**普通的类。** 没有特殊写法、不需要编译：`on_market_open`、`on_tick`、`on_book`、`on_trade`、`on_settle`，返回 `Order` 或什么都不返回。
同一个类在这里和托管沙箱里都能跑。

## 接口

```python
run(StrategyClass, data,              # data：load_sample("polymarket" | "predict") 或一个归档目录
    assets=["BTC"],                   # 默认 BTC、ETH、SOL、XRP
    days=["2026-09-08"],              # 默认归档里的所有日期
    intervals=["5m", "15m"],          # 默认 ["5m"]
    datasets=["settlement", "book", "trades", "bbo"],
    mode="market",                    # 或 "session"：整个区间一个实例、一条时间线
    latency_ms=250,                   # 下单到成交的延迟（挂单到达平台也用它）
    cancel_latency_ms=None,           # ctx.cancel() 到达平台的延迟；None：同 latency_ms
    fee_bps=None,                     # None：按每个市场的平台费率；数字：统一费率覆盖
    params={"enter_at_s": 60},        # 在策略里用 ctx.p 读
    workers=None)                     # None：解码用满所有核、回放单进程；N：解码和回放都用 N 个进程

run_template("path/to/strategy-dir", data)   # 含 outcometick.json 的策略目录，和 `ot run` 一样

fingerprint("path/to/strategy-dir", assets=["BTC"], days=days)
                                             # 预注册：跑之前先公布这个 sha256

sweep(StrategyClass, data, {"enter_at_s": [30, 60, 120]},  # 每个组合都是一次普通的 run
      metric="net_pnl", holdout=0.3, top=3,               # 用前 70% 的日子排名，前 3 名在剩下的日子上重放
      cell_workers=None)                                  # N：同时跑 N 个组合，结果不变
```

`Result` 有 `.report`（和托管回测返回的是同一份 JSON）、`.trades`、`.fills`、`.markets`（回放过的每个市场，
入场与否都有一行）、`.logs`、`.summary()`、`.plot()`、`.trades_df()`、`.fills_df()`、`.markets_df()`。
`report["fingerprint"]` 就是跑之前 `fingerprint()` 算出的那个 sha256（Methodology §7）。这些调用在你的 Python 进程里运行策略；
需要完全隔离的复现请用 `ot run` 或托管回测。

挂一张单，以及用来评判它的数字：

```python
class Quote(Strategy):
    def on_book(self, ctx, ev):
        bid = ctx.book().best_bid("UP")
        if bid is None or ctx.orders():          # 同一时间只挂一张
            return None
        return Order(side="UP", size=20, limit=bid, tif="gtc", post_only=True, client_id="q")


result = run(Quote, load_sample(), datasets=["settlement", "book", "trades"], latency_ms=150)
result.report["maker"]     # 成交率、入队/成交时前方排队量、1s / 10s / 60s / 结算的价格走势
```

`ctx.orders()` 列出你还在挂的单（不提供排队位置——真实平台也不会告诉你）；`ctx.cancel(id)` 按 id 或 `client_id` 撤单。
[examples/maker_quotes.py](https://github.com/outcometick/polymarket-backtest/blob/main/examples/maker_quotes.py) 是双边报价的完整例子。

## 用你自己的数据：任意 Polymarket 二元市场

归档里只有加密货币涨跌市场。其他市场（选举、体育、任何两个结果的市场）可以自带数据，用同一个引擎、同样的成交、
手续费和报告来回测。

```python
from outcometick.backtest import run, Dataset

# 目录：顶层放 markets.json（或 .jsonl），下面任意位置放 *.jsonl / *.jsonl.gz 的 CLOB 行情帧。
result = run(MyStrategy, "my-polymarket-data")

# 内存里：Gamma 市场对象（或 {market_id, token_ids, labels, ...}）加上你录下的帧。
result = run(MyStrategy, Dataset.from_frames(gamma_markets, frames))

# 单盘口表格形态（带 bid_prices/ask_prices/pc_price... 的 l2 行，加一张成交表）：
result = run(MyStrategy, Dataset.from_pmdata(l2, trades, market=gamma_market))
```

- **行情帧**就是 Polymarket 自己的：`book`、`price_change`、`best_bid_ask`、`last_trade_price`、`market_resolved`，
  原样或放在 `payload` 下（归档的行格式）。按 condition id、slug 或 token id 对应到市场，帧里带的每个标识都必须一致。
- **下单可以写结果名**：`Order(side="Yes", ...)` 或 `"Lakers"`，市场的任一标签；UP/DOWN 对应第 0/1 个结果。
  写了市场没有的标签，回测直接停止。
- **只凭证据结算。** Gamma 显示已结算（`umaResolutionStatus` 且 `outcomePrices` 恰为 1/0、0/1 或 0.5/0.5）、
  `market_resolved` 帧给出赢家、或你提供 `resolution: {outcome, resolved_ts_ms}`，且所有来源一致，才按 $1/$0（或
  各半）兑付。结果公开的前一毫秒停止交易，之后的行情不会到达策略，兑付记在那个时刻。
- **未结算的市场按估值，不猜结果。** 交易结束时，未平仓位按外部行情的中间价估值（UP 盘口，否则 DOWN 盘口的镜像，
  否则最后一笔公开成交），只用市场数据计算，你自己的订单改变不了它。`mark_max_age_ms` 拒绝过旧的报价；没有可用
  估值的仓位按 0 计。报告把 `realised_pnl` 与 `marked_pnl` 分开，并注明这是估值，不是可成交的退出。
- **严格。** 读不出的盘口行、或指向别的市场 token 的行，会让整个市场不参与回放（残缺的盘口会在已经不存在的价格上
  成交），报告里列出原因。

## 执行选项

默认全部关闭，`run(...)` 的参数与清单字段同名：`fok=True`（全成或全撤）、`order_rules="assumed"`（归档：价格网格 0.001、
最少 5 股、数量以 0.01 股为单位）或 `"venue"`（你自己的数据）、`maker_rebate=0.2`（挂单返佣估算）、
`quote_guard={"max_age_ms": 1500, "ask_sum": [0.92, 1.08]}`、`mirror_depth="shared"`（单盘口市场），以及只在本地的
`book_throttle=False`（不抽稀地回放归档盘口，报告写明实际用的抽稀档位）。细节见
[Methodology §10](methodology.md#10-execution-options)。

定义 `on_timer` 并用 `ctx.schedule(at_ms, tag)`，或设 `feed_latency=50`，同一次运行的所有市场走同一条时间线：定时器在指定时刻唤醒策略，
行情延迟让策略晚这么久才收到事件，而订单仍按平台盘口撮合（[§11](methodology.md#11-timers-and-feed-latency-one-time-line)）。
挂单可以用 `queue_model={"prob": "power", "n": 2}`（或 `power2`、`power3`、`log`、`log2`）估计无成交解释的档位减量中有多少发生在你前面，
这是估计，请与默认的保守排队对比（[§12](methodology.md#12-probabilistic-queue-models-optional)）。
`record_ms=60000` 按时间网格记录账户价值（未平仓按最优买价估值）与回撤，见 `Result.record`（[§13](methodology.md#13-the-recorder-mark-to-market-on-a-time-grid)）。
`datasets` 里加上 `"spot"` 后可用 `ctx.spot()` 和 `ctx.twap_locked()`：结算 TWAP 已经过去多少、处在什么水平——这是用 Chainlink 逐秒流算的近似值，误差实测见
[§14](methodology.md#14-spot-and-the-locked-part-of-the-settlement-twap-optional)。

## 限制

- 挂单：排队位置是从聚合档位估算的（数据里没有单个挂单），盘口增量按采集频率抽稀，你的订单不产生市场冲击。挂单只支持 Polymarket：
  Predict.fun 的归档没有成交流，无法推进排队，所以那里拒绝 `gtc`。独立核对器目前还不重算挂单成交。
- 归档里只有 5 分钟和 15 分钟的加密货币涨跌市场。其他 Polymarket 二元市场用你自己的数据回测（见上文）；托管回测只跑归档数据。
- 币安参考价流在托管机器上，不在归档里，读它的策略要在托管回测里跑。自带的 CSV 序列（`series`，用 `ctx.ext()` 读）
  可以用 `ot run` 或托管回测跑；这个运行器暂时不支持，会直接拒绝，而不是丢掉序列照跑。
- 一个样本日说明不了下个月。相信任何数字之前，先在一段时间范围上回测。

## outcometick.com 上还有什么

- **数据本身。** [Polymarket 与 Predict.fun 加密涨跌市场的逐笔归档](https://outcometick.com/zh)：盘口快照与增量、成交、
  最优买卖价、市场元数据，以及市场结算所用的 Chainlink 价格流，按天发布。下载某一天后把目录传给 `run()`，
  或者用 pandas、Polars、DuckDB 直接读。免费样本在 [GitHub](https://github.com/outcometick/polymarket-tick-data-samples)、
  Kaggle 和 Hugging Face 上也有。
- **托管回测。** [outcometick.com/zh/backtest](https://outcometick.com/zh/backtest) 在我们的机器上用最近几周的数据跑同一个策略类，
  什么都不用下载；按扫描的市场日计费，没有产出报告的运行不收费。
- **结算审计。** [逐个市场](https://outcometick.com/zh/polymarket-settlement-audit)用归档的 Chainlink 流重算结算结果，并和平台的结果对比。
- **在 AI 编程工具里用。** npm 包 `outcometick` 带了 MCP 服务（`ot mcp`），Claude Code、Cursor 可以直接查归档、在本地检查策略，
  见[文档](https://outcometick.com/zh/docs)。

## 社区

有问题、想讨论策略或对一对回测结果，欢迎来：

- Discord（中英文分区）：https://discord.gg/ZDMqkptwm5
- Telegram 群：https://t.me/+TcK_hJOzOz5mZTk1

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `outcometick/` | PyPI 包 `outcometick`：SDK、数据客户端（`outcometick.data`）、`outcometick.backtest` |
| `tests/` | 包自带的单元测试，含手算答案 |
| `examples/` | 可运行的策略；`examples/templates/` 是 `ot init` 附带的模板 |
| `notebooks/` | 快速上手 notebook，带运行结果 |
| `verify/` | 把这个包和 JavaScript 实现逐项对照的测试 |
| `docs/` | 方法说明与验证方式 |

由 outcometick 主仓库生成，托管回测用的也是同一个引擎；PyPI 发布在
[outcometick-sdk-python](https://github.com/outcometick/outcometick-sdk-python)。欢迎在这里提 issue 和 PR。

许可证：MIT。
