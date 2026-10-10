<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# outcometick backtest · Python

**Tick-level backtesting for Polymarket and Predict.fun crypto Up/Down markets, in plain Python.** Your
strategy is replayed against the archived order book, settled at $1 / $0 on the Chainlink stream each market
actually settled on, and charged the venue's taker fee — on your laptop, from a notebook, with no other
dependencies. Market makers get resting limit orders with a queue model built on how Polymarket actually
records trading, and the markouts to see whether the fills were worth having.

**English** · [简体中文](README.zh-CN.md) · [Methodology](docs/methodology.md) ·
[How we verify it](docs/verification.md) · JavaScript / TypeScript:
[polymarket-backtest-js](https://github.com/outcometick/polymarket-backtest-js)

> Built by [outcometick.com](https://outcometick.com) — the Polymarket and Predict.fun tick-data archive this
> replays, and a [hosted backtester](https://outcometick.com/backtest) that runs the same strategy on our
> machines. [More below.](#on-outcometickcom)

```bash
pip install outcometick        # Python 3.10+, nothing else
```

```python
from outcometick import Strategy, Order
from outcometick.backtest import run, load_sample


class Favourite(Strategy):
    """Buy the favourite in the last minute, if it is not already priced as a certainty."""

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


result = run(Favourite, load_sample())   # one real archive day, downloaded once, no key
print(result.summary())
result.plot()                            # needs matplotlib
result.trades_df()                       # every trade (needs pandas)
```

The first run over a day decodes it (a few minutes for a busy day); the decoded day is cached, so the next run
over it starts at once. [notebooks/quickstart.ipynb](notebooks/quickstart.ipynb) walks through a full example
with its output.

## What it gets right

**Settlement is the venue's, not an approximation.** A Polymarket crypto market settles on one Chainlink
stream — the instantaneous feed, a 30-second TWAP or a 60-second TWAP — and which one is stated in that
market's own config (`twapLookbackSeconds`), not implied by its date. Every market is replayed against its own
stream and pays $1 or $0 from the official outcome. Predict.fun ties pay 50:50. A market whose stream or outcome
cannot be read is dropped and listed in the report, never settled on a guess.

**Two order books per market.** UP and DOWN are separate tokens with separate bids and asks. Buying UP lifts
UP's asks; getting out sells into UP's bids. (Predict.fun publishes one book per market, so its DOWN side is the
mirror of UP's.)

**Fills walk the depth that was there.** An order is matched against the reconstructed book at that
millisecond, level by level. Size the book did not have is reported as unfilled — it is never filled at the top
of book. With `latency_ms`, the order matches against the book as it stood when it would have arrived, and a
limit still protects it.

**The venue's taker fee, market by market.** Polymarket charges takers `C × rate × p × (1 − p)`; each market's
schedule is in the archive, and every simulated fill pays it. The report states the fee model used and how many
markets had no readable schedule. It is an estimate in one respect, and the report says so: the venue rounds
per maker order matched, the archive keeps book levels, so the fee is computed and rounded per level taken.

**Resting orders, queued the way the venue trades.** `Order(..., tif="gtc")` rests at its limit behind the size
already visible at that price. The queue model is built on three measured facts about the archive, not on a
generic exchange: the book is *mirrored* (an UP bid at q and a DOWN ask at 1 − q are one queue, published twice),
each trade prints *once, on the taker's token* (so a DOWN buyer taking resting UP bids — a mint — advances an UP
bid's queue; a single-token model misses about half of what consumes it), and a print can arrive *after* the book
update it caused. So a print fills a resting order only if its price reaches the order, out of one volume budget
that first pays for depth the book removed just before it, at that depth's own price; a new order ignores prints
for a short lag window, and a cancelled one stays exposed for it. Entry and cancel latency are separate
(`latency_ms`, `cancel_latency_ms`), maker fills pay no fee (rebates are not modelled), and both engines agree
fill for fill. The report adds what a market maker looks at: fill rate, queue position at entry and at fill,
time in queue, and markouts 1s / 10s / 60s after each fill and to settlement — adverse selection, in numbers.

**No look-ahead by construction.** Events reach the strategy one at a time; the rest of the day is not in
memory. A market's `outcome` is hidden until `on_settle`. In session mode, markets that overlap in time are
replayed interleaved in one time order, so state carried across markets never runs ahead of the clock.

**The same engine as the hosted backtester.** The replay engine here is byte for byte the one our sandbox runs
for Python strategies; the archive decoder and the report are ports of the JavaScript ones the command line and
the hosted queue use, checked against them event by event and row by row on the public archive samples and on
synthetic archives built to hold the awkward cases. See [How we verify it](docs/verification.md).

**A report made for binary markets.** Brier score, calibration by entry price, edge per contract, peak capital
at risk, a slippage panel, and naive baselines at the same trade size — always UP, always DOWN, always the
favourite at the opening quote. If a strategy cannot beat buying the favourite, the report says so on page one.

**Honest about the data.** The book is rebuilt from snapshots and deltas captured at a set cadence; the
unthrottled best-bid/ask stream can only remove levels the market has moved past, never add one. Every
market-day that could not be replayed is listed with the reason. [Methodology](docs/methodology.md) has the
details.

**Plain classes.** No special dialect, no compilation step: `on_market_open`, `on_tick`, `on_book`, `on_trade`,
`on_settle`, returning an `Order` or nothing. The same class runs here and in the hosted sandbox.

## The API

```python
run(StrategyClass, data,              # data: load_sample("polymarket" | "predict") or an archive directory
    assets=["BTC"],                   # default BTC, ETH, SOL, XRP
    days=["2026-09-08"],              # default: every day in the archive
    intervals=["5m", "15m"],          # default ["5m"]
    datasets=["settlement", "book", "trades", "bbo"],
    mode="market",                    # or "session": one instance across markets, one clock
    latency_ms=250,                   # decision-to-fill delay (also when a resting order arrives)
    cancel_latency_ms=None,           # ctx.cancel() to venue; None: same as latency_ms
    fee_bps=None,                     # None: each market's venue fee; a number: flat override
    params={"enter_at_s": 60})        # read as ctx.p

run_template("path/to/strategy-dir", data)   # a directory with outcometick.json, like `ot run`
```

`Result` has `.report` (the same JSON the hosted backtester returns), `.trades`, `.fills`, `.logs`,
`.summary()`, `.plot()`, `.trades_df()`, `.fills_df()`.

A resting quote, and the numbers it is judged by:

```python
class Quote(Strategy):
    def on_book(self, ctx, ev):
        bid = ctx.book().best_bid("UP")
        if bid is None or ctx.orders():          # one working quote at a time
            return None
        return Order(side="UP", size=20, limit=bid, tif="gtc", post_only=True, client_id="q")


result = run(Quote, load_sample(), datasets=["settlement", "book", "trades"], latency_ms=150)
result.report["maker"]     # fill rate, queue ahead at join / at fill, markouts 1s / 10s / 60s / settle
```

`ctx.orders()` lists your working orders (no queue position — a venue does not tell you that); `ctx.cancel(id)`
cancels one by its id or `client_id`. [examples/maker_quotes.py](examples/maker_quotes.py) quotes both sides.

## How a run works

```
  archive (gzip JSONL / CSV, as published)
      │  decode: markets → each market's settlement stream, book, deltas, trades;
      │  the book stream thinned to one cadence per asset; same-millisecond order fixed
      ▼
  one event stream per market (session mode: one stream across markets, by time)
      │  pulled one event at a time
      ▼
  engine: order book (UP + DOWN) ── your strategy's hooks ── orders (IOC or resting, latency, limit)
      │  taker fills walk the depth · resting orders queue on both tokens' prints
      │  venue taker fee · settlement $1 / $0 at the official outcome
      ▼
  report: PnL, Brier, calibration, baselines, slippage, maker metrics, fee model, coverage
```

## Limits

- Resting orders: queue position is an estimate from aggregated book levels (individual maker orders are not
  in the feed), book deltas are thinned to a capture cadence, and your orders have no market impact. They run
  on Polymarket only: the Predict.fun archive has no trade stream to advance a queue, so `gtc` is refused there.
  The independent auditor does not yet re-derive resting-order fills.
- 5-minute and 15-minute crypto Up/Down markets, the ones the archive holds.
- The Binance reference feed lives on the hosted runner, not in the archive, so strategies that read it run
  there. Your own CSV series (`series`, read with `ctx.ext()`) run with `ot run` and hosted; this runner refuses
  them for now rather than replaying without them.
- One sample day says nothing about next month. Backtest over a range before trusting any number.

## On outcometick.com

- **The data behind it.** A [tick-level archive of Polymarket and Predict.fun](https://outcometick.com) crypto
  Up/Down markets: order-book snapshots and deltas, trades, best bid/ask, market metadata, and the Chainlink
  streams the markets settle on, published daily. Download a day and point `run()` at it, or read the files with
  pandas, Polars or DuckDB. The free sample is also on [GitHub](https://github.com/outcometick/polymarket-tick-data-samples),
  Kaggle and Hugging Face.
- **The hosted backtester.** [outcometick.com/backtest](https://outcometick.com/backtest) runs the same strategy
  class over recent weeks on our machines, with nothing to download — paid per market-day scanned, and a run that
  produces no report costs nothing.
- **Settlement audit.** [Market by market](https://outcometick.com/polymarket-settlement-audit), the outcome
  recomputed from the archived Chainlink stream and compared with the venue's.
- **From an AI coding tool.** The npm package `outcometick` includes an MCP server (`ot mcp`) so Claude Code or
  Cursor can search the archive and check a strategy locally — see [the docs](https://outcometick.com/docs).
- 中文站：[outcometick.com/zh](https://outcometick.com/zh)

## This repository

| path | what |
| --- | --- |
| `outcometick/` | the `outcometick` PyPI package: SDK, data client (`outcometick.data`), `outcometick.backtest` |
| `tests/` | the package's unit tests, including answers worked by hand |
| `examples/` | runnable strategies; `examples/templates/` holds the templates `ot init` ships |
| `notebooks/` | the quick start as a notebook, with its output |
| `verify/` | the tests that compare this package with the JavaScript implementation |
| `docs/` | methodology and verification |

Generated from the outcometick monorepo, where the same engine runs the hosted backtester; the PyPI release
comes from [outcometick-sdk-python](https://github.com/outcometick/outcometick-sdk-python). Issues and pull
requests are welcome here.

License: MIT.
