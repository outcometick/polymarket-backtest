<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# outcometick 回测 · Python

**用普通 Python 对 Polymarket 与 Predict.fun 加密货币涨跌市场做逐笔回测。** 策略按归档的真实盘口重放，按每个市场实际使用的
Chainlink 结算流以 1 美元 / 0 美元结算，并扣除平台的吃单手续费。在自己电脑上、在 notebook 里就能跑，不依赖其它包。
做市策略可以挂限价单：排队模型按 Polymarket 实际的撮合记录方式建立，报告给出成交后的价格走势，看这些成交值不值。

[English](README.md) · **简体中文** · [方法说明](docs/methodology.md)（英文） · [我们怎么验证](docs/verification.md)（英文） ·
JavaScript / TypeScript 版：[polymarket-backtest-js](https://github.com/outcometick/polymarket-backtest-js)

> 出自 [outcometick.com](https://outcometick.com/zh)：这里重放的 Polymarket 与 Predict.fun 逐笔数据归档就来自那里；
> 网站上还有[托管回测](https://outcometick.com/zh/backtest)，在我们的机器上跑同一个策略。[详见下文。](#outcometickcom-上还有什么)

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

第一次跑某一天时要先解码（交易活跃的一天要几分钟），解码结果会缓存，之后再跑这一天立刻开始。
[notebooks/quickstart.ipynb](notebooks/quickstart.ipynb) 是一个带运行结果的完整示例。

## 它做对了什么

**结算按平台规则，不做近似。** Polymarket 的加密市场在一条 Chainlink 流上结算：瞬时流、30 秒 TWAP 或 60 秒 TWAP，用哪条写在
市场自己的配置里（`twapLookbackSeconds`），不按日期推。每个市场都对着自己的结算流重放，按官方结果兑付 1 美元或 0 美元；
Predict.fun 平局按 50:50 兑付。读不出结算流或结果的市场会被剔除并在报告里列出，绝不靠猜来结算。

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

**结构上就看不到未来。** 事件一条一条地交给策略，当天剩下的数据不在内存里；市场的 `outcome` 在 `on_settle` 之前不可见。
session 模式下，时间上重叠的市场按同一条时间线交错重放，跨市场保留的状态不会跑到时钟前面去。

**和托管回测用同一个引擎。** 这里的重放引擎和我们沙箱跑 Python 策略的引擎是同一份文件；归档解码和报告从命令行与托管队列使用的
JavaScript 版本移植而来，在公开样本和专门构造的边界归档上逐事件、逐笔对照过。详见[我们怎么验证](docs/verification.md)。

**为二元市场设计的报告。** Brier 分数、按入场价分桶的校准、每份合约的边际、峰值占用资金、滑点面板，以及同样下单规模的朴素基准：
一直买 UP、一直买 DOWN、开盘时一直买热门。如果策略连「买热门」都跑不赢，报告第一页就会告诉你。

**对数据坦白。** 盘口由按固定节奏采集的快照和增量重建；不抽稀的最优买卖价流只能删掉已被越过的档位，不能凭空添加。
每个没能重放的市场日都会列出原因。细节见[方法说明](docs/methodology.md)。

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
    params={"enter_at_s": 60})        # 在策略里用 ctx.p 读

run_template("path/to/strategy-dir", data)   # 含 outcometick.json 的策略目录，和 `ot run` 一样
```

`Result` 有 `.report`（和托管回测返回的是同一份 JSON）、`.trades`、`.fills`、`.logs`、`.summary()`、`.plot()`、
`.trades_df()`、`.fills_df()`。

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
[examples/maker_quotes.py](examples/maker_quotes.py) 是双边报价的完整例子。

## 限制

- 挂单：排队位置是从聚合档位估算的（数据里没有单个挂单），盘口增量按采集频率抽稀，你的订单不产生市场冲击。挂单只支持 Polymarket：
  Predict.fun 的归档没有成交流，无法推进排队，所以那里拒绝 `gtc`。独立核对器目前还不重算挂单成交。
- 只有 5 分钟和 15 分钟的加密货币涨跌市场，也就是归档里有的那些。
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
