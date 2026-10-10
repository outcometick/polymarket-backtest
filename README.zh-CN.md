<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# outcometick 回测

**面向 Polymarket 与 Predict.fun 加密货币涨跌市场的逐笔回测。** 策略按归档的真实盘口重放，按每个市场实际使用的
Chainlink 结算流以 1 美元 / 0 美元结算，并扣除平台的吃单手续费。用 Python 或 JavaScript 写，在自己电脑上跑，
或者交给[托管回测](https://outcometick.com/zh/backtest)。两边用的是同一个引擎、同一套规则，对比各份实现的测试就在这个仓库里。

[English](README.md) · [方法说明](docs/methodology.md)（英文） · [我们怎么验证](docs/verification.md)（英文） ·
[SDK 文档](https://outcometick.com/zh/docs/sdk)

```bash
pip install outcometick        # Python 3.10+，不依赖其它包
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
```

JavaScript 用 `ot` 命令行（Node 24）：

```bash
npm i -g outcometick
ot init my-strategy --template favourite-near-close --lang nodejs
curl -L https://github.com/outcometick/polymarket-tick-data-samples/releases/latest/download/polymarket-data-samples.tar.gz | tar xz
ot run my-strategy --data ./polymarket-data-samples
```

## 它做对了什么

**结算按平台规则，不做近似。** Polymarket 的加密市场在一条 Chainlink 流上结算：瞬时流、30 秒 TWAP 或 60 秒
TWAP，用哪条写在市场自己的配置里（`twapLookbackSeconds`），不按日期推。每个市场都对着自己的结算流重放，按官方结果
兑付 1 美元或 0 美元；Predict.fun 平局按 50:50 兑付。读不出结算流或结果的市场会被剔除并在报告里列出，绝不靠猜来结算。

**每个市场两本盘口。** UP 和 DOWN 是两个代币，各有自己的买卖档位。买 UP 吃 UP 的卖档，平仓卖进 UP 的买档。
（Predict.fun 每个市场只发布一本盘口，所以它的 DOWN 一侧是 UP 的镜像。）

**按当时挂着的深度逐档成交。** 订单对着那一毫秒重建出的盘口逐档成交，盘口里没有的数量记为未成交，不会按最优价全部成交。
设置 `latency_ms` 后，订单按它实际到达时的盘口成交，限价照样保护它。

**按市场收平台吃单费。** Polymarket 向吃单方收取 `C × rate × p × (1 − p)`，每个市场的费率表都在归档里，每一笔模拟成交都会扣。
报告写明用了哪种手续费模型、有多少个市场读不到费率表。有一点是估算，报告里也写明了：平台按每笔撮合的挂单分别取整，
归档里只有档位，所以这里按吃掉的每个档位计算并取整。

**结构上就看不到未来。** 事件一条一条地交给策略，当天剩下的数据不在内存里；市场的 `outcome` 在 `on_settle` 之前不可见。
session 模式下，时间上重叠的市场按同一条时间线交错重放，跨市场保留的状态不会跑到时钟前面去。

**一个引擎，两种语言，本地和托管一致。** Python 和 JavaScript 两个引擎逐笔互相核对；纯 Python 运行器在公开样本和专门构造的
边界归档上，逐事件、逐笔对照命令行的结果，而命令行和托管队列共用同一套解码、引擎和报告代码。详见[我们怎么验证](docs/verification.md)。

**为二元市场设计的报告。** Brier 分数、按入场价分桶的校准、每份合约的边际、峰值占用资金、滑点面板，以及同样下单规模的朴素基准：
一直买 UP、一直买 DOWN、开盘时一直买热门。如果策略连「买热门」都跑不赢，报告第一页就会告诉你。

**对数据坦白。** 盘口由按固定节奏采集的快照和增量重建；不抽稀的最优买卖价流只能删掉已被越过的档位，不能凭空添加。
每个没能重放的市场日都会列出原因。细节见[方法说明](docs/methodology.md)。

**普通的类。** 没有特殊写法、不需要编译：`on_market_open`、`on_tick`、`on_book`、`on_trade`、`on_settle`，返回 `Order` 或什么都不返回。
同一个类在这里和托管沙箱里都能跑。

## 数据

- **免费样本：** 每个平台一天真实归档，`load_sample("polymarket")`、`load_sample("predict")`；GitHub Releases、Kaggle、
  Hugging Face 上也有。
- **完整归档：** [订阅](https://outcometick.com/zh)后可以下载任意一天的同样文件，把解压后的目录传给 `run()` 即可；
  `outcometick.data`（Python）和 `outcometick/data`（Node）可以帮你下载。
- **完全不下载：** [托管回测](https://outcometick.com/zh/backtest)在我们的机器上用最近的数据跑同一个策略，返回报告。

## 限制

- 订单只吃单（IOC）。挂单需要排队位置模型，随便猜一个会把做市收益夸大好几倍，所以宁可拒绝也不近似。保守的排队模型是下一步。
- 只有 5 分钟和 15 分钟的加密货币涨跌市场，也就是归档里有的那些。
- 币安参考价流在托管机器上，不在归档里，读它的策略要在托管回测里跑。自带的 CSV 序列（`series`，用 `ctx.ext()` 读）
  可以用 `ot run` 或托管回测跑；纯 Python 运行器暂时不支持，会直接拒绝，而不是丢掉序列照跑。
- 一个样本日说明不了下个月。相信任何数字之前，先在一段时间范围上回测。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `python/` | PyPI 包 `outcometick`：SDK、数据客户端、`outcometick.backtest`、测试 |
| `typescript/` | npm 包 `outcometick`：SDK、`ot` 命令行、JavaScript 引擎、测试 |
| `examples/` | 两种语言的可运行策略 |
| `notebooks/` | 快速上手 notebook，带运行结果 |
| `docs/` | 方法说明与验证方式 |

由 outcometick 主仓库生成，托管回测用的也是这些引擎；发包在
[outcometick-sdk-python](https://github.com/outcometick/outcometick-sdk-python) 和
[outcometick-sdk-ts](https://github.com/outcometick/outcometick-sdk-ts)。欢迎在这里提 issue 和 PR。

许可证：MIT。
